import { PLATFORM, SYNC_DEFAULT } from '../../defaults.ts'
import { storage } from '../../storage.ts'
import { DEFAULT_CLOUD_SERVER } from '../../shared/cloud.ts'
import type { CloudConnection } from '../../shared/cloud.ts'
import type { Local } from '../../../types/local.ts'
import { requestOrigin } from '../../shared/network.ts'
import { cloudJson, CloudRequestError, cloudServer } from './cloud-api.ts'
import { adoptCloud } from './cloud-sync.ts'

export interface AccountConfig {
    registrationOpen: boolean
    firstAccount: boolean
    setupRequired: boolean
}

export function defaultAccountServer(): string {
    if (
        location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname) &&
        location.port === '8787'
    ) {
        return location.origin
    }
    return location.protocol === 'https:' && !location.hostname.endsWith('.pages.dev')
        ? cloudServer(location.origin)
        : DEFAULT_CLOUD_SERVER
}

function watchAccount(accountId: string): void {
    const check = async (): Promise<void> => {
        const current = (await storage.local.get('cloud')).cloud
        if (
            current?.accountId !== accountId || !current.token || !current.expiresAt || current.expiresAt <= Date.now()
        ) {
            location.reload()
        }
    }
    globalThis.addEventListener('storage', (event) => {
        if (event.key === 'cloud' || event.key === null) void check()
    })
    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
        if (area === 'local' && changes.cloud) void check()
    })
}

async function resetAccountCache(): Promise<void> {
    await storage.sync.clear()
    await storage.sync.set(structuredClone(SYNC_DEFAULT))
    const local = await storage.local.get()
    for (
        const key of [
            'weatherApiKey',
            'weatherApiOrigin',
            'backgroundFiles',
            'backgroundUrls',
            'backgroundCompressFiles',
        ] as const
    ) {
        await storage.local.remove(key)
    }
    for (const key of Object.keys(local)) {
        if (key.startsWith('x-icon-')) await storage.local.remove(key as `x-icon-${string}`)
    }
}

export async function connectAccount(
    url: string,
    username: string,
    password: string,
    registering: boolean,
    name: string,
): Promise<void> {
    url = cloudServer(url.trim())
    await requestOrigin(url)
    const local = await storage.local.get(['cloud', 'cloudCacheAccount'])
    const result = await cloudJson<Omit<CloudConnection, 'url'>>(
        { url, token: registering && !local.cloud?.accountId ? local.cloud?.token ?? '' : '' },
        registering ? 'auth/register' : 'auth/login',
        { username, password, name },
    )
    if (!result.accountId || !result.username || !result.expiresAt || !result.token) throw new Error('登录响应无效。')
    const previous = local.cloud
    const sameAccount = previous?.accountId === result.accountId ||
        (result.accountId === 'legacy' && !!previous && !previous.accountId)
    if (local.cloudCacheAccount && local.cloudCacheAccount !== result.accountId) await resetAccountCache()
    const connection: CloudConnection = {
        ...(sameAccount ? previous : {}),
        ...result,
        url,
        error: undefined,
    }
    await storage.type.change('local', await storage.sync.get())
    await storage.local.set({ cloud: connection, cloudCacheAccount: result.accountId, syncType: 'cloud' })
    if (!connection.baseline?.initialized) {
        const state = await cloudJson<{ initialized: boolean }>(connection, 'state')
        if (state.initialized) {
            await adoptCloud()
            return
        }
    }
    location.reload()
}

export async function cloudAccountAccess(local: Local): Promise<boolean> {
    if (PLATFORM !== 'online' && local.syncType !== 'cloud') return true
    const saved = local.cloud
    if (saved?.accountId && saved.expiresAt && saved.expiresAt > Date.now()) {
        try {
            const profile = await cloudJson<Omit<CloudConnection, 'url' | 'token'>>(saved, 'auth/me')
            const connection = { ...saved, ...profile, url: cloudServer(saved.url) }
            await storage.local.set({ cloud: connection, syncType: 'cloud', cloudCacheAccount: connection.accountId })
            local.cloud = connection
            local.syncType = 'cloud'
            watchAccount(connection.accountId!)
            return true
        } catch (error) {
            if (!(error instanceof CloudRequestError) || error.status !== 401) {
                watchAccount(saved.accountId)
                return true
            }
        }
    }
    if (saved && local.syncType === 'cloud') {
        const connection = {
            ...saved,
            token: '',
            expiresAt: 0,
            error: '登录状态已过期，请在设置中重新登录。',
        }
        await storage.local.set({ cloud: connection, syncType: 'off' })
        local.cloud = connection
        local.syncType = 'off'
    }
    return true
}
