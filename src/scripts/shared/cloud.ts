export const DEFAULT_CLOUD_SERVER = 'https://bonjourr.telyra.top'
export const CLOUD_CHUNK_BYTES = 8 * 1024 * 1024
export const CLOUD_MAX_BODY = 10 * 1024 * 1024

export interface CloudRecord {
    key: string
    json: string | null
    revision: number
    deleted: boolean
}

export interface CloudState {
    initialized: boolean
    records: CloudRecord[]
}

export interface CloudChange {
    key: string
    json: string | null
    baseRevision: number
    deleted: boolean
}

export interface CloudMedia {
    type: string
    bytes: number
    parts: { hash: string; bytes: number }[]
}

export interface CloudConnection {
    url: string
    token: string
    deviceId: string
    name: string
    owner: boolean
    accountId?: string
    username?: string
    admin?: boolean
    expiresAt?: number
    baseline?: CloudState
    pending?: { id: string; changes: CloudChange[]; initialize?: boolean; confirmClear?: boolean }
    error?: string
    lastSync?: string
    conflicts?: string[]
}

export function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
        }
        return entry
    })
}

export function cloudKey(parts: string[]): string {
    return parts.map(encodeURIComponent).join('/')
}

export function keyParts(key: string): string[] {
    return key.split('/').map(decodeURIComponent)
}

export function validCloudKey(key: string): boolean {
    try {
        const parts = keyParts(key)
        if (
            parts[0] === 'asset' &&
            (parts.length !== 3 || !/^[\w-]+$/.test(parts[1]) || !['full', 'small'].includes(parts[2]))
        ) return false
        if (parts[0] === 'icon' && (parts.length !== 2 || !/^x-icon-[\w-]+$/.test(parts[1]))) return false
        if (
            parts[0] === 'local' &&
            !['weatherApiKey', 'weatherApiOrigin', 'backgroundCompressFiles', 'backgroundFiles', 'backgroundUrls']
                .includes(parts[1])
        ) return false
        return key.length <= 2048 && parts.length >= 2 && parts.length <= 12 &&
            ['sync', 'local', 'asset', 'icon'].includes(parts[0]) &&
            parts.every((part) => !!part && !['__proto__', 'prototype', 'constructor'].includes(part)) &&
            cloudKey(parts) === key
    } catch {
        return false
    }
}

export function flattenCloud(value: Record<string, unknown>, prefix: string[], result: Record<string, string>): void {
    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined || ['__proto__', 'prototype', 'constructor'].includes(key)) continue
        const path = [...prefix, key]
        const record = entry && typeof entry === 'object' && !Array.isArray(entry)
        const entity = record && '_id' in entry
        if (record && !entity && Object.keys(entry).length) {
            flattenCloud(entry as Record<string, unknown>, path, result)
        } else {
            result[cloudKey(path)] = canonical(entry)
        }
    }
}

export function inflateCloud(records: CloudRecord[], namespace: string): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const record of records) {
        if (record.deleted || record.json === null || !validCloudKey(record.key)) continue
        const [root, ...parts] = keyParts(record.key)
        if (root !== namespace) continue
        let target = result
        for (const part of parts.slice(0, -1)) {
            const current = target[part]
            if (!current || typeof current !== 'object' || Array.isArray(current)) target[part] = {}
            target = target[part] as Record<string, unknown>
        }
        target[parts[parts.length - 1]] = JSON.parse(record.json)
    }
    return result
}

export function cloudChanges(baseline: CloudState, current: Record<string, string>): CloudChange[] {
    const before = new Map(baseline.records.map((record) => [record.key, record]))
    const keys = new Set([...before.keys(), ...Object.keys(current)])
    const changes: CloudChange[] = []
    for (const key of keys) {
        const old = before.get(key)
        const json = current[key] ?? null
        const deleted = json === null
        if ((old?.deleted ?? true) === deleted && (old?.json ?? null) === json) continue
        changes.push({ key, json, deleted, baseRevision: old?.revision ?? 0 })
    }
    return changes
}

export function cloudConflicts(changes: CloudChange[], remote: CloudState): string[] {
    const records = new Map(remote.records.map((record) => [record.key, record]))
    return changes.filter((change) => {
        const server = records.get(change.key)
        return (server?.revision ?? 0) !== change.baseRevision &&
            !((server?.deleted ?? true) === change.deleted && (server?.json ?? null) === change.json)
    }).map((change) => change.key)
}

export function validateCloudState(value: CloudState): CloudState {
    if (!value || typeof value.initialized !== 'boolean' || !Array.isArray(value.records)) {
        throw new Error('云端数据格式无效，本机内容未更改。')
    }
    const keys = new Set<string>()
    for (const record of value.records) {
        if (
            !record || !validCloudKey(record.key) || keys.has(record.key) || !Number.isSafeInteger(record.revision) ||
            record.revision < 1 || typeof record.deleted !== 'boolean' ||
            (record.deleted ? record.json !== null : typeof record.json !== 'string')
        ) {
            throw new Error('云端数据格式无效，本机内容未更改。')
        }
        if (record.json !== null) JSON.parse(record.json)
        keys.add(record.key)
    }
    return value
}

export function validCloudMedia(value: unknown): value is CloudMedia {
    if (!value || typeof value !== 'object' || !('parts' in value) || !Array.isArray(value.parts)) return false
    const media = value as CloudMedia
    return typeof media.type === 'string' && /^(image|video)\/[\w.+-]+$/.test(media.type) &&
        Number.isSafeInteger(media.bytes) && media.bytes > 0 && media.bytes <= 4 * 1024 * 1024 * 1024 &&
        media.parts.length > 0 && media.parts.length <= 512 &&
        media.parts.every((part) =>
            typeof part?.hash === 'string' && /^[a-f0-9]{64}$/.test(part.hash) &&
            Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= CLOUD_CHUNK_BYTES
        ) &&
        media.parts.reduce((sum, part) => sum + part.bytes, 0) === media.bytes
}

export async function sha256(value: Uint8Array | string): Promise<string> {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
