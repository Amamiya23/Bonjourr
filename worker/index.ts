import { CLOUD_CHUNK_BYTES, sha256, validCloudMedia } from '../src/scripts/shared/cloud.ts'
import { authConfig, authenticate, changePassword, login, register, registrationSettings } from './accounts.ts'
import { accountEnv } from './scope.ts'
import { renameDevice } from './devices.ts'
import { commitChanges, parseChanges, readState } from './database.ts'
import { bodyJson, boundedBody, HttpError } from './http.ts'
import { backupCloud, backupSettings, restoreCloudBackup, startBackup } from './webdav.ts'

export default {
    async fetch(request, env, ctx): Promise<Response> {
        const url = new URL(request.url)
        if (!url.pathname.startsWith('/api/')) return await env.ASSETS.fetch(request)
        const origin = request.headers.get('Origin')
        const allowed = !origin || origin === url.origin || env.ALLOWED_ORIGINS.split(',').includes(origin) ||
            /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || /^moz-extension:\/\/[\w-]+$/.test(origin)
        if (!allowed) return Response.json({ error: '此来源不允许访问。' }, { status: 403 })
        let response: Response
        try {
            response = request.method === 'OPTIONS'
                ? new Response(null, { status: 204 })
                : await route(request, env, ctx)
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            if (status === 500) {
                console.error('cloud_request_failed', {
                    path: url.pathname,
                    kind: error instanceof Error ? error.name : 'Error',
                })
            }
            response = Response.json({
                error: status === 500 ? '服务器暂时无法处理，请稍后重试。' : String((error as Error).message),
            }, { status })
        }
        const result = new Response(response.body, response)
        result.headers.set('Cache-Control', 'no-store')
        result.headers.set('X-Content-Type-Options', 'nosniff')
        result.headers.set('Referrer-Policy', 'no-referrer')
        result.headers.set('Vary', 'Origin')
        if (origin) result.headers.set('Access-Control-Allow-Origin', origin)
        result.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS')
        result.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        return result
    },
    scheduled(_event, env, ctx): void {
        ctx.waitUntil((async () => {
            const rows = await env.DB.prepare(`SELECT b.account_id FROM account_backup_config b
                JOIN accounts a ON a.id = b.account_id WHERE a.disabled_at IS NULL`).all<{ account_id: string }>()
            for (const row of rows.results) await backupCloud(accountEnv(env, row.account_id))
        })())
    },
} satisfies ExportedHandler<CloudflareEnv>

