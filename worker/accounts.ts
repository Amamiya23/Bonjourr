import { sha256 } from '../src/scripts/shared/cloud.ts'
import { bodyJson, boundedBody, HttpError, randomToken } from './http.ts'

const SESSION_MS = 30 * 86400000

export interface Device {
    id: string
    name: string
    account_id: string
    username: string
    role: 'admin' | 'user'
    expires_at: number
}

interface Account {
    id: string
    username: string
    role: 'admin' | 'user'
    password_hash: string
    password_salt: string
}

async function passwordHash(password: string, salt: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
        'deriveBits',
    ])
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            hash: 'SHA-256',
            iterations: 100000,
            salt: new TextEncoder().encode(salt),
        },
        key,
        256,
    )
    return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function matches(provided: string, expected: string): Promise<boolean> {
    return crypto.subtle.timingSafeEqual(
        new TextEncoder().encode(await sha256(provided)),
        new TextEncoder().encode(await sha256(expected)),
    )
}

async function inputFrom(request: Request): Promise<Record<string, unknown>> {
    try {
        const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 4096)))
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error()
        return input
    } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(400, '请求格式无效。')
    }
}

function credentials(input: Record<string, unknown>, registering = false): { username: string; password: string } {
    const username = typeof input.username === 'string' ? input.username.trim().normalize('NFKC') : ''
    const password = typeof input.password === 'string' ? input.password : ''
    if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) throw new HttpError(400, '用户名需为 3–32 个字母、数字或 ._-。')
    if (password.length > 128 || password.length < (registering ? 12 : 1)) {
        throw new HttpError(400, registering ? '密码需为 12–128 个字符。' : '请输入密码。')
    }
    return { username, password }
}

async function limit(request: Request, env: CloudflareEnv, username: string): Promise<void> {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
    const now = Date.now()
    const keys = [await sha256(`ip:${ip}`), await sha256(`login:${username.toLowerCase()}`)]
    const result = await env.DB.batch(keys.map((key) =>
        env.DB.prepare(`
        INSERT INTO auth_limits (key, attempts, expires_at) VALUES (?, 1, ?)
        ON CONFLICT (key) DO UPDATE SET
            attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
            expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
        RETURNING attempts`).bind(key, now + 900000, now, now)
    ))
    if (result.some((row, index) => Number((row.results[0] as { attempts: number }).attempts) > (index ? 10 : 40))) {
        throw new HttpError(429, '尝试次数过多，请 15 分钟后重试。')
    }
    await env.DB.prepare('DELETE FROM auth_limits WHERE expires_at < ?').bind(now - 86400000).run()
}

export async function authenticate(request: Request, env: CloudflareEnv): Promise<Device> {
    const authorization = request.headers.get('Authorization') ?? ''
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) throw new HttpError(401, '请先登录。')
    const device = await env.DB.prepare(`SELECT d.id, d.name, d.account_id, a.username, a.role, d.expires_at
        FROM devices d JOIN accounts a ON a.id = d.account_id
        WHERE d.token_hash = ? AND d.revoked_at IS NULL AND d.expires_at > ? AND a.disabled_at IS NULL`)
        .bind(await sha256(authorization.slice(7)), Date.now()).first<Device>()
    if (!device) throw new HttpError(401, '登录已失效，请重新登录。')
    return device
}

export function requireAdmin(device: Device): void {
    if (device.role !== 'admin') throw new HttpError(403, '此操作需要管理员权限。')
}

async function setupProtected(env: CloudflareEnv): Promise<boolean> {
    const row = await env.DB.prepare(`SELECT (SELECT initialized FROM account_state WHERE account_id = 'legacy')
        OR EXISTS (SELECT 1 FROM devices WHERE account_id = 'legacy' AND revoked_at IS NULL)
        OR EXISTS (SELECT 1 FROM account_records WHERE account_id = 'legacy')
        OR EXISTS (SELECT 1 FROM account_backup_config WHERE account_id = 'legacy') AS protected`)
        .first<{ protected: number }>()
    return !!row?.protected
}

