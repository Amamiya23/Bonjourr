import { canonical, CLOUD_CHUNK_BYTES, sha256, validCloudMedia } from '../src/scripts/shared/cloud.ts'
import type { CloudChange, CloudState } from '../src/scripts/shared/cloud.ts'
import { commitChanges, parseChanges, readState } from './database.ts'
import { bodyJson, boundedBody, HttpError } from './http.ts'
import type { AccountEnv } from './scope.ts'

interface BackupConfig {
    url: string
    directory: string
    username: string
    password: string
}

function configFrom(value: Record<string, unknown>): BackupConfig {
    let url: URL
    try {
        url = new URL(String(value.url))
    } catch {
        throw new HttpError(400, '请输入完整的 HTTPS WebDAV 地址。')
    }
    if (
        url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname)
    ) {
        throw new HttpError(400, 'WebDAV 必须使用可公开访问的 HTTPS 地址。')
    }
    const directory = typeof value.directory === 'string'
        ? value.directory.trim().replace(/^\/+|\/+$/g, '')
        : 'BonjourrCloud'
    if (
        directory.length > 256 ||
        directory.split('/').some((part) =>
            !part || part === '.' || part === '..' || part.includes('\\') ||
            [...part].some((char) => char.charCodeAt(0) < 32)
        )
    ) {
        throw new HttpError(400, '备份目录名称无效。')
    }
    const username = String(value.username ?? '')
    if (username.includes(':')) throw new HttpError(400, '用户名不能包含冒号。')
    return { url: url.href.replace(/\/?$/, '/'), directory, username, password: String(value.password ?? '') }
}

async function encryptionKey(env: CloudflareEnv): Promise<CryptoKey> {
    if (!/^[a-f0-9]{64}$/.test(env.BACKUP_KEY)) throw new HttpError(503, '服务端备份加密密钥尚未配置。')
    const bytes = Uint8Array.from(env.BACKUP_KEY.match(/../g)!, (part) => Number.parseInt(part, 16))
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function saveConfig(env: AccountEnv, config: BackupConfig): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        await encryptionKey(env),
        new TextEncoder().encode(JSON.stringify(config)),
    )
    const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    await env.DB.prepare('INSERT OR REPLACE INTO account_backup_config VALUES (?, ?)')
        .bind(env.accountId, JSON.stringify({ iv: encode(iv), data: encode(new Uint8Array(encrypted)) })).run()
}

async function loadConfig(env: AccountEnv): Promise<BackupConfig | undefined> {
    const row = await env.DB.prepare('SELECT encrypted FROM account_backup_config WHERE account_id = ?').bind(
        env.accountId,
    ).first<{ encrypted: string }>()
    if (!row) return
    const stored = JSON.parse(row.encrypted)
    const decode = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
    const bytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decode(stored.iv) },
        await encryptionKey(env),
        decode(stored.data),
    )
    return configFrom(JSON.parse(new TextDecoder().decode(bytes)))
}

function davUrl(config: BackupConfig, suffix = ''): URL {
    const url = new URL(config.url)
    url.pathname += config.directory.split('/').map(encodeURIComponent).join('/') + '/' + suffix
    return url
}

function davHeaders(config: BackupConfig): Headers {
    const bytes = new TextEncoder().encode(`${config.username}:${config.password}`)
    return new Headers({
        Authorization: `Basic ${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))}`,
    })
}

async function dav(
    config: BackupConfig,
    url: URL,
    method: string,
    body?: BodyInit,
    extra?: Record<string, string>,
): Promise<Response> {
    const headers = davHeaders(config)
    for (const [key, value] of Object.entries(extra ?? {})) headers.set(key, value)
    const response = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(60000) })
    if (!response.ok && !['HEAD', 'MKCOL'].includes(method) && response.status !== 412) {
        await response.body?.cancel()
        throw new HttpError(502, `WebDAV 操作失败（HTTP ${response.status}）。`)
    }
    return response
}

async function ensureDirectory(config: BackupConfig): Promise<void> {
    const current = new URL(config.url)
    for (const part of [...config.directory.split('/'), 'assets']) {
        current.pathname += `${encodeURIComponent(part)}/`
        const response = await dav(config, current, 'MKCOL')
        if (![201, 405].includes(response.status)) {
            throw new HttpError(502, `无法创建备份目录（HTTP ${response.status}）。`)
        }
        await response.body?.cancel()
    }
}

export async function backupSettings(request: Request, env: AccountEnv): Promise<Response> {
    if (request.method === 'GET') {
        const config = await loadConfig(env)
        return Response.json(config ? { configured: true, ...config, password: undefined } : { configured: false })
    }
    if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM account_backup_config WHERE account_id = ?').bind(env.accountId).run()
        return new Response(null, { status: 204 })
    }
    if (request.method !== 'PUT') throw new HttpError(405, '请求方法无效。')
    const input = await bodyJson(request)
    const previous = await loadConfig(env)
    const config = configFrom(input)
    if (!config.password && previous?.url === config.url && previous.username === config.username) {
        config.password = previous.password
    }
    await ensureDirectory(config)
    await saveConfig(env, config)
    return Response.json({ configured: true })
}

export async function startBackup(env: AccountEnv): Promise<string> {
    if (!await loadConfig(env)) throw new HttpError(400, '请先配置服务端 WebDAV 备份。')
    const now = new Date().toISOString()
    await env.DB.prepare(
        "UPDATE account_backup_runs SET status = 'failed', error = '上次备份未完成，请重试。' WHERE account_id = ? AND status = 'running' AND created_at < ?",
    )
        .bind(env.accountId, new Date(Date.now() - 3600000).toISOString()).run()
    const id = crypto.randomUUID()
    try {
        await env.DB.prepare(
            "INSERT INTO account_backup_runs (account_id, id, created_at, status) VALUES (?, ?, ?, 'running')",
        ).bind(env.accountId, id, now)
            .run()
    } catch {
        throw new HttpError(409, '已有备份正在进行。')
    }
    return id
}

