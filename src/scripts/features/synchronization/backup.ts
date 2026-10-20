import { storage } from '../../storage.ts'
import { getCache } from '../../shared/cache.ts'
import { filterData } from '../../compatibility/apply.ts'
import { SYNC_DEFAULT } from '../../defaults.ts'
import type { Local } from '../../../types/local.ts'
import type { Sync } from '../../../types/sync.ts'

export interface LegacyBackup {
    format: 'bonjourr-webdav'
    version: 1
    createdAt: string
    settings: Sync
    local: {
        backgroundFiles: Local['backgroundFiles']
        backgroundUrls: Local['backgroundUrls']
        icons: Record<string, string>
    }
    assets: { id: string; size: 'full' | 'small'; type: string; data: string }[]
}

export interface BackupAsset {
    id: string
    size: 'full' | 'small'
    type: string
    bytes: number
}

export interface BackupIcon {
    key: string
    type: string
    bytes: number
    hash?: string
}

export interface BackupLocal {
    weatherApiKey?: string
    weatherApiOrigin?: string
    webdav?: Pick<NonNullable<Local['webdav']>, 'url' | 'directory' | 'username' | 'password'>
    gistId?: string
    gistToken?: string
    distantUrl?: string
    pastebinToken?: string
    syncType?: NonNullable<Local['syncType']>
    backgroundFiles: Local['backgroundFiles']
    backgroundUrls: Local['backgroundUrls']
    backgroundCompressFiles?: boolean
    backgroundLastChange?: string
}

export interface Backup {
    format: 'bonjourr-webdav'
    version: 2 | 3
    createdAt: string
    settings: Sync
    local: BackupLocal
    assets: BackupAsset[]
    icons: BackupIcon[]
}

export type BackupPayload = LegacyBackup | Backup

// Compare saved content, excluding connection details and device-specific sync state.
export async function webdavFingerprint(): Promise<string> {
    const settings = portableSettings(await storage.sync.get())
    const local = await storage.local.get()
    const values = persistentLocal(local)
    delete values.webdav
    delete values.syncType
    const icons = Object.fromEntries(Object.entries(local).filter(([key]) => key.startsWith('x-icon-')))
    const sorted = (_key: string, value: unknown): unknown => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
        }
        return value
    }
    const content = JSON.stringify({ settings, local: values, icons }, sorted)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const MAX_MANIFEST_BYTES = 10 * 1024 * 1024
export const MAX_LEGACY_BYTES = 50 * 1024 * 1024
export const MAX_ASSET_BYTES = 4 * 1024 * 1024 * 1024
export const MAX_ICON_BYTES = 20 * 1024 * 1024

const PERSISTENT_LOCAL_KEYS = [
    'weatherApiKey',
    'weatherApiOrigin',
    'webdav',
    'gistId',
    'gistToken',
    'distantUrl',
    'pastebinToken',
    'syncType',
    'backgroundFiles',
    'backgroundUrls',
    'backgroundCompressFiles',
    'backgroundLastChange',
] as const

export function backgroundCacheUrl(asset: Pick<BackupAsset, 'id' | 'size'>): string {
    return `http://127.0.0.1:8888/${asset.id}/${asset.size}`
}

export function backupAssetName(asset: Pick<BackupAsset, 'id' | 'size'>): string {
    return `bonjourr-asset-${asset.id}-${asset.size}`
}

export function backupIconName(icon: Pick<BackupIcon, 'key' | 'hash'>): string {
    return `bonjourr-icon-${icon.key}${icon.hash ? `-${icon.hash}` : ''}`
}

