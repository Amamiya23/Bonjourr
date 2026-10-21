import { storage } from '../../storage.ts'
import { canonical, cloudChanges, cloudConflicts, validateCloudState } from '../../shared/cloud.ts'
import type { CloudConnection, CloudState } from '../../shared/cloud.ts'
import {
    activeCloudRecords,
    applyCloudData,
    captureCloudData,
    overlayCloudRecords,
    uploadCloudMedia,
} from './cloud-data.ts'
import { cloudJson, CloudRequestError } from './cloud-api.ts'

let busy = false
let initialized = false
let applying = false
let timer: ReturnType<typeof setTimeout> | undefined
let failures = 0
let retryAt = 0

export function cloudStatus(message: string, state: 'pending' | 'success' | 'error' = 'pending'): void {
    const element = document.getElementById('cloud-status')
    if (element) {
        element.textContent = message
        element.dataset.state = state
    }
    const conflict = document.getElementById('cloud-conflict-actions')
    if (conflict) conflict.hidden = state !== 'error' || !(message.includes('同时修改') || message.includes('清空'))
    const clear = document.getElementById('cloud-confirm-clear')
    if (clear) clear.hidden = !message.includes('清空')
    const resolve = document.getElementById('cloud-resolve')
    if (resolve) resolve.hidden = !message.includes('同时修改')
}

export async function cloudLock(action: () => Promise<void>): Promise<void> {
    if (busy) throw new Error('此设备正在同步，请稍后重试。')
    busy = true
    try {
        if (navigator.locks) {
            await navigator.locks.request('bonjourr-cloud-sync', { ifAvailable: true }, async (lock) => {
                if (!lock) throw new Error('其他标签页正在同步，请稍后重试。')
                await action()
            })
        } else await action()
    } finally {
        busy = false
    }
}

export async function saveCloudConnection(connection: CloudConnection): Promise<void> {
    const local = await storage.local.get(['cloud', 'syncType'])
    const current = local.cloud
    if (local.syncType !== 'cloud' || current?.token !== connection.token || current.url !== connection.url) {
        throw new Error('设备连接已变化，已停止本次同步。')
    }
    await storage.local.set({ cloud: connection })
}

async function sendPending(connection: CloudConnection): Promise<void> {
    const pending = connection.pending
    if (!pending) return
    try {
        validateCloudState(await cloudJson<CloudState>(connection, pending.initialize ? 'initialize' : 'sync', pending))
    } catch (error) {
        if (error instanceof CloudRequestError && error.status === 409) {
            delete connection.pending
            await saveCloudConnection(connection)
        }
        throw error
    }
    const records = new Map(connection.baseline?.records.map((record) => [record.key, record]) ?? [])
    for (const change of pending.changes) {
        records.set(change.key, {
            key: change.key,
            json: change.json,
            deleted: change.deleted,
            revision: change.baseRevision + 1,
        })
    }
    connection.baseline = { initialized: true, records: [...records.values()] }
    delete connection.pending
    await saveCloudConnection(connection)
}

export async function initializeCloud(): Promise<void> {
    await cloudLock(async () => {
        const connection = (await storage.local.get('cloud')).cloud
        if (!connection?.owner) throw new Error('请先登录。')
        const remote = validateCloudState(await cloudJson<CloudState>(connection, 'state'))
        if (remote.initialized) throw new Error('云端已有内容，请采用云端内容后再修改。')
        const current = await captureCloudData()
        await uploadCloudMedia(connection, current)
        connection.baseline = remote
        connection.pending = {
            id: crypto.randomUUID(),
            changes: cloudChanges(remote, current.records),
            initialize: true,
        }
        await saveCloudConnection(connection)
        await sendPending(connection)
        connection.lastSync = new Date().toISOString()
        connection.error = undefined
        await saveCloudConnection(connection)
        cloudStatus('已开启自动同步', 'success')
    })
}

export async function adoptCloud(): Promise<void> {
    await cloudLock(async () => {
        const connection = (await storage.local.get('cloud')).cloud
        if (!connection) throw new Error('请先连接云端。')
        if (connection.pending) throw new Error('还有未确认的上传，请先重试同步。')
        const remote = validateCloudState(await cloudJson<CloudState>(connection, 'state'))
        if (!remote.initialized) throw new Error('云端尚无内容，请先在数据完整的设备上上传。')
        const capture = await captureCloudData()
        applying = true
        try {
            await applyCloudData(connection, remote, capture, async () => {
                if (canonical((await captureCloudData()).records) !== canonical(capture.records)) {
                    throw new Error('下载期间本机有修改，请重试。')
                }
                await saveCloudConnection(connection)
            })
            connection.baseline = remote
            connection.conflicts = undefined
            connection.error = undefined
            connection.lastSync = new Date().toISOString()
            await saveCloudConnection(connection)
        } finally {
            applying = false
        }
        globalThis.location.reload()
    })
}

