import { fetchWithTimeout, httpUrl } from '../../shared/network.ts'
import { getCache } from '../../shared/cache.ts'
import { storage } from '../../storage.ts'
import {
    backgroundCacheUrl,
    backupAssetName,
    backupIconName,
    MAX_LEGACY_BYTES,
    MAX_MANIFEST_BYTES,
    parseBackup,
    readBackupAsset,
    readBackupIcon,
    restoreBackup,
} from './backup.ts'
import type { Backup, BackupPayload } from './backup.ts'
import type { WebdavConfig } from '../../../types/local.ts'

function directoryParts(config: WebdavConfig): string[] {
    const directory = config.directory?.trim().replace(/^\/+|\/+$/g, '') ?? ''
    if (!directory) return []
    const parts = directory.split('/')
    if (
        directory.length > 256 ||
        parts.some((part) => !part.trim() || part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part))
    ) {
        throw new Error('备份目录名称无效，请使用相对目录，不能包含 .. 或反斜杠。')
    }
    return parts
}

function serviceDirectory(config: WebdavConfig): URL {
    const url = httpUrl(config.url)
    if (url.search || url.hash) throw new Error('WebDAV 服务地址不能包含查询参数或片段。')
    url.pathname = url.pathname.replace(/\/?$/, '/')
    return url
}

export function webdavDirectory(config: WebdavConfig): URL {
    const url = serviceDirectory(config)
    url.pathname += directoryParts(config).map((part) => `${encodeURIComponent(part)}/`).join('')
    return url
}

export function webdavFile(config: WebdavConfig, filename = 'bonjourr-latest.json'): URL {
    return new URL(filename, webdavDirectory(config))
}

function headers(config: WebdavConfig): Headers {
    const result = new Headers()
    if (config.username || config.password) {
        if (config.username.includes(':')) throw new Error('WebDAV 用户名不能包含冒号。')
        const bytes = new TextEncoder().encode(`${config.username}:${config.password}`)
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        result.set('Authorization', `Basic ${btoa(binary)}`)
    }
    return result
}

export class WebdavError extends Error {
    constructor(message: string, public status: number) {
        super(message)
    }
}

export function hasStrongWebdavEtag(etag?: string): boolean {
    return typeof etag === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)
}

function davElements(root: Document | Element, name: string): Element[] {
    return Array.from(root.getElementsByTagName('*')).filter((element) =>
        element.namespaceURI === 'DAV:' && element.localName === name
    )
}

function failure(response: Response): Error {
    const messages: Record<number, string> = {
        401: 'WebDAV 用户名或密码错误。',
        403: 'WebDAV 账户没有此目录的访问权限。',
        404: 'WebDAV 目录或备份文件不存在，请检查服务地址，或先上传一份备份。',
        405: '服务器不支持此 WebDAV 操作，请检查服务地址。',
        409: 'WebDAV 父目录不存在，请检查服务地址。',
        412: '远程备份已被其他设备修改，请先恢复或更换备份目录。',
        423: 'WebDAV 文件被锁定，请稍后重试。',
        429: 'WebDAV 请求过于频繁，请稍后重试。',
        507: 'WebDAV 存储空间不足。',
    }
    return new WebdavError(messages[response.status] ?? `WebDAV 请求失败（HTTP ${response.status}）。`, response.status)
}

async function inspectDirectory(config: WebdavConfig, directory: URL): Promise<Response> {
    const requestHeaders = headers(config)
    requestHeaders.set('Depth', '0')
    requestHeaders.set('Content-Type', 'application/xml; charset=utf-8')
    return await fetchWithTimeout(directory, {
        method: 'PROPFIND',
        headers: requestHeaders,
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    })
}

async function verifyDirectory(response: Response): Promise<void> {
    if (!response.ok) throw failure(response)
    const xml = new DOMParser().parseFromString(await response.text(), 'application/xml')
    const resourceTypes = davElements(xml, 'resourcetype')
    const collection = resourceTypes.some((type) => {
        if (!davElements(type, 'collection').length) return false
        const propstat = type.parentElement?.parentElement
        const status = propstat ? davElements(propstat, 'status')[0]?.textContent ?? '' : ''
        return /\s200(?:\s|$)/.test(status)
    })
    if (!collection) throw new Error('服务未返回可访问的 WebDAV 目录，请检查服务地址和目录权限。')
}