async function route(request: Request, root: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.slice(5)
    const method = request.method
    if (path === 'health' && method === 'GET') return Response.json({ service: 'bonjourr-cloud', version: 2 })
    if (path === 'auth/config' && method === 'GET') return await authConfig(root)
    if (path === 'auth/register' && method === 'POST') return await register(request, root)
    if (path === 'auth/login' && method === 'POST') return await login(request, root)
    if (['bootstrap', 'pair', 'pair-codes'].includes(path)) {
        throw new HttpError(410, '配对码已停用，请刷新页面并使用账号登录。')
    }
    const device = await authenticate(request, root)
    const env = accountEnv(root, device.account_id)
    if (path === 'auth/me' && method === 'GET') {
        return Response.json({
            deviceId: device.id,
            name: device.name,
            owner: true,
            accountId: device.account_id,
            username: device.username,
            admin: device.role === 'admin',
            expiresAt: device.expires_at,
        })
    }
    if (path === 'auth/password' && method === 'POST') return await changePassword(request, root, device)
    if (path === 'admin/registration') return await registrationSettings(request, root, device)
    if (path === 'state' && method === 'GET') return Response.json(await readState(env))
    if ((path === 'sync' || path === 'initialize') && method === 'POST') {
        const input = await bodyJson(request)
        const changes = parseChanges(input.changes)
        const state = await readState(env)
        const links = state.records.filter((record) =>
            !record.deleted && record.key.startsWith('sync/') &&
            record.json && typeof JSON.parse(record.json)?._id === 'string'
        )
        if (
            links.length && links.every((record) =>
                changes.some((change) => change.key === record.key && change.deleted)
            ) &&
            input.confirmClear !== true
        ) throw new HttpError(409, '清空全部快捷链接需要在界面中明确确认。')
        // Only publish manifests after every referenced immutable media part exists.
        for (const change of changes) {
            if (change.deleted || !(change.key.startsWith('asset/') || change.key.startsWith('icon/'))) continue
            const media: unknown = JSON.parse(change.json!)
            if (!validCloudMedia(media)) throw new HttpError(400, '媒体描述无效。')
            for (const part of media.parts) {
                const stored = await env.MEDIA.head(part.hash)
                if (stored?.size !== part.bytes) throw new HttpError(409, '媒体尚未上传完成，请重试。')
            }
        }
        return Response.json(
            await commitChanges(
                env,
                device.id,
                String(input.id),
                changes,
                path === 'initialize',
                input.confirmClear === true,
            ),
        )
    }
    const asset = /^assets\/([a-f0-9]{64})$/.exec(path)
    if (asset) {
        const hash = asset[1]
        if (method === 'HEAD') return new Response(null, { status: await env.MEDIA.head(hash) ? 200 : 404 })
        if (method === 'PUT') {
            const bytes = await boundedBody(request, CLOUD_CHUNK_BYTES)
            if (!bytes.length || await sha256(bytes) !== hash) throw new HttpError(400, '媒体摘要不匹配。')
            await env.MEDIA.put(hash, bytes, { httpMetadata: { contentType: 'application/octet-stream' } })
            return new Response(null, { status: 204 })
        }
        if (method === 'GET') {
            const object = await env.MEDIA.get(hash)
            if (!object) throw new HttpError(404, '媒体资源不存在。')
            return new Response(object.body, {
                headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size) },
            })
        }
    }
    if (path === 'devices' && method === 'GET') {
        return Response.json(
            (await env.DB.prepare(
                'SELECT id, name, created_at, revoked_at FROM devices WHERE account_id = ? AND expires_at > ? ORDER BY created_at DESC',
            ).bind(env.accountId, Date.now()).all()).results,
        )
    }
    if (path.startsWith('devices/') && method === 'PUT') return await renameDevice(request, env, path.slice(8))
    if (path.startsWith('devices/') && method === 'DELETE') {
        const id = path.slice(8)
        if (id === device.id) throw new HttpError(400, '请使用断开连接退出当前设备。')
        await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ?')
            .bind(new Date().toISOString(), id, env.accountId).run()
        return new Response(null, { status: 204 })
    }
    if ((path === 'disconnect' || path === 'auth/logout') && method === 'POST') {
        await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ?').bind(
            new Date().toISOString(),
            device.id,
            env.accountId,
        )
            .run()
        return new Response(null, { status: 204 })
    }
    if (path === 'history' && method === 'GET') {
        const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER)
        return Response.json(
            (await env.DB.prepare(
                'SELECT h.*, d.name AS device_name FROM account_history h LEFT JOIN devices d ON d.id = h.device_id AND d.account_id = h.account_id WHERE h.account_id = ? AND h.id < ? ORDER BY h.id DESC LIMIT 100',
            ).bind(env.accountId, before).all()).results,
        )
    }
    if (path === 'history/restore' && method === 'POST') {
        const input = await bodyJson(request)
        const item = await env.DB.prepare(
            'SELECT key, json, deleted FROM account_history WHERE account_id = ? AND id = ?',
        ).bind(env.accountId, Number(input.id))
            .first<{
                key: string
                json: string | null
                deleted: number
            }>()
        if (!item) throw new HttpError(404, '历史记录不存在。')
        const state = await readState(env)
        const current = state.records.find((record) => record.key === item.key)
        if (input.baseRevision !== current?.revision) throw new HttpError(409, '此项已被其他设备修改，请刷新历史记录。')
        return Response.json(
            await commitChanges(
                env,
                device.id,
                crypto.randomUUID(),
                [{
                    key: item.key,
                    json: item.json,
                    deleted: !!item.deleted,
                    baseRevision: current?.revision ?? 0,
                }],
                false,
                input.confirmClear === true,
            ),
        )
    }
    if (path === 'backup/config') {
        return await backupSettings(request, env)
    }
    if (path === 'backups' && method === 'GET') {
        return Response.json(
            (await env.DB.prepare(
                'SELECT * FROM account_backup_runs WHERE account_id = ? ORDER BY created_at DESC LIMIT 50',
            ).bind(env.accountId).all()).results,
        )
    }
    if (path === 'backups' && method === 'POST') {
        const id = await startBackup(env)
        ctx.waitUntil(backupCloud(env, id))
        return Response.json({ id }, { status: 202 })
    }
    if (path === 'backups/restore' && method === 'POST') {
        const input = await bodyJson(request)
        return Response.json(await restoreCloudBackup(env, device.id, String(input.id)))
    }
    if (path === 'backups/import' && method === 'POST') {
        const input = await bodyJson(request)
        return Response.json(await restoreCloudBackup(env, device.id, '', String(input.filename)))
    }
    throw new HttpError(404, '接口不存在。')
}
