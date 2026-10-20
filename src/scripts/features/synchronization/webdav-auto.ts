import { storage } from '../../storage.ts'
import { createBackup, webdavFingerprint } from './backup.ts'
import { downloadWebdav, hasStrongWebdavEtag, restoreWebdav, uploadWebdav, WebdavError, webdavFile } from './webdav.ts'
import type { WebdavConfig } from '../../../types/local.ts'

let busy = false
let initialized = false
let timer: ReturnType<typeof setTimeout> | undefined
let retryAt = 0
let failures = 0

export function showWebdavStatus(message: string, state: 'pending' | 'success' | 'error'): void {
    const status = document.getElementById('webdav-status')
    if (!status) return
    status.textContent = message
    status.dataset.state = state
}

// Manual actions share the same lock as automatic sync, including across tabs.
export async function withWebdavLock(action: () => Promise<void>): Promise<void> {
    if (busy) throw new Error('WebDAV 正在同步，请稍后重试。')
    busy = true
    try {
        if (navigator.locks) {
            await navigator.locks.request('bonjourr-webdav-sync', { ifAvailable: true }, async (lock) => {
                if (!lock) throw new Error('其他页面正在同步，请稍后重试。')
                await action()
            })
        } else {
            await action()
        }
    } finally {
        busy = false
    }
}

export async function saveWebdavSync(config: WebdavConfig, fingerprint: string, etag?: string): Promise<void> {
    await storage.local.set({
        webdav: { ...config, etag, fingerprint, lastSync: new Date().toISOString(), error: undefined },
    })
}

async function assertConnection(config: WebdavConfig): Promise<void> {
    const local = await storage.local.get(['webdav', 'syncType'])
    if (
        local.syncType !== 'webdav' || !local.webdav?.autoSync ||
        webdavFile(local.webdav).href !== webdavFile(config).href ||
        local.webdav.username !== config.username || local.webdav.password !== config.password
    ) {
        throw new Error('本地设置已变化，将在下次检查时重试。')
    }
}

async function assertUnchanged(config: WebdavConfig, fingerprint: string): Promise<void> {
    await assertConnection(config)
    if (await webdavFingerprint() !== fingerprint) {
        throw new Error('本地设置已变化，将在下次检查时重试。')
    }
}

export async function syncWebdavNow(): Promise<void> {
    await withWebdavLock(async () => {
        const local = await storage.local.get(['webdav', 'syncType'])
        const config = local.webdav
        if (local.syncType !== 'webdav' || !config?.autoSync || !config.url || navigator.onLine === false) return

        showWebdavStatus('正在自动同步…', 'pending')
        try {
            const fingerprint = await webdavFingerprint()
            let remote: Awaited<ReturnType<typeof downloadWebdav>> | undefined
            try {
                remote = await downloadWebdav(config)
            } catch (error) {
                if (!(error instanceof WebdavError) || error.status !== 404) throw error
            }
            await assertUnchanged(config, fingerprint)

            if (remote) {
                if (!hasStrongWebdavEtag(remote.etag)) {
                    throw new Error('服务器未提供强 ETag，无法自动同步，请使用手动备份或恢复。')
                }
                if (!config.fingerprint || !hasStrongWebdavEtag(config.etag)) {
                    throw new Error('首次同步发现已有远程备份，请先点击“恢复”，或点击“备份”选择保留本地设置。')
                }
                if (remote.etag !== config.etag) {
                    if (fingerprint !== config.fingerprint) {
                        throw new Error(
                            '本地和远程都有修改，自动同步已暂停。请点击“恢复”保留远程，或点击“备份”保留本地。',
                        )
                    }
                    await restoreWebdav(config, remote.backup, () => assertUnchanged(config, fingerprint))
                    await saveWebdavSync(config, await webdavFingerprint(), remote.etag)
                    globalThis.location.reload()
                    return
                }
                if (fingerprint === config.fingerprint) {
                    showWebdavStatus(`已同步 · ${new Date(config.lastSync ?? Date.now()).toLocaleString()}`, 'success')
                    if (config.error) await storage.local.set({ webdav: { ...config, error: undefined } })
                    return
                }
            }

            const backup = await createBackup()
            await assertUnchanged(config, fingerprint)
            const etag = await uploadWebdav({ ...config, etag: remote?.etag }, backup, remote?.backup)
            await assertConnection(config)
            await saveWebdavSync(config, fingerprint, etag)
            showWebdavStatus('自动同步完成', 'success')
        } catch (error) {
            const message = error instanceof Error ? error.message : '自动同步失败。'
            const current = (await storage.local.get('webdav')).webdav
            if (current && JSON.stringify(current) === JSON.stringify(config)) {
                await storage.local.set({ webdav: { ...config, error: message } })
            }
            showWebdavStatus(message, 'error')
            throw error
        }
    })
}

export function scheduleWebdavSync(resetRetry = false): void {
    if (resetRetry) {
        retryAt = 0
        failures = 0
    }
    clearTimeout(timer)
    timer = setTimeout(() => {
        if (document.visibilityState === 'hidden' || Date.now() < retryAt || busy) return
        void syncWebdavNow().then(() => {
            failures = 0
            retryAt = 0
        }).catch(() => {
            failures++
            retryAt = Date.now() + Math.min(300000, 30000 * 2 ** Math.min(failures, 4))
        })
    }, 2000)
}

export function initWebdavAutoSync(): void {
    if (initialized) return
    initialized = true
    scheduleWebdavSync()
    setInterval(() => scheduleWebdavSync(), 30000)
    globalThis.addEventListener('online', () => scheduleWebdavSync(true))
    globalThis.addEventListener('focus', () => scheduleWebdavSync())
    document.addEventListener('visibilitychange', () => scheduleWebdavSync())
    globalThis.addEventListener('storage', () => scheduleWebdavSync())
    globalThis.chrome?.storage?.onChanged.addListener(() => scheduleWebdavSync())
    globalThis.addEventListener('bonjourr-storage-change', (event) => {
        const { area, keys } = (event as CustomEvent<{ area: string; keys: string[] }>).detail
        if (area === 'sync') {
            scheduleWebdavSync()
            return
        }
        if (
            keys.some((key) =>
                key === 'syncType' || key.startsWith('background') || key.startsWith('x-icon-') ||
                ['weatherApiKey', 'weatherApiOrigin', 'gistId', 'gistToken', 'distantUrl', 'pastebinToken'].includes(
                    key,
                )
            )
        ) {
            scheduleWebdavSync()
        }
    })
}