export async function testWebdav(config: WebdavConfig): Promise<void> {
    const directory = webdavDirectory(config)
    const response = await inspectDirectory(config, directory)
    if (response.status !== 404 || !directoryParts(config).length) {
        await verifyDirectory(response)
        return
    }
    await response.body?.cancel()
    // Only create folders beneath the configured service; never create its parent path.
    const current = serviceDirectory(config)
    await verifyDirectory(await inspectDirectory(config, current))
    for (const part of directoryParts(config)) {
        current.pathname += `${encodeURIComponent(part)}/`
        const created = await fetchWithTimeout(current, { method: 'MKCOL', headers: headers(config) })
        if (created.status !== 201 && created.status !== 405) throw failure(created)
        await created.body?.cancel()
    }
    await verifyDirectory(await inspectDirectory(config, directory))
}

async function propertyEtag(config: WebdavConfig): Promise<string | undefined> {
    const file = webdavFile(config)
    const requestHeaders = headers(config)
    requestHeaders.set('Depth', '0')
    requestHeaders.set('Content-Type', 'application/xml; charset=utf-8')
    const response = await fetchWithTimeout(file, {
        method: 'PROPFIND',
        headers: requestHeaders,
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>',
        cache: 'no-store',
    })
    if ([403, 405, 501].includes(response.status)) return undefined
    if (!response.ok) throw failure(response)
    const xml = new DOMParser().parseFromString(await response.text(), 'application/xml')
    for (const resource of davElements(xml, 'response')) {
        const href = davElements(resource, 'href')[0]?.textContent?.trim()
        if (!href) continue
        try {
            const target = new URL(href, file)
            if (target.origin !== file.origin || decodeURI(target.pathname) !== decodeURI(file.pathname)) continue
        } catch {
            continue
        }
        for (const propstat of davElements(resource, 'propstat')) {
            const status = davElements(propstat, 'status')[0]?.textContent ?? ''
            if (!/\s200(?:\s|$)/.test(status)) continue
            const etag = davElements(propstat, 'getetag')[0]?.textContent?.trim()
            if (hasStrongWebdavEtag(etag)) return etag
        }
    }
}

async function readManifest(config: WebdavConfig): Promise<{ response: Response; etag?: string }> {
    let response = await fetchWithTimeout(
        webdavFile(config),
        { headers: headers(config), cache: 'no-store' },
        MAX_LEGACY_BYTES,
        60000,
    )
    if (!response.ok) throw failure(response)
    const etag = response.headers.get('ETag') ?? undefined
    const property = await propertyEtag(config)
    if (!property) return { response, etag }
    if (property === etag) return { response, etag: property }
    // Proxy servers can use different ETags for GET and PROPFIND. Bracket a fresh read with
    // property checks instead of forwarding the proxy's validator to its storage backend.
    await response.body?.cancel()
    response = await fetchWithTimeout(
        webdavFile(config),
        { headers: headers(config), cache: 'no-store' },
        MAX_LEGACY_BYTES,
        60000,
    )
    if (!response.ok) throw failure(response)
    if (await propertyEtag(config) !== property) {
        await response.body?.cancel()
        throw new WebdavError('远程备份在读取期间已变化，请重试。', 412)
    }
    return { response, etag: property }
}

export async function downloadWebdav(
    config: WebdavConfig,
): Promise<{ backup: BackupPayload; etag?: string }> {
    const { response, etag } = await readManifest(config)
    return { backup: parseBackup(await response.text()), etag }
}

export async function restoreWebdav(
    config: WebdavConfig,
    backup: BackupPayload,
    beforeRestore: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
    if (backup.version === 1) {
        await beforeRestore()
        await restoreBackup(backup)
        return
    }

    const cache = await getCache('local-files')

    for (const asset of backup.assets) {
        const filename = backupAssetName(asset)
        const response = await fetchWebdavFile(config, filename, asset.bytes + 1024 * 1024, 600000)

        const body = response.body
        if (!body) throw new Error(`无法读取备份文件 ${filename}。`)

        await cache.put(
            new Request(backgroundCacheUrl(asset)),
            new Response(body, { headers: { 'Content-Type': asset.type } }),
        )
    }

    const icons: Record<string, string> = {}
    for (const icon of backup.icons) {
        const filename = backupIconName(icon)
        const response = await fetchWebdavFile(config, filename, icon.bytes + 1024 * 1024, 120000)
        icons[icon.key] = await blobToDataUrl(await response.blob(), icon.type)
    }

    await beforeRestore()
    const { syncType } = await storage.local.get('syncType')
    const local = { ...backup.local, webdav: config, syncType }
    await restoreBackup({ ...backup, local }, icons)
}

