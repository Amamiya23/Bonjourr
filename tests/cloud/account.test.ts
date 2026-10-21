import { assertEquals, assertRejects } from '@std/assert'
import '../init.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import { storage } from '../../src/scripts/storage.ts'
import { cloudAccountAccess, connectAccount } from '../../src/scripts/features/synchronization/cloud-account.ts'
import type { CloudConnection } from '../../src/scripts/shared/cloud.ts'

const account: CloudConnection = {
    url: 'https://cloud.example',
    token: 'a'.repeat(64),
    deviceId: 'old',
    name: 'Test',
    owner: true,
    accountId: 'legacy',
    username: 'admin',
    admin: true,
    expiresAt: Date.now() + 86400000,
}

async function fixture(run: () => Promise<void>): Promise<void> {
    const originalFetch = globalThis.fetch
    const originalBody = document.body.innerHTML
    const originalReload = location.reload
    const originalCaches = globalThis.caches
    const saved = Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!]))
    try {
        localStorage.clear()
        localStorage.bonjourr = JSON.stringify(SYNC_DEFAULT)
        storage.type.init()
        location.reload = () => {}
        Object.defineProperty(globalThis, 'caches', {
            configurable: true,
            value: {
                open: () =>
                    Promise.resolve({
                        match: () => Promise.resolve(undefined),
                        put: () => Promise.resolve(),
                        delete: () => Promise.resolve(true),
                        keys: () => Promise.resolve([]),
                    }),
            },
        })
        await run()
    } finally {
        globalThis.fetch = originalFetch
        location.reload = originalReload
        Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches })
        document.body.innerHTML = originalBody
        document.body.classList.remove('account-required')
        localStorage.clear()
        for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value)
    }
}

Deno.test('Logging in again preserves same-account offline changes and pending requests', () =>
    fixture(async () => {
        const pending = { id: crypto.randomUUID(), changes: [] }
        await storage.local.set({
            cloud: { ...account, token: '', expiresAt: 0, baseline: { initialized: true, records: [] }, pending },
            cloudCacheAccount: 'legacy',
        })
        await storage.sync.set({ tabtitle: 'Offline edit' })
        globalThis.fetch = (() =>
            Promise.resolve(Response.json({ ...account, token: 'b'.repeat(64), deviceId: 'new' }))) as typeof fetch
        await connectAccount(account.url, 'admin', 'private-password', false, 'Phone')
        const saved = (await storage.local.get('cloud')).cloud!
        assertEquals(saved.pending, pending)
        assertEquals(saved.token, 'b'.repeat(64))
        assertEquals((await storage.sync.get()).tabtitle, 'Offline edit')
        assertEquals(JSON.stringify(saved).includes('private-password'), false)
    }))

Deno.test('Switching accounts clears the previous account cache before opening an empty workspace', () =>
    fixture(async () => {
        await storage.local.set({ cloud: account, cloudCacheAccount: 'legacy', weatherApiKey: 'previous-secret' })
        await storage.sync.set({ tabtitle: 'Previous private title' })
        globalThis.fetch = ((url) =>
            Promise.resolve(Response.json(
                String(url).includes('auth/login')
                    ? { ...account, accountId: '11111111-1111-4111-8111-111111111111', username: 'other', admin: false }
                    : { initialized: false, records: [] },
            ))) as typeof fetch
        await connectAccount(account.url, 'other', 'another-password', false, 'Phone')
        assertEquals((await storage.sync.get()).tabtitle, SYNC_DEFAULT.tabtitle)
        assertEquals((await storage.local.get('weatherApiKey')).weatherApiKey ?? '', '')
        assertEquals((await storage.local.get('cloud')).cloud?.baseline, undefined)
    }))

Deno.test('Failed login keeps the current account data and authorization intact', () =>
    fixture(async () => {
        await storage.local.set({ cloud: account })
        globalThis.fetch = (() =>
            Promise.resolve(Response.json({ error: '用户名或密码错误。' }, { status: 401 }))) as typeof fetch
        await assertRejects(
            () => connectAccount(account.url, 'admin', 'incorrect', false, 'Phone'),
            Error,
            '用户名或密码错误',
        )
        assertEquals((await storage.local.get('cloud')).cloud, account)
    }))

Deno.test('A new browser downloads the account homepage immediately after login', () =>
    fixture(async () => {
        globalThis.fetch = ((url) =>
            Promise.resolve(Response.json(
                String(url).includes('auth/login') ? account : {
                    initialized: true,
                    records: [
                        { key: 'sync/tabtitle', json: '"My cloud homepage"', revision: 1, deleted: false },
                        { key: 'sync/linkgroups/groups', json: '["default","work"]', revision: 1, deleted: false },
                    ],
                },
            ))) as typeof fetch
        await connectAccount(account.url, 'admin', 'private-password', false, 'New browser')
        assertEquals((await storage.sync.get()).tabtitle, 'My cloud homepage')
        assertEquals((await storage.local.get('cloud')).cloud?.baseline?.initialized, true)
    }))

Deno.test('Expired sessions show the login gate and hide registration when it is disabled', () =>
    fixture(async () => {
        const html = await Deno.readTextFile(new URL('../../src/index.html', import.meta.url))
        document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
        globalThis.fetch = (() =>
            Promise.resolve(
                Response.json({ registrationOpen: false, firstAccount: false, setupRequired: false }),
            )) as typeof fetch
        assertEquals(
            await cloudAccountAccess(
                { cloud: { ...account, expiresAt: 0 } } as Parameters<typeof cloudAccountAccess>[0],
            ),
            false,
        )
        assertEquals(document.getElementById('cloud-auth-gate')!.hidden, false)
        assertEquals(document.body.classList.contains('account-required'), true)
        assertEquals(document.getElementById('account-mode')!.hidden, true)
        assertEquals(document.querySelector<HTMLInputElement>('#account-password')!.value, '')
    }))