export async function authConfig(env: CloudflareEnv): Promise<Response> {
    const row = await env.DB.prepare(`SELECT registration_open,
        NOT EXISTS (SELECT 1 FROM accounts) AS first_account FROM account_settings WHERE id = 1`)
        .first<{ registration_open: number; first_account: number }>()
    const setupRequired = !!row?.first_account && await setupProtected(env)
    return Response.json({
        registrationOpen: !setupRequired && (!!row?.registration_open || !!row?.first_account),
        firstAccount: !!row?.first_account,
        setupRequired,
    })
}

function sessionResponse(
    account: Pick<Account, 'id' | 'username' | 'role'>,
    id: string,
    name: string,
    token: string,
    expiresAt: number,
): Response {
    return Response.json({
        token,
        deviceId: id,
        name,
        owner: true,
        accountId: account.id,
        username: account.username,
        admin: account.role === 'admin',
        expiresAt,
    })
}

function deviceName(input: Record<string, unknown>): string {
    return typeof input.name === 'string' ? input.name.trim().slice(0, 80) || '浏览器' : '浏览器'
}

export async function register(request: Request, env: CloudflareEnv): Promise<Response> {
    const input = await inputFrom(request)
    const { username, password } = credentials(input, true)
    await limit(request, env, username)
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM accounts').first<{ count: number }>()
    const first = count?.count === 0
    if (first && await setupProtected(env)) {
        const provided = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
        let authorized = !!env.OWNER_KEY && await matches(provided, env.OWNER_KEY)
        if (!authorized && /^[a-f0-9]{64}$/.test(provided)) {
            authorized = !!await env.DB.prepare(`SELECT id FROM devices WHERE token_hash = ? AND owner = 1
                AND account_id = 'legacy' AND revoked_at IS NULL`).bind(await sha256(provided)).first()
        }
        if (!authorized) throw new HttpError(403, '已有云端数据，请先在原管理设备上建立管理员账号。')
    }
    const id = first ? 'legacy' : crypto.randomUUID()
    const salt = randomToken()
    const hash = await passwordHash(password, salt)
    const token = randomToken()
    const sessionId = crypto.randomUUID()
    const expiresAt = Date.now() + SESSION_MS
    const name = deviceName(input)
    const now = new Date().toISOString()
    const result = await env.DB.batch([
        env.DB.prepare(`INSERT INTO accounts (id, username, login_name, password_hash, password_salt, role, created_at)
            SELECT ?, ?, ?, ?, ?, CASE WHEN NOT EXISTS (SELECT 1 FROM accounts) THEN 'admin' ELSE 'user' END, ?
            WHERE NOT EXISTS (SELECT 1 FROM accounts) OR (SELECT registration_open FROM account_settings WHERE id = 1) = 1`)
            .bind(id, username, username.toLowerCase(), hash, salt, now),
        env.DB.prepare('INSERT OR IGNORE INTO account_state (account_id) SELECT id FROM accounts WHERE id = ?').bind(
            id,
        ),
        env.DB.prepare(`UPDATE devices SET revoked_at = ? WHERE account_id = 'legacy' AND expires_at IS NULL
            AND EXISTS (SELECT 1 FROM accounts WHERE id = ?)`).bind(now, id),
        env.DB.prepare(`INSERT INTO devices (id, name, token_hash, owner, created_at, account_id, expires_at)
            SELECT ?, ?, ?, 1, ?, id, ? FROM accounts WHERE id = ?`)
            .bind(sessionId, name, await sha256(token), now, expiresAt, id),
    ]).catch((error) => {
        if (String(error).includes('UNIQUE constraint')) {
            throw new HttpError(409, '用户名不可用或注册状态已变化，请重试。')
        }
        throw error
    })
    if (result[0].meta.changes !== 1) throw new HttpError(403, '管理员已关闭注册。')
    return sessionResponse({ id, username, role: first ? 'admin' : 'user' }, sessionId, name, token, expiresAt)
}