export async function createBackup(): Promise<Backup> {
    const settings = await storage.sync.get()
    const local = await storage.local.get()
    const cache = await getCache('local-files')
    const backup: Backup = {
        format: 'bonjourr-webdav',
        version: 3,
        createdAt: new Date().toISOString(),
        settings: portableSettings(settings),
        local: persistentLocal(local),
        assets: [],
        icons: [],
    }

    for (const [id, metadata] of Object.entries(backup.local.backgroundFiles)) {
        for (const size of ['full', 'small'] as const) {
            const response = await cache.match(backgroundCacheUrl({ id, size }))
            if (!response) {
                throw new Error(`本地背景 ${id} 的 ${size} 文件缺失，请重新导入壁纸后备份。`)
            }
            const blob = await response.blob()
            if (blob.size === 0) {
                throw new Error(`本地背景 ${id} 的 ${size} 文件为空。`)
            }
            if (blob.size > MAX_ASSET_BYTES) {
                throw new Error(`本地背景 ${id} 超过 ${formatBytes(MAX_ASSET_BYTES)}。`)
            }
            const type = blob.type || (metadata.format === 'video' ? 'video/mp4' : 'image/jpeg')
            backup.assets.push({ id, size, type, bytes: blob.size })
        }
    }

    for (const [key, value] of Object.entries(local)) {
        if (!key.startsWith('x-icon-') || typeof value !== 'string') {
            continue
        }
        const icon = dataUrlToBlob(value)
        if (!icon) {
            continue
        }
        if (icon.blob.size > MAX_ICON_BYTES) {
            throw new Error(`自定义图标 ${key} 超过 ${formatBytes(MAX_ICON_BYTES)}。`)
        }
        const digest = await crypto.subtle.digest('SHA-256', await icon.blob.arrayBuffer())
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
        backup.icons.push({ key, type: icon.type, bytes: icon.blob.size, hash })
    }

    if (new Blob([JSON.stringify(backup)]).size > MAX_MANIFEST_BYTES) {
        throw new Error(`备份配置超过 ${formatBytes(MAX_MANIFEST_BYTES)}。`)
    }

    return backup
}

export async function readBackupAsset(asset: BackupAsset): Promise<Blob> {
    const cache = await getCache('local-files')
    const response = await cache.match(backgroundCacheUrl(asset))
    if (!response) {
        throw new Error(`本地背景 ${asset.id} 的 ${asset.size} 文件缺失。`)
    }
    return await response.blob()
}

export async function readBackupIcon(icon: BackupIcon): Promise<Blob> {
    const local = await storage.local.get()
    const value = local[icon.key as `x-icon-${string}`]
    const parsed = typeof value === 'string' ? dataUrlToBlob(value) : undefined
    if (!parsed) {
        throw new Error(`自定义图标 ${icon.key} 缺失。`)
    }
    if (icon.hash) {
        const digest = await crypto.subtle.digest('SHA-256', await parsed.blob.arrayBuffer())
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
        if (hash !== icon.hash) throw new Error('本地图标已变化，请重新备份。')
    }
    return parsed.blob
}

export function parseBackup(text: string): BackupPayload {
    const size = new Blob([text]).size
    if (size > MAX_LEGACY_BYTES) {
        throw new Error(`备份配置超过 ${formatBytes(MAX_LEGACY_BYTES)}。`)
    }

    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        throw new Error('备份格式无效或版本不受支持。')
    }

    if (!isRecord(value) || value.format !== 'bonjourr-webdav') {
        throw new Error('备份格式无效或版本不受支持。')
    }

    if (value.version === 1) {
        return parseLegacyBackup(value)
    }

    if (value.version === 2 || value.version === 3) {
        if (size > MAX_MANIFEST_BYTES) {
            throw new Error(`备份配置超过 ${formatBytes(MAX_MANIFEST_BYTES)}。`)
        }
        return parseCurrentBackup(value)
    }

    throw new Error('备份格式无效或版本不受支持。')
}

export async function restoreBackup(backup: BackupPayload, icons?: Record<string, string>): Promise<void> {
    if (backup.version === 1) {
        await restoreLegacyBackup(backup)
        return
    }

    if (!icons) {
        throw new Error('备份缺少自定义图标数据。')
    }

    await pruneLocalAssets(backup.assets)

    const currentLocal = await storage.local.get()
    for (const key of Object.keys(currentLocal)) {
        if (key.startsWith('x-icon-') && !(key in icons)) {
            await storage.local.remove(key as keyof Local)
        }
    }
    for (const key of PERSISTENT_LOCAL_KEYS) {
        if (!(key in backup.local)) {
            await storage.local.remove(key)
        }
    }

    await storage.local.set({ ...backup.local, ...icons })
    await applySyncSettings(backup.settings)
}

function persistentLocal(local: Local): BackupLocal {
    const result: BackupLocal = {
        backgroundFiles: local.backgroundFiles ?? {},
        backgroundUrls: local.backgroundUrls ?? {},
    }

    if (local.weatherApiKey !== undefined) result.weatherApiKey = local.weatherApiKey
    if (local.weatherApiOrigin !== undefined) result.weatherApiOrigin = local.weatherApiOrigin
    if (local.gistId !== undefined) result.gistId = local.gistId
    if (local.gistToken !== undefined) result.gistToken = local.gistToken
    if (local.distantUrl !== undefined) result.distantUrl = local.distantUrl
    if (local.pastebinToken !== undefined) result.pastebinToken = local.pastebinToken
    if (local.syncType !== undefined) result.syncType = local.syncType
    if (local.backgroundCompressFiles !== undefined) result.backgroundCompressFiles = local.backgroundCompressFiles
    if (local.backgroundLastChange !== undefined) result.backgroundLastChange = local.backgroundLastChange
    if (local.webdav) {
        result.webdav = {
            url: local.webdav.url,
            directory: local.webdav.directory,
            username: local.webdav.username,
            password: local.webdav.password,
        }
    }

    return result
}

