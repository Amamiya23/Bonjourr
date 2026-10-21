import { assertEquals } from '@std/assert'
import '../init.ts'
import { storage } from '../../src/scripts/storage.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import { cloudDevices } from '../../src/scripts/features/synchronization/cloud-devices.ts'
import type { CloudConnection } from '../../src/scripts/shared/cloud.ts'

const settings = await Deno.readTextFile(new URL('../../src/settings.html', import.meta.url))
const connection: CloudConnection = {
    url: 'https://cloud.example',
    token: 'a'.repeat(64),
    deviceId: 'own',
    name: 'My computer',
    owner: true,
    accountId: 'legacy',
    username: 'admin',
    expiresAt: Date.now() + 86400000,
    baseline: { initialized: true, records: [] },
    pending: { id: 'keep-pending-request', changes: [] },
}

interface Fixture {
    requests: { url: string; method: string; name?: string }[]
    failSave: boolean
    wait: () => Promise<void>
}

async function fixture(run: (state: Fixture) => Promise<void>): Promise<void> {
    const originalFetch = globalThis.fetch
    const originalBody = document.body.innerHTML
    const saved = Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!]))
    let pending = Promise.resolve()
    const state: Fixture = { requests: [], failSave: false, wait: () => pending }
    try {
        document.body.innerHTML = settings
        localStorage.clear()
        localStorage.bonjourr = JSON.stringify(SYNC_DEFAULT)
        storage.type.init()
        await storage.local.set({ cloud: structuredClone(connection), syncType: 'cloud' })
        globalThis.fetch = (async (input, options) => {
            const url = String(input)
            const method = options?.method ?? 'GET'
            const name = options?.body ? JSON.parse(String(options.body)).name : undefined
            state.requests.push({ url, method, name })
            if (method === 'GET') {
                return Response.json([
                    { id: 'own', name: 'My computer', created_at: '2026-10-21T00:00:00Z' },
                    { id: 'phone', name: 'My phone', created_at: '2026-10-20T00:00:00Z' },
                    { id: 'revoked', name: 'Old device', revoked_at: '2026-10-21T00:00:00Z' },
                ])
            }
            if (state.failSave) return Response.json({ error: '保存失败，请重试。' }, { status: 500 })
            return Response.json({ id: url.split('/').at(-1), name })
        }) as typeof fetch
        cloudDevices((action) => {
            const buttons = document.querySelectorAll<HTMLButtonElement>('#cloud-sync button')
            buttons.forEach((button) => button.disabled = true)
            pending = action().finally(() => buttons.forEach((button) => button.disabled = false))
            return pending
        })
        document.getElementById('cloud-devices-refresh')!.click()
        await state.wait()
        await run(state)
    } finally {
        globalThis.fetch = originalFetch
        document.body.innerHTML = originalBody
        localStorage.clear()
        for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value)
    }
}

Deno.test('Devices list identifies this device, hides revoked sessions and protects its revoke action', () =>
    fixture(async () => {
        assertEquals(document.querySelectorAll('.cloud-device').length, 2)
        const own = document.querySelector<HTMLElement>('[data-device-id="own"]')!
        const phone = document.querySelector<HTMLElement>('[data-device-id="phone"]')!
        assertEquals(own.querySelector<HTMLElement>('.cloud-device-current')!.hidden, false)
        assertEquals(own.querySelector<HTMLButtonElement>('[data-action="revoke"]')!.hidden, true)
        assertEquals(phone.querySelector<HTMLElement>('.cloud-device-current')!.hidden, true)
        assertEquals(phone.querySelector<HTMLButtonElement>('[data-action="revoke"]')!.hidden, false)
    }))

Deno.test('Renaming this device preserves session and sync state and returns keyboard focus', () =>
    fixture(async (state) => {
        const row = document.querySelector<HTMLElement>('[data-device-id="own"]')!
        const rename = row.querySelector<HTMLButtonElement>('[data-action="rename"]')!
        rename.click()
        const form = row.querySelector<HTMLFormElement>('form')!
        const input = form.querySelector<HTMLInputElement>('input')!
        assertEquals(form.hidden, false)
        input.value = '  工作电脑  '
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await state.wait()
        const saved = (await storage.local.get('cloud')).cloud!
        assertEquals(saved, { ...connection, name: '工作电脑' })
        assertEquals(state.requests.at(-1), {
            url: 'https://cloud.example/api/devices/own',
            method: 'PUT',
            name: '工作电脑',
        })
        assertEquals(row.querySelector('.cloud-device-name')!.textContent, '工作电脑')
        assertEquals(document.querySelector<HTMLInputElement>('#cloud-device-name')!.value, '工作电脑')
        assertEquals(form.hidden, true)
        assertEquals(document.activeElement, rename)
    }))

Deno.test('A failed rename retains the editor and can be retried without changing this device', () =>
    fixture(async (state) => {
        const row = document.querySelector<HTMLElement>('[data-device-id="phone"]')!
        row.querySelector<HTMLButtonElement>('[data-action="rename"]')!.click()
        const form = row.querySelector<HTMLFormElement>('form')!
        const input = form.querySelector<HTMLInputElement>('input')!
        input.value = '手机'
        state.failSave = true
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await state.wait()
        assertEquals(form.hidden, false)
        assertEquals(input.value, '手机')
        assertEquals(row.querySelector('.cloud-device-name')!.textContent, 'My phone')
        assertEquals(row.querySelector('.cloud-device-status')!.textContent, '保存失败，请重试。')
        state.failSave = false
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await state.wait()
        assertEquals(row.querySelector('.cloud-device-name')!.textContent, '手机')
        assertEquals((await storage.local.get('cloud')).cloud!.name, connection.name)
    }))

Deno.test('Empty names are rejected locally and Escape cancels without submitting', () =>
    fixture(async (state) => {
        const row = document.querySelector<HTMLElement>('[data-device-id="own"]')!
        const rename = row.querySelector<HTMLButtonElement>('[data-action="rename"]')!
        rename.click()
        const form = row.querySelector<HTMLFormElement>('form')!
        const input = form.querySelector<HTMLInputElement>('input')!
        input.value = '   '
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        assertEquals(input.validity.customError, true)
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        assertEquals(form.hidden, true)
        assertEquals(input.value, connection.name)
        assertEquals(state.requests.filter((request) => request.method === 'PUT').length, 0)
        assertEquals(document.activeElement, rename)
        await state.wait()
    }))