export async function login(request: Request, env: CloudflareEnv): Promise<Response> {
    const input = await inputFrom(request)
    const { username, password } = credentials(input)
    await limit(request, env, username)
    const account = await env.DB.prepare(`SELECT id, username, role, password_hash, password_salt FROM accounts
        WHERE login_name = ? AND disabled_at IS NULL`).bind(username.toLowerCase()).first<Account>()
    const actual = await passwordHash(password, account?.password_salt ?? 'invalid-account-salt')
    if (!account || !await matches(actual, account.password_hash)) throw new HttpError(401, '用户名或密码错误。')
    const token = randomToken()
    const id = crypto.randomUUID()
    const name = deviceName(input)
    const expiresAt = Date.now() + SESSION_MS
    await env.DB.batch([
        env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE expires_at < ? AND revoked_at IS NULL')
            .bind(new Date().toISOString(), Date.now()),
        env.DB.prepare(`INSERT INTO devices (id, name, token_hash, owner, created_at, account_id, expires_at)
            VALUES (?, ?, ?, 1, ?, ?, ?)`)
            .bind(id, name, await sha256(token), new Date().toISOString(), account.id, expiresAt),
    ])
    return sessionResponse(account, id, name, token, expiresAt)
}

export async function changePassword(request: Request, env: CloudflareEnv, device: Device): Promise<Response> {
    const input = await inputFrom(request)
    const password = credentials({ username: device.username, password: input.password }, true).password
    const previous = typeof input.currentPassword === 'string' ? input.currentPassword : ''
    if (!previous || previous.length > 128) throw new HttpError(400, '请输入当前密码。')
    await limit(request, env, device.username)
    const account = await env.DB.prepare('SELECT password_hash, password_salt FROM accounts WHERE id = ?')
        .bind(device.account_id).first<Account>()
    if (!account || !await matches(await passwordHash(previous, account.password_salt), account.password_hash)) {
        throw new HttpError(400, '当前密码错误。')
    }
    const salt = randomToken()
    const hash = await passwordHash(password, salt)
    const token = randomToken()
    const expiresAt = Date.now() + SESSION_MS
    const result = await env.DB.batch([
        env.DB.prepare('UPDATE accounts SET password_hash = ?, password_salt = ? WHERE id = ? AND password_hash = ?')
            .bind(hash, salt, device.account_id, account.password_hash),
        env.DB.prepare(`UPDATE devices SET revoked_at = ? WHERE account_id = ? AND id != ?
            AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND password_hash = ?)`)
            .bind(new Date().toISOString(), device.account_id, device.id, device.account_id, hash),
        env.DB.prepare(`UPDATE devices SET token_hash = ?, expires_at = ? WHERE id = ? AND account_id = ?
            AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND password_hash = ?)`)
            .bind(await sha256(token), expiresAt, device.id, device.account_id, device.account_id, hash),
    ])
    if (result[0].meta.changes !== 1) throw new HttpError(409, '密码已发生变化，请重新登录。')
    return sessionResponse(
        { id: device.account_id, username: device.username, role: device.role },
        device.id,
        device.name,
        token,
        expiresAt,
    )
}

export async function registrationSettings(request: Request, env: CloudflareEnv, device: Device): Promise<Response> {
    requireAdmin(device)
    if (request.method === 'PUT') {
        const input = await bodyJson(request)
        if (typeof input.registrationOpen !== 'boolean') throw new HttpError(400, '注册设置无效。')
        await env.DB.prepare('UPDATE account_settings SET registration_open = ? WHERE id = 1')
            .bind(input.registrationOpen ? 1 : 0).run()
    } else if (request.method !== 'GET') throw new HttpError(405, '请求方法无效。')
    return await authConfig(env)
}
