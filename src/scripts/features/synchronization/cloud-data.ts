import { SYNC_DEFAULT } from '../../defaults.ts'
import { storage } from '../../storage.ts'
import { filterData } from '../../compatibility/apply.ts'
import { getCache } from '../../shared/cache.ts'
import {
    canonical,
    CLOUD_CHUNK_BYTES,
    cloudKey,
    flattenCloud,
    inflateCloud,
    keyParts,
    sha256,
    validCloudMedia,
} from '../../shared/cloud.ts'
import type { CloudConnection, CloudMedia, CloudRecord, CloudState } from '../../shared/cloud.ts'
import { backgroundCacheUrl, createBackup, readBackupAsset, readBackupIcon } from './backup.ts'
import { cloudFetch, CloudRequestError } from './cloud-api.ts'
import type { Local } from '../../../types/local.ts'
import type { Sync } from '../../../types/sync.ts'

const DEVICE_SETTINGS = ['about', 'review', 'reviewPopup', 'move', 'pagewidth', 'pagegap', 'compactLayout'] as const
const SHARED_LOCAL = ['weatherApiKey', 'weatherApiOrigin', 'backgroundCompressFiles'] as const

export interface CloudCapture {
    records: Record<string, string>
    files: Map<string, Blob>
}

export async function captureCloudData(): Promise<CloudCapture> {
    const backup = await createBackup()
    const settings = structuredClone(backup.settings) as Record<string, unknown>
    for (const key of DEVICE_SETTINGS) delete settings[key]
    const groups = settings.linkgroups as Record<string, unknown> | undefined
    if (groups) {
        delete groups.selected
        delete groups.synced
    }
    const quotes = settings.quotes as Record<string, unknown> | undefined
    if (quotes) delete quotes.last
    const records: Record<string, string> = {}
    flattenCloud(settings, ['sync'], records)
    const local: Record<string, unknown> = {}
    for (const key of SHARED_LOCAL) if (backup.local[key] !== undefined) local[key] = backup.local[key]
    local.backgroundFiles = Object.fromEntries(
        Object.entries(backup.local.backgroundFiles).map(([id, file]) => {
            const value = { ...file }
            delete (value as Partial<typeof file>).lastUsed
            return [id, value]
        }),
    )
    local.backgroundUrls = Object.fromEntries(
        Object.entries(backup.local.backgroundUrls).map(([url, file]) => [url, { format: file.format }]),
    )
    flattenCloud(local, ['local'], records)
    const files = new Map<string, Blob>()
    for (const asset of backup.assets) {
        files.set(cloudKey(['asset', asset.id, asset.size]), await readBackupAsset(asset))
    }
    for (const icon of backup.icons) files.set(cloudKey(['icon', icon.key]), await readBackupIcon(icon))
    for (const [key, blob] of files) {
        const parts: CloudMedia['parts'] = []
        for (let offset = 0; offset < blob.size; offset += CLOUD_CHUNK_BYTES) {
            const bytes = new Uint8Array(await blob.slice(offset, offset + CLOUD_CHUNK_BYTES).arrayBuffer())
            parts.push({ hash: await sha256(bytes), bytes: bytes.length })
        }
        records[key] = canonical({ type: blob.type, bytes: blob.size, parts })
    }
    return { records, files }
}

export async function uploadCloudMedia(connection: CloudConnection, capture: CloudCapture): Promise<void> {
    const uploaded = new Set<string>()
    for (const [key, blob] of capture.files) {
        const media: CloudMedia = JSON.parse(capture.records[key])
        let offset = 0
        for (const part of media.parts) {
            if (!uploaded.has(part.hash)) {
                let exists = true
                try {
                    await cloudFetch(connection, `assets/${part.hash}`, { method: 'HEAD' })
                } catch (error) {
                    if (!(error instanceof CloudRequestError) || error.status !== 404) throw error
                    exists = false
                }
                if (!exists) {
                    await cloudFetch(connection, `assets/${part.hash}`, {
                        method: 'PUT',
                        body: blob.slice(offset, offset + part.bytes),
                    })
                }
                uploaded.add(part.hash)
            }
            offset += part.bytes
        }
    }
}

function mediaStream(connection: CloudConnection, media: CloudMedia): ReadableStream<Uint8Array> {
    let index = 0
    return new ReadableStream({
        async pull(controller): Promise<void> {
            if (index === media.parts.length) {
                controller.close()
                return
            }
            const part = media.parts[index++]
            const response = await cloudFetch(connection, `assets/${part.hash}`)
            const bytes = new Uint8Array(await response.arrayBuffer())
            if (bytes.length !== part.bytes || await sha256(bytes) !== part.hash) {
                throw new Error('下载的媒体校验失败，本地设置未更改。')
            }
            controller.enqueue(bytes)
        },
    })
}

