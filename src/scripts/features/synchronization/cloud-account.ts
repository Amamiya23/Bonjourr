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
        ? location.origin
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
            const connection = { ...saved, ...profile }
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
    const gate = document.getElementById('cloud-auth-gate')
    const form = document.querySelector<HTMLFormElement>('#account-login-form')
    if (!gate || !form) return false
    gate.hidden = false
    document.body.classList.add('account-required')
    document.body.classList.remove('init', 'loading')
    const server = document.querySelector<HTMLInputElement>('#account-server')!
    const username = document.querySelector<HTMLInputElement>('#account-username')!
    const password = document.querySelector<HTMLInputElement>('#account-password')!
    const submit = document.querySelector<HTMLButtonElement>('#account-submit')!
    const toggle = document.querySelector<HTMLButtonElement>('#account-mode')!
    const status = document.getElementById('account-status')!
    server.value = saved?.url ?? defaultAccountServer()
    username.value = saved?.username ?? ''
    let registering = false
    let working = false
    let config: AccountConfig | undefined
    const showMode = (): void => {
        document.getElementById('account-heading')!.textContent = registering
            ? config?.firstAccount ? '创建管理员' : '注册'
            : '登录'
        submit.textContent = registering ? '创建账号' : '登录'
        toggle.textContent = registering ? '已有账号，登录' : '创建账号'
        password.autocomplete = registering ? 'new-password' : 'current-password'
        password.minLength = registering ? 12 : 1
        password.placeholder = registering ? '至少 12 个字符' : ''
    }
    const loadConfig = async (): Promise<void> => {
        try {
            config = await cloudJson<AccountConfig>({ url: server.value, token: '' }, 'auth/config')
            const canSetup = config.firstAccount && config.setupRequired && saved?.owner && !saved.accountId &&
                !!saved.token
            toggle.hidden = !config.registrationOpen && !canSetup
            registering = config.firstAccount && (config.registrationOpen || !!canSetup)
            status.textContent = config.setupRequired && !canSetup ? '请先在原管理设备上建立管理员账号' : ''
            showMode()
        } catch {
            status.textContent = '暂时无法连接服务器'
        }
    }
    toggle.addEventListener('click', () => {
        registering = !registering
        showMode()
    })
    server.addEventListener('change', () => void loadConfig())
    server.addEventListener('invalid', () => {
        server.closest('details')!.open = true
    })
    form.addEventListener('submit', (event) => {
        event.preventDefault()
        if (working) return
        working = true
        submit.disabled = true
        toggle.disabled = true
        form.setAttribute('aria-busy', 'true')
        status.textContent = registering ? '正在创建账号…' : '正在登录…'
        void connectAccount(
            server.value,
            username.value,
            password.value,
            registering,
            /Android|iPhone|iPad/.test(navigator.userAgent) ? '我的手机' : '我的电脑',
        ).catch((error) => {
            status.textContent = error instanceof Error ? error.message : '登录失败，请重试。'
            password.value = ''
        }).finally(() => {
            working = false
            submit.disabled = false
            toggle.disabled = false
            form.setAttribute('aria-busy', 'false')
        })
    })
    await loadConfig()
    username.focus()
    return false
}
