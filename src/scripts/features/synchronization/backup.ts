import { storage } from '../../storage.ts'
import { getCache } from '../../shared/cache.ts'
import { filterData } from '../../compatibility/apply.ts'
import { SYNC_DEFAULT } from '../../defaults.ts'
import type { Sync } from '../../../types/sync.ts'
import type { Local } from '../../../types/local.ts'

export interface Backup {
    format: 'bonjourr-webdav'
    version: 1
    createdAt: string
    settings: Sync
    local: Pick<Local, 'backgroundFiles' | 'backgroundUrls'> & { icons: Record<string, string> }
    assets: { id: string; size: 'full' | 'small'; type: string; data: string }[]
}

export const MAX_BACKUP_BYTES = 50 * 1024 * 1024

export async function createBackup(): Promise<Backup> {
    const settings = await storage.sync.get()
    const local = await storage.local.get()
    const cache = await getCache('local-files')
    const backup: Backup = {
        format: 'bonjourr-webdav',
        version: 1,
        createdAt: new Date().toISOString(),
        settings: portableSettings(settings),
        local: { backgroundFiles: local.backgroundFiles ?? {}, backgroundUrls: local.backgroundUrls ?? {}, icons: {} },
        assets: [],
    }
    for (const [key, value] of Object.entries(local)) {
        if (key.startsWith('x-icon-') && typeof value === 'string' && /^data:image\//.test(value)) {
            backup.local.icons[key] = value
        }
    }
    let bytes = 0
    for (const id of Object.keys(backup.local.backgroundFiles)) {
        for (const size of ['full', 'small'] as const) {
            const response = await cache.match(`http://127.0.0.1:8888/${id}/${size}`)
            if (!response) throw new Error(`本地壁纸 ${id} 的 ${size} 文件缺失，请重新导入壁纸后备份。`)
            const blob = await response.blob()
            bytes += blob.size
            if (bytes * 1.34 > MAX_BACKUP_BYTES) throw new Error('完整备份超过 50 MB，请减少本地视频或壁纸后重试。')
            const array = new Uint8Array(await blob.arrayBuffer())
            let binary = ''
            for (let i = 0; i < array.length; i += 8192) binary += String.fromCharCode(...array.subarray(i, i + 8192))
            backup.assets.push({ id, size, type: blob.type, data: btoa(binary) })
        }
    }
    if (new Blob([JSON.stringify(backup)]).size > MAX_BACKUP_BYTES) throw new Error('备份超过 50 MB。')
    return backup
}

function portableSettings(data: Sync): Sync {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(SYNC_DEFAULT)) if (key in data) result[key] = data[key]
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && '_id' in value && value._id === key) result[key] = value
    }
    return result as unknown as Sync
}

export function parseBackup(text: string): Backup {
    if (new Blob([text]).size > MAX_BACKUP_BYTES) throw new Error('远程备份超过 50 MB，已停止读取。')
    const data = JSON.parse(text) as Backup
    if (
        !data || data.format !== 'bonjourr-webdav' || data.version !== 1 || !data.settings ||
        typeof data.settings !== 'object' || !data.settings.about || typeof data.settings.about.version !== 'string' ||
        !data.local || !data.local.backgroundFiles || !data.local.backgroundUrls || !data.local.icons ||
        !Array.isArray(data.assets) || data.assets.length > 1000
    ) {
        throw new Error('备份格式无效或版本不受支持。')
    }
    // Reject malformed data before touching storage or local resources.
    for (const [key, value] of Object.entries(data.settings)) {
        const defaultValue = SYNC_DEFAULT[key]
        if (
            defaultValue !== undefined && value !== undefined &&
            (value === null || Array.isArray(value) !== Array.isArray(defaultValue) ||
                typeof value !== typeof defaultValue)
        ) {
            throw new Error(`备份中的 ${key} 类型无效。`)
        }
    }
    const seen = new Set<string>()
    for (const asset of data.assets) {
        if (
            !asset || !/^[\w-]+$/.test(asset.id) || !['full', 'small'].includes(asset.size) ||
            typeof asset.type !== 'string' || !/^(image|video)\//.test(asset.type) ||
            typeof asset.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data) || asset.data.length % 4
        ) {
            throw new Error('备份包含无效的壁纸资源。')
        }
        const key = `${asset.id}/${asset.size}`
        if (seen.has(key)) throw new Error('备份包含重复资源。')
        seen.add(key)
    }
    for (const id of Object.keys(data.local.backgroundFiles)) {
        if (!seen.has(`${id}/full`) || !seen.has(`${id}/small`)) throw new Error('备份中的本地壁纸不完整。')
    }
    for (const [key, value] of Object.entries(data.local.icons)) {
        if (!key.startsWith('x-icon-') || typeof value !== 'string' || !/^data:image\//.test(value)) {
            throw new Error('备份包含无效的自定义图标。')
        }
    }
    data.settings = portableSettings(data.settings)
    return data
}

export async function restoreBackup(backup: Backup): Promise<void> {
    const current = await storage.sync.get()
    const settings = filterData('import', structuredClone(SYNC_DEFAULT), backup.settings)
    const cache = await getCache('local-files')
    for (const asset of backup.assets) {
        const bytes = Uint8Array.from(atob(asset.data), (char) => char.charCodeAt(0))
        await cache.put(
            new Request(`http://127.0.0.1:8888/${asset.id}/${asset.size}`),
            new Response(bytes, {
                headers: { 'Content-Type': asset.type },
            }),
        )
    }
    await storage.local.set({
        backgroundFiles: backup.local.backgroundFiles,
        backgroundUrls: backup.local.backgroundUrls,
        ...backup.local.icons,
    })
    try {
        await storage.sync.clear()
        await storage.sync.set(settings)
    } catch (error) {
        await storage.sync.set(current)
        throw error
    }
}

export async function saveRecoveryBackup(): Promise<void> {
    const cache = await getCache('webdav-recovery')
    await cache.put(
        new Request('http://127.0.0.1:8888/backup'),
        new Response(JSON.stringify(await createBackup()), {
            headers: { 'Content-Type': 'application/json' },
        }),
    )
}

export async function recoveryBackup(): Promise<Backup> {
    const cache = await getCache('webdav-recovery')
    const response = await cache.match('http://127.0.0.1:8888/backup')
    if (!response) throw new Error('暂无本地恢复副本。')
    return parseBackup(await response.text())
}
