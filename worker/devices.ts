import { bodyJson, HttpError } from './http.ts'
import type { AccountEnv } from './scope.ts'

export async function renameDevice(request: Request, env: AccountEnv, id: string): Promise<Response> {
    const input = await bodyJson(request)
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 80) throw new HttpError(400, '设备名称需为 1–80 个字符。')
    const result = await env.DB.prepare(`UPDATE devices SET name = ?
        WHERE id = ? AND account_id = ? AND revoked_at IS NULL AND expires_at > ?`)
        .bind(name, id, env.accountId, Date.now()).run()
    if (result.meta.changes !== 1) throw new HttpError(404, '设备不存在或登录已失效，请刷新设备列表。')
    return Response.json({ id, name })
}