export async function syncCloudNow(
    options: { resolutions?: Record<string, 'local' | 'remote'>; confirmClear?: boolean } = {},
): Promise<void> {
    await cloudLock(async () => {
        const local = await storage.local.get(['cloud', 'syncType'])
        const connection = local.cloud
        if (local.syncType !== 'cloud' || !connection || navigator.onLine === false) return
        cloudStatus('正在同步…')
        try {
            await sendPending(connection)
            if (!connection.baseline?.initialized) {
                cloudStatus('请选择云端内容，或上传完整的本机内容。')
                return
            }
            const capture = await captureCloudData()
            const changes = cloudChanges(connection.baseline, capture.records)
            const remote = validateCloudState(await cloudJson<CloudState>(connection, 'state'))
            if (!remote.initialized) throw new Error('云端初始化状态异常，已停止上传。')
            const conflicts = cloudConflicts(changes, remote)
            const unresolved = conflicts.filter((key) => !options.resolutions?.[key])
            if (unresolved.length) {
                connection.conflicts = unresolved
                document.dispatchEvent(
                    new CustomEvent('bonjourr-cloud-conflicts', {
                        detail: { keys: unresolved, local: capture.records, remote },
                    }),
                )
                throw new Error(`有 ${unresolved.length} 项在两端同时修改。请选择保留本机或采用云端。`)
            }
            const server = new Map(remote.records.map((record) => [record.key, record]))
            const rebased = changes.filter((change) => options.resolutions?.[change.key] !== 'remote').map((
                change,
            ) => ({
                ...change,
                baseRevision: server.get(change.key)?.revision ?? 0,
            })).filter((change) =>
                (server.get(change.key)?.deleted ?? true) !== change.deleted ||
                (server.get(change.key)?.json ?? null) !== change.json
            )
            if (rebased.length) {
                await uploadCloudMedia(connection, capture)
                connection.pending = { id: crypto.randomUUID(), changes: rebased, confirmClear: options.confirmClear }
                await saveCloudConnection(connection)
                await sendPending(connection)
            }
            const latest = validateCloudState(await cloudJson<CloudState>(connection, 'state'))
            const now = await captureCloudData()
            // Keep edits made while the request was in flight as unsynchronized local changes.
            const during = cloudChanges(overlayCloudRecords(latest, capture.records), now.records)
            const merged = activeCloudRecords(latest)
            for (const change of during) {
                if (change.deleted) delete merged[change.key]
                else merged[change.key] = change.json!
            }
            const reload = canonical(merged) !== canonical(now.records)
            applying = true
            try {
                if (reload) {
                    await applyCloudData(connection, overlayCloudRecords(latest, merged), now, async () => {
                        if (canonical((await captureCloudData()).records) !== canonical(now.records)) {
                            throw new Error('同步期间本机有修改，请重试。')
                        }
                        await saveCloudConnection(connection)
                    })
                }
                connection.baseline = latest
                connection.conflicts = undefined
                connection.error = undefined
                connection.lastSync = new Date().toISOString()
                await saveCloudConnection(connection)
            } finally {
                applying = false
            }
            cloudStatus(`已同步 · ${new Date(connection.lastSync).toLocaleString()}`, 'success')
            if (reload) globalThis.location.reload()
        } catch (error) {
            connection.error = error instanceof Error ? error.message : '同步失败，离线修改仍保留在本机。'
            await saveCloudConnection(connection)
            cloudStatus(connection.error, 'error')
            throw error
        }
    })
}

export function scheduleCloudSync(reset = false): void {
    if (reset) {
        failures = 0
        retryAt = 0
    }
    clearTimeout(timer)
    timer = setTimeout(() => {
        if (applying || busy || document.visibilityState === 'hidden' || Date.now() < retryAt) return
        void syncCloudNow().then(() => {
            failures = 0
            retryAt = 0
        }).catch(() => {
            failures++
            retryAt = Date.now() + Math.min(300000, 10000 * 2 ** Math.min(failures, 5))
        })
    }, 1500)
}

export function initCloudSync(): void {
    if (initialized) return
    initialized = true
    scheduleCloudSync()
    setInterval(() => scheduleCloudSync(), 30000)
    globalThis.addEventListener('focus', () => scheduleCloudSync())
    globalThis.addEventListener('online', () => scheduleCloudSync(true))
    document.addEventListener('visibilitychange', () => scheduleCloudSync())
    globalThis.addEventListener('bonjourr-storage-change', (event) => {
        if (applying) return
        const { area, keys } = (event as CustomEvent<{ area: string; keys: string[] }>).detail
        if (
            area === 'sync' || keys.some((key) =>
                key.startsWith('background') || key.startsWith('x-icon-') ||
                ['weatherApiKey', 'weatherApiOrigin', 'syncType'].includes(key)
            )
        ) scheduleCloudSync()
    })
}