function parseLegacyBackup(value: Record<string, unknown>): LegacyBackup {
    const backup = value as unknown as LegacyBackup

    if (
        !isRecord(backup.local) ||
        !isRecord(backup.local.backgroundFiles) ||
        !isRecord(backup.local.backgroundUrls) ||
        !isRecord(backup.local.icons) ||
        !Array.isArray(backup.assets)
    ) {
        throw new Error('备份格式无效或版本不受支持。')
    }

    backup.settings = validateSettings(backup.settings)

    const seen = new Set<string>()
    for (const asset of backup.assets) {
        if (
            !isRecord(asset) || !/^[\w-]+$/.test(asset.id) || !['full', 'small'].includes(asset.size) ||
            typeof asset.type !== 'string' || !/^(image|video)\//.test(asset.type) ||
            typeof asset.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data) || asset.data.length % 4
        ) {
            throw new Error('备份包含无效的壁纸资源。')
        }
        const key = `${asset.id}/${asset.size}`
        if (seen.has(key)) throw new Error('备份包含重复资源。')
        seen.add(key)
    }

    for (const id of Object.keys(backup.local.backgroundFiles)) {
        if (!seen.has(`${id}/full`) || !seen.has(`${id}/small`)) {
            throw new Error('备份中的本地壁纸不完整。')
        }
    }

    for (const [key, val] of Object.entries(backup.local.icons)) {
        if (!key.startsWith('x-icon-') || typeof val !== 'string' || !/^data:image\//.test(val)) {
            throw new Error('备份包含无效的自定义图标。')
        }
    }

    return backup
}

function parseCurrentBackup(value: Record<string, unknown>): Backup {
    const backup = value as unknown as Backup

    if (
        !isRecord(backup.local) ||
        !isRecord(backup.local.backgroundFiles) ||
        !isRecord(backup.local.backgroundUrls) ||
        !Array.isArray(backup.assets) ||
        !Array.isArray(backup.icons)
    ) {
        throw new Error('备份格式无效或版本不受支持。')
    }

    backup.settings = validateSettings(backup.settings)
    backup.local = pickBackupLocal(backup.local)

    const assets = new Set<string>()
    for (const asset of backup.assets) {
        if (
            !isRecord(asset) || !/^[\w-]+$/.test(asset.id) || !['full', 'small'].includes(asset.size) ||
            typeof asset.type !== 'string' || !/^(image|video)\//.test(asset.type) ||
            !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > MAX_ASSET_BYTES
        ) {
            throw new Error('备份包含无效的壁纸资源。')
        }
        const key = `${asset.id}/${asset.size}`
        if (assets.has(key)) throw new Error('备份包含重复资源。')
        assets.add(key)
    }

    for (const id of Object.keys(backup.local.backgroundFiles)) {
        if (!assets.has(`${id}/full`) || !assets.has(`${id}/small`)) {
            throw new Error('备份中的本地壁纸不完整。')
        }
    }

    const icons = new Set<string>()
    for (const icon of backup.icons) {
        if (
            !isRecord(icon) || !/^x-icon-[\w-]+$/.test(icon.key) || typeof icon.type !== 'string' ||
            !/^image\//.test(icon.type) || !Number.isSafeInteger(icon.bytes) || icon.bytes <= 0 ||
            icon.bytes > MAX_ICON_BYTES
        ) {
            throw new Error('备份包含无效的自定义图标。')
        }
        if (icon.hash !== undefined && (typeof icon.hash !== 'string' || !/^[a-f0-9]{64}$/.test(icon.hash))) {
            throw new Error('备份包含无效的自定义图标摘要。')
        }
        if (icons.has(icon.key)) throw new Error('备份包含重复图标。')
        icons.add(icon.key)
    }

    return backup
}