export async function uploadWebdav(
    config: WebdavConfig,
    backup: Backup,
    previous?: BackupPayload,
    allowOverwrite = false,
): Promise<string | undefined> {
    if (config.etag && !hasStrongWebdavEtag(config.etag) && !allowOverwrite) {
        throw new Error('服务器仅提供弱 ETag，无法安全覆盖。')
    }
    backup.local.webdav = {
        url: config.url,
        directory: config.directory,
        username: config.username,
        password: config.password,
    }
    await testWebdav(config)

    for (const asset of backup.assets) {
        if (
            previous && previous.version !== 1 &&
            previous.assets.some((item) =>
                item.id === asset.id && item.size === asset.size && item.type === asset.type &&
                item.bytes === asset.bytes
            )
        ) continue
        const blob = await readBackupAsset(asset)
        await putWebdavFile(config, backupAssetName(asset), blob, asset.type, 600000)
    }

    for (const icon of backup.icons) {
        if (
            icon.hash && previous && previous.version !== 1 &&
            previous.icons.some((item) => item.key === icon.key && item.hash === icon.hash)
        ) continue
        const blob = await readBackupIcon(icon)
        await putWebdavFile(config, backupIconName(icon), blob, icon.type, 120000)
    }

    const payload = JSON.stringify(backup)
    if (new Blob([payload]).size > MAX_MANIFEST_BYTES) {
        throw new Error('备份配置超过 10 MB。')
    }

    const requestHeaders = headers(config)
    requestHeaders.set('Content-Type', 'application/json; charset=utf-8')
    if (!allowOverwrite) {
        requestHeaders.set(config.etag ? 'If-Match' : 'If-None-Match', config.etag ?? '*')
    }

    const response = await fetchWithTimeout(
        webdavFile(config),
        {
            method: 'PUT',
            headers: requestHeaders,
            body: payload,
        },
        MAX_MANIFEST_BYTES,
        60000,
    )
    if (!response.ok) throw failure(response)
    const etag = response.headers.get('ETag') ?? undefined
    if (hasStrongWebdavEtag(etag)) return etag
    const saved = await readManifest(config)
    if (await saved.response.text() !== payload) {
        throw new WebdavError('备份上传后已被其他设备修改，请重新检查远程备份。', 412)
    }
    return saved.etag
}

async function fetchWebdavFile(
    config: WebdavConfig,
    filename: string,
    maxBytes: number,
    timeoutMs: number,
): Promise<Response> {
    let response: Response

    try {
        response = await fetch(webdavFile(config, filename), {
            headers: headers(config),
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        })
    } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
            throw new Error('请求超时，请稍后重试。')
        }
        throw new Error('无法连接服务器，请检查地址、网络或访问权限。')
    }

    if (!response.ok) {
        await response.body?.cancel()
        throw failure(response)
    }

    if (Number(response.headers.get('Content-Length')) > maxBytes) {
        await response.body?.cancel()
        throw new Error('备份文件超过预期大小。')
    }

    return response
}

async function putWebdavFile(
    config: WebdavConfig,
    filename: string,
    body: Blob | string,
    contentType: string,
    timeoutMs: number,
): Promise<void> {
    const requestHeaders = headers(config)
    requestHeaders.set('Content-Type', contentType)
    const response = await fetchWithTimeout(
        webdavFile(config, filename),
        { method: 'PUT', headers: requestHeaders, body },
        MAX_MANIFEST_BYTES,
        timeoutMs,
    )
    if (!response.ok) throw failure(response)
    await response.body?.cancel()
}

async function blobToDataUrl(blob: Blob, type: string): Promise<string> {
    const array = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let i = 0; i < array.length; i += 8192) {
        binary += String.fromCharCode(...array.subarray(i, i + 8192))
    }
    return `data:${type};base64,${btoa(binary)}`
}
