import { fetchWithTimeout, httpUrl } from '../../shared/network.ts'
import { MAX_BACKUP_BYTES, parseBackup } from './backup.ts'
import type { Backup } from './backup.ts'
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

function failure(response: Response): Error {
    const messages: Record<number, string> = {
        401: 'WebDAV 用户名或密码错误。',
        403: 'WebDAV 账户没有此目录的访问权限。',
        404: 'WebDAV 目录或备份文件不存在，请检查服务地址，或先上传一份备份。',
        405: '服务器不支持此 WebDAV 操作，请检查服务地址。',
        409: 'WebDAV 父目录不存在，请检查服务地址。',
        412: '远程备份已被其他设备修改，请先下载或另存快照。',
        423: 'WebDAV 文件被锁定，请稍后重试。',
        429: 'WebDAV 请求过于频繁，请稍后重试。',
        507: 'WebDAV 存储空间不足。',
    }
    return new Error(messages[response.status] ?? `WebDAV 请求失败（HTTP ${response.status}）。`)
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
    const davElements = (root: Document | Element, name: string): Element[] =>
        Array.from(root.getElementsByTagName('*')).filter((element) =>
            element.namespaceURI === 'DAV:' && element.localName === name
        )
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

export async function downloadWebdav(config: WebdavConfig): Promise<{ backup: Backup; etag?: string }> {
    const response = await fetchWithTimeout(
        webdavFile(config),
        { headers: headers(config), cache: 'no-store' },
        MAX_BACKUP_BYTES,
        60000,
    )
    if (!response.ok) throw failure(response)
    if (Number(response.headers.get('Content-Length')) > MAX_BACKUP_BYTES) throw new Error('远程备份超过 50 MB。')
    return { backup: parseBackup(await response.text()), etag: response.headers.get('ETag') ?? undefined }
}

export async function uploadWebdav(
    config: WebdavConfig,
    backup: Backup,
    snapshot = false,
): Promise<string | undefined> {
    await testWebdav(config)
    const requestHeaders = headers(config)
    requestHeaders.set('Content-Type', 'application/json; charset=utf-8')
    const filename = snapshot
        ? `bonjourr-${backup.createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`
        : undefined
    if (!snapshot && config.etag?.startsWith('W/')) {
        throw new Error('服务器仅提供弱 ETag，无法安全覆盖；请使用“另存快照”。')
    }
    requestHeaders.set(
        !snapshot && config.etag ? 'If-Match' : 'If-None-Match',
        !snapshot && config.etag ? config.etag : '*',
    )
    const response = await fetchWithTimeout(
        webdavFile(config, filename),
        {
            method: 'PUT',
            headers: requestHeaders,
            body: JSON.stringify(backup),
        },
        MAX_BACKUP_BYTES,
        60000,
    )
    if (!response.ok) throw failure(response)
    return response.headers.get('ETag') ?? undefined
}