function validateSettings(value: unknown): Sync {
    if (!isRecord(value) || !isRecord(value.about) || typeof value.about.version !== 'string') {
        throw new Error('备份格式无效或版本不受支持。')
    }

    for (const [key, val] of Object.entries(value)) {
        const defaultValue = SYNC_DEFAULT[key]
        if (
            defaultValue !== undefined && val !== undefined &&
            (val === null || Array.isArray(val) !== Array.isArray(defaultValue) || typeof val !== typeof defaultValue)
        ) {
            throw new Error(`备份中的 ${key} 类型无效。`)
        }
    }

    return portableSettings(value as unknown as Sync)
}

function pickBackupLocal(value: Record<string, unknown> | BackupLocal): BackupLocal {
    const input = value as Record<string, unknown>
    const result: BackupLocal = {
        backgroundFiles: isRecord(input.backgroundFiles) ? input.backgroundFiles as BackupLocal['backgroundFiles'] : {},
        backgroundUrls: isRecord(input.backgroundUrls) ? input.backgroundUrls as BackupLocal['backgroundUrls'] : {},
    }

    for (
        const key of [
            'weatherApiKey',
            'weatherApiOrigin',
            'gistId',
            'gistToken',
            'distantUrl',
            'pastebinToken',
        ] as const
    ) {
        if (typeof input[key] === 'string') result[key] = input[key]
    }
    if (typeof input.backgroundCompressFiles === 'boolean') {
        result.backgroundCompressFiles = input.backgroundCompressFiles
    }
    if (typeof input.backgroundLastChange === 'string') result.backgroundLastChange = input.backgroundLastChange
    if (typeof input.syncType === 'string' && ['browser', 'gist', 'url', 'webdav', 'off'].includes(input.syncType)) {
        result.syncType = input.syncType as NonNullable<Local['syncType']>
    }
    if (isRecord(input.webdav)) {
        const { url, directory, username, password } = input.webdav
        if (typeof url === 'string' && typeof username === 'string' && typeof password === 'string') {
            result.webdav = {
                url,
                username,
                password,
                directory: typeof directory === 'string' ? directory : undefined,
            }
        }
    }

    return result
}

async function restoreLegacyBackup(backup: LegacyBackup): Promise<void> {
    const cache = await getCache('local-files')
    for (const asset of backup.assets) {
        const bytes = Uint8Array.from(atob(asset.data), (char) => char.charCodeAt(0))
        await cache.put(
            new Request(backgroundCacheUrl(asset)),
            new Response(bytes, { headers: { 'Content-Type': asset.type } }),
        )
    }

    await pruneLocalAssets(backup.assets)

    const currentLocal = await storage.local.get()
    for (const key of Object.keys(currentLocal)) {
        if (key.startsWith('x-icon-') && !(key in backup.local.icons)) {
            await storage.local.remove(key as keyof Local)
        }
    }

    await storage.local.set({
        backgroundFiles: backup.local.backgroundFiles,
        backgroundUrls: backup.local.backgroundUrls,
        ...backup.local.icons,
    })
    await applySyncSettings(backup.settings)
}

async function pruneLocalAssets(assets: { id: string; size: 'full' | 'small' }[]): Promise<void> {
    const cache = await getCache('local-files')
    const keep = new Set(assets.map((asset) => backgroundCacheUrl(asset)))
    const keys = await cache.keys()
    for (const request of keys) {
        if (request.url.startsWith('http://127.0.0.1:8888/') && !keep.has(request.url)) {
            await cache.delete(request)
        }
    }
}

async function applySyncSettings(settings: Sync): Promise<void> {
    const current = await storage.sync.get()
    const next = filterData('import', structuredClone(SYNC_DEFAULT), settings)

    try {
        await storage.sync.clear()
        await storage.sync.set(next)
    } catch (error) {
        await storage.sync.set(current)
        throw error
    }
}

function portableSettings(data: Sync): Sync {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(SYNC_DEFAULT)) if (key in data) result[key] = data[key]
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && '_id' in value && value._id === key) result[key] = value
    }
    return result as unknown as Sync
}

function dataUrlToBlob(value: string): { blob: Blob; type: string } | undefined {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(value)
    if (!match) return
    const type = match[1]
    try {
        if (match[2]) {
            const bytes = Uint8Array.from(atob(match[3]), (char) => char.charCodeAt(0))
            return { blob: new Blob([bytes], { type }), type }
        }
        return { blob: new Blob([decodeURIComponent(match[3])], { type }), type }
    } catch {
        return
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

function formatBytes(bytes: number): string {
    return `${Math.round(bytes / 1024 / 1024)} MB`
}