export async function backupCloud(env: AccountEnv, backupId?: string): Promise<void> {
    if (!backupId && !await loadConfig(env)) return
    let id = backupId
    try {
        id ??= await startBackup(env)
        const config = await loadConfig(env)
        if (!config) throw new HttpError(400, 'WebDAV 备份尚未配置。')
        const state = await readState(env)
        if (!state.initialized) throw new HttpError(400, '云端尚未初始化，不生成空白备份。')
        await ensureDirectory(config)
        const parts = new Set<string>()
        for (const record of state.records) {
            if (record.deleted || !(record.key.startsWith('asset/') || record.key.startsWith('icon/'))) continue
            const media: unknown = JSON.parse(record.json!)
            if (!validCloudMedia(media)) throw new HttpError(500, '媒体信息损坏。')
            for (const part of media.parts) parts.add(part.hash)
        }
        for (const hash of parts) {
            const target = davUrl(config, `assets/${hash}`)
            const exists = await dav(config, target, 'HEAD')
            await exists.body?.cancel()
            if (exists.ok) continue
            if (exists.status !== 404) throw new HttpError(502, `无法检查备份文件（HTTP ${exists.status}）。`)
            const object = await env.MEDIA.get(hash)
            if (!object) throw new HttpError(500, '云端媒体文件缺失。')
            const response = await dav(config, target, 'PUT', object.body, {
                'If-None-Match': '*',
                'Content-Type': 'application/octet-stream',
            })
            await response.body?.cancel()
        }
        const createdAt = new Date().toISOString()
        const filename = `bonjourr-${createdAt.replace(/[:.]/g, '-')}-${id}.json`
        const response = await dav(
            config,
            davUrl(config, filename),
            'PUT',
            canonical({
                format: 'bonjourr-cloud',
                version: 1,
                createdAt,
                state,
            }),
            { 'If-None-Match': '*', 'Content-Type': 'application/json; charset=utf-8' },
        )
        if (!response.ok) throw new HttpError(502, '备份文件已存在，未覆盖。')
        await response.body?.cancel()
        await env.DB.prepare(
            "UPDATE account_backup_runs SET status = 'completed', filename = ? WHERE account_id = ? AND id = ?",
        ).bind(
            filename,
            env.accountId,
            id,
        ).run()
    } catch (error) {
        if (id) {
            await env.DB.prepare(
                "UPDATE account_backup_runs SET status = 'failed', error = ? WHERE account_id = ? AND id = ?",
            )
                .bind(
                    error instanceof HttpError ? error.message : '无法连接 WebDAV，请检查地址与凭据。',
                    env.accountId,
                    id,
                ).run()
        }
        console.error('cloud_backup_failed', {
            id,
            message: error instanceof HttpError ? error.message : 'network_or_storage_error',
        })
    }
}

export async function restoreCloudBackup(
    env: AccountEnv,
    deviceId: string,
    id: string,
    externalFilename?: string,
): Promise<CloudState> {
    const run = await env.DB.prepare(
        "SELECT filename FROM account_backup_runs WHERE account_id = ? AND id = ? AND status = 'completed'",
    ).bind(env.accountId, id)
        .first<{ filename: string }>()
    const config = await loadConfig(env)
    const filename = externalFilename ?? run?.filename
    if (!filename || !config || !/^bonjourr-[\w.-]+\.json$/.test(filename)) throw new HttpError(404, '备份不存在。')
    const response = await dav(config, davUrl(config, filename), 'GET')
    const backup = JSON.parse(new TextDecoder().decode(await boundedBody(response)))
    if (
        backup.format !== 'bonjourr-cloud' || backup.version !== 1 || !backup.state?.initialized ||
        !Array.isArray(backup.state.records)
    ) {
        throw new HttpError(400, '云端备份格式无效。')
    }
    const source = parseChanges(
        backup.state.records.map((record: { key: string; json: string | null; deleted: boolean }) => ({
            key: record.key,
            json: record.json,
            deleted: record.deleted,
            baseRevision: 0,
        })),
    )
    const current = await readState(env)
    const wanted = new Map(source.map((record) => [record.key, record]))
    const changes: CloudChange[] = []
    for (const record of current.records) {
        const target = wanted.get(record.key)
        wanted.delete(record.key)
        if (record.json === (target?.json ?? null) && record.deleted === (target?.deleted ?? true)) continue
        changes.push({
            key: record.key,
            json: target?.json ?? null,
            deleted: target?.deleted ?? true,
            baseRevision: record.revision,
        })
    }
    for (const record of wanted.values()) if (!record.deleted) changes.push(record)
    for (const change of changes) {
        if (change.deleted || !(change.key.startsWith('asset/') || change.key.startsWith('icon/'))) continue
        const media: unknown = JSON.parse(change.json!)
        if (!validCloudMedia(media)) throw new HttpError(400, '媒体备份格式无效。')
        for (const part of media.parts) {
            if (await env.MEDIA.head(part.hash)) continue
            const asset = await dav(config, davUrl(config, `assets/${part.hash}`), 'GET')
            const bytes = await boundedBody(asset, CLOUD_CHUNK_BYTES)
            if (bytes.length !== part.bytes || await sha256(bytes) !== part.hash) {
                throw new HttpError(400, '备份媒体校验失败。')
            }
            await env.MEDIA.put(part.hash, bytes)
        }
    }
    return await commitChanges(env, deviceId, crypto.randomUUID(), changes, !current.initialized, true)
}