export async function applyCloudData(
    connection: CloudConnection,
    state: CloudState,
    current: CloudCapture,
    beforeCommit: () => Promise<void>,
): Promise<void> {
    const cache = await getCache('local-files')
    const local = await storage.local.get()
    const before = await storage.sync.get()
    const settings = inflateCloud(state.records, 'sync')
    for (const key of DEVICE_SETTINGS) settings[key] = before[key]
    const groups = {
        ...structuredClone(SYNC_DEFAULT.linkgroups),
        ...(settings.linkgroups as Partial<Sync['linkgroups']> | undefined),
    }
    settings.linkgroups = groups
    groups.selected = groups.groups.includes(before.linkgroups.selected)
        ? before.linkgroups.selected
        : groups.groups[0] ?? 'default'
    groups.synced = before.linkgroups.synced.filter((group) => groups.groups.includes(group))
    if (settings.quotes) (settings.quotes as Partial<Sync['quotes']>).last = before.quotes.last
    const next = filterData('import', structuredClone(SYNC_DEFAULT), settings as Partial<Sync>)
    const incoming = inflateCloud(state.records, 'local') as Partial<Local>
    const icons: Record<string, string> = {}
    const staged: { source: string; target: string }[] = []
    // Download and verify all missing media before committing any settings.
    for (const record of state.records) {
        if (record.deleted || !(record.key.startsWith('asset/') || record.key.startsWith('icon/'))) continue
        const media: unknown = JSON.parse(record.json!)
        if (!validCloudMedia(media)) throw new Error('云端媒体信息无效。')
        const [kind, id, size] = keyParts(record.key)
        if (kind === 'asset') {
            if (
                current.records[record.key] === record.json &&
                await cache.match(backgroundCacheUrl({ id, size: size as 'full' | 'small' }))
            ) continue
            const source = `https://bonjourr.invalid/cloud-stage/${await sha256(record.json!)}`
            const target = backgroundCacheUrl({ id, size: size as 'full' | 'small' })
            await cache.put(
                new Request(source),
                new Response(mediaStream(connection, media), { headers: { 'Content-Type': media.type } }),
            )
            staged.push({ source, target })
        } else if (current.records[record.key] !== record.json || !local[id as `x-icon-${string}`]) {
            const blob = await new Response(mediaStream(connection, media)).blob()
            const bytes = new Uint8Array(await blob.arrayBuffer())
            let binary = ''
            for (const byte of bytes) binary += String.fromCharCode(byte)
            icons[id] = `data:${media.type};base64,${btoa(binary)}`
        } else icons[id] = local[id as `x-icon-${string}`]
    }
    await beforeCommit()
    for (const entry of staged) {
        const response = await cache.match(entry.source)
        if (!response) throw new Error('媒体下载未完成，请重试。')
        await cache.put(new Request(entry.target), response)
        await cache.delete(entry.source)
    }
    incoming.backgroundFiles ??= {}
    incoming.backgroundUrls ??= {}
    for (const [id, file] of Object.entries(incoming.backgroundFiles)) {
        file.lastUsed = local.backgroundFiles?.[id]?.lastUsed ?? ''
    }
    for (const [url, file] of Object.entries(incoming.backgroundUrls)) {
        file.lastUsed = local.backgroundUrls?.[url]?.lastUsed ?? ''
        file.state = local.backgroundUrls?.[url]?.state ?? 'NONE'
    }
    for (const key of SHARED_LOCAL) if (!(key in incoming)) await storage.local.remove(key)
    for (const key of Object.keys(local)) {
        if (key.startsWith('x-icon-') && !(key in icons)) await storage.local.remove(key as `x-icon-${string}`)
    }
    await storage.local.set({ ...incoming, ...icons })
    try {
        await storage.sync.clear()
        await storage.sync.set(next)
    } catch (error) {
        await storage.sync.set(before)
        throw error
    }
}

export function overlayCloudRecords(state: CloudState, values: Record<string, string>): CloudState {
    const before = new Map(state.records.map((record) => [record.key, record]))
    const keys = new Set([...before.keys(), ...Object.keys(values)])
    const records: CloudRecord[] = [...keys].map((key) => ({
        key,
        json: values[key] ?? null,
        deleted: !(key in values),
        revision: before.get(key)?.revision ?? 0,
    }))
    return { initialized: state.initialized, records }
}

export function activeCloudRecords(state: CloudState): Record<string, string> {
    return Object.fromEntries(
        state.records.filter((record) => !record.deleted && record.json !== null).map((
            record,
        ) => [record.key, record.json!]),
    )
}
