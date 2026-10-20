import { assertEquals, assertRejects } from '@std/assert'
import '../init.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import { storage } from '../../src/scripts/storage.ts'
import { backupIconName, createBackup, webdavFingerprint } from '../../src/scripts/features/synchronization/backup.ts'
import {
    saveWebdavSync,
    syncWebdavNow,
    withWebdavLock,
} from '../../src/scripts/features/synchronization/webdav-auto.ts'
import type { Backup } from '../../src/scripts/features/synchronization/backup.ts'
import type { WebdavConfig } from '../../src/types/local.ts'

const config: WebdavConfig = {
    url: 'https://example.com/dav/',
    directory: 'Bonjourr',
    username: 'local-user',
    password: 'local-password',
    autoSync: true,
}
const collectionXml =
    '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'

interface Fixture {
    remote?: { backup: Backup; etag?: string }
    requests: { method: string; path: string; headers: Headers }[]
    reloads: number
    status?: number
    beforeRequest?: (method: string, path: string) => Promise<void>
    establish: () => Promise<void>
}

async function fixture(run: (state: Fixture) => Promise<void>): Promise<void> {
    const originalFetch = globalThis.fetch
    const originalCaches = globalThis.caches
    const originalReload = globalThis.location.reload
    const originalStorage = Object.fromEntries(
        Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!]),
    )
    const entries = new Map<string, Response>()
    const cache = {
        put: (key: string | Request, response: Response) => {
            entries.set(typeof key === 'string' ? key : key.url, response.clone())
            return Promise.resolve()
        },
        match: (key: string) => Promise.resolve(entries.get(key)?.clone()),
        delete: (key: Request) => Promise.resolve(entries.delete(key.url)),
        keys: () => Promise.resolve([...entries.keys()].map((url) => new Request(url))),
    }
    const media = new Map<string, Blob>()
    const state: Fixture = {
        requests: [],
        reloads: 0,
        establish: async () => {
            state.remote = { backup: await createBackup(), etag: '"revision-1"' }
            await saveWebdavSync(config, await webdavFingerprint(), state.remote.etag)
        },
    }
    let revision = 1
    try {
        localStorage.clear()
        storage.type.init()
        localStorage.bonjourr = JSON.stringify(SYNC_DEFAULT)
        await storage.local.set({ webdav: config, syncType: 'webdav', backgroundFiles: {}, backgroundUrls: {} })
        Object.defineProperty(globalThis, 'caches', {
            configurable: true,
            value: { open: () => Promise.resolve(cache) } as unknown as CacheStorage,
        })
        globalThis.location.reload = () => {
            state.reloads++
        }
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            const path = new URL(String(url)).pathname
            const headers = new Headers(init?.headers)
            state.requests.push({ method, path, headers })
            await state.beforeRequest?.(method, path)
            if (state.status) return new Response('', { status: state.status })
            if (method === 'PROPFIND') return new Response(collectionXml, { status: 207 })
            if (path.endsWith('bonjourr-latest.json')) {
                if (method === 'GET') {
                    return state.remote
                        ? Response.json(state.remote.backup, {
                            headers: state.remote.etag ? { ETag: state.remote.etag } : {},
                        })
                        : new Response('', { status: 404 })
                }
                if (
                    (headers.has('If-None-Match') && state.remote) ||
                    (headers.has('If-Match') && headers.get('If-Match') !== state.remote?.etag)
                ) return new Response('', { status: 412 })
                state.remote = { backup: JSON.parse(String(init?.body)), etag: `"revision-${++revision}"` }
                return new Response('', { status: 201, headers: { ETag: state.remote.etag! } })
            }
            if (method === 'PUT') {
                media.set(path, init?.body as Blob)
                return new Response('', { status: 201 })
            }
            return media.has(path) ? new Response(media.get(path)) : new Response('', { status: 404 })
        }) as typeof fetch
        await run(state)
    } finally {
        globalThis.fetch = originalFetch
        globalThis.location.reload = originalReload
        Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches })
        localStorage.clear()
        for (const [key, value] of Object.entries(originalStorage)) localStorage.setItem(key, value)
    }
}

Deno.test('WebDAV auto sync stays inactive unless enabled and selected', () =>
    fixture(async (state) => {
        await storage.local.set({ webdav: { ...config, autoSync: false } })
        await syncWebdavNow()
        await storage.local.set({ webdav: config, syncType: 'off' })
        await syncWebdavNow()
        assertEquals(state.requests.length, 0)
    }))

Deno.test('WebDAV auto sync seeds an empty server and does not upload unchanged settings', () =>
    fixture(async (state) => {
        await syncWebdavNow()
        assertEquals(state.remote?.backup.settings.tabtitle, SYNC_DEFAULT.tabtitle)
        assertEquals((await storage.local.get('webdav')).webdav?.fingerprint, await webdavFingerprint())
        state.requests = []
        await syncWebdavNow()
        assertEquals(state.requests.map((request) => request.method), ['GET', 'PROPFIND'])
    }))

Deno.test('WebDAV auto sync uploads local changes using the observed ETag', () =>
    fixture(async (state) => {
        await state.establish()
        await storage.sync.set({ tabtitle: 'Local change' })
        await syncWebdavNow()
        assertEquals(state.remote?.backup.settings.tabtitle, 'Local change')
        const put = state.requests.find((request) => request.method === 'PUT')!
        assertEquals(put.headers.get('If-Match'), '"revision-1"')
        assertEquals((await storage.local.get('webdav')).webdav?.etag, '"revision-2"')
    }))

Deno.test('WebDAV auto sync restores remote changes while preserving this device connection', () =>
    fixture(async (state) => {
        await state.establish()
        state.remote!.etag = '"other-device"'
        state.remote!.backup.settings.tabtitle = 'Remote change'
        state.remote!.backup.local.webdav = { url: 'https://other.example/', username: 'remote', password: 'remote' }
        state.remote!.backup.local.syncType = 'off'
        await syncWebdavNow()
        assertEquals((await storage.sync.get()).tabtitle, 'Remote change')
        const local = await storage.local.get()
        assertEquals(local.webdav?.url, config.url)
        assertEquals(local.webdav?.password, config.password)
        assertEquals(local.webdav?.autoSync, true)
        assertEquals(local.webdav?.etag, '"other-device"')
        assertEquals(local.webdav?.fingerprint, await webdavFingerprint())
        assertEquals(local.syncType, 'webdav')
        assertEquals(state.reloads, 1)
        assertEquals(state.requests.some((request) => request.method === 'PUT'), false)
    }))

Deno.test('WebDAV auto sync preserves both sides on conflict and requires explicit first-time adoption', () =>
    fixture(async (state) => {
        await state.establish()
        await storage.sync.set({ tabtitle: 'Keep local' })
        state.remote!.etag = '"other-device"'
        state.remote!.backup.settings.tabtitle = 'Keep remote'
        await assertRejects(() => syncWebdavNow(), Error, '都有修改')
        assertEquals((await storage.sync.get()).tabtitle, 'Keep local')
        assertEquals(state.remote!.backup.settings.tabtitle, 'Keep remote')
        assertEquals((await storage.local.get('webdav')).webdav?.error?.includes('都有修改'), true)
        await storage.local.set({ webdav: config })
        await assertRejects(() => syncWebdavNow(), Error, '首次同步')
        assertEquals(state.requests.some((request) => request.method === 'PUT'), false)
        assertEquals(state.reloads, 0)
    }))

Deno.test('WebDAV auto sync keeps its baseline on authentication failures and unsupported ETags', () =>
    fixture(async (state) => {
        await state.establish()
        const fingerprint = (await storage.local.get('webdav')).webdav?.fingerprint
        await storage.sync.set({ tabtitle: 'Unsynced edit' })
        state.status = 401
        await assertRejects(() => syncWebdavNow(), Error, '用户名或密码错误')
        state.status = undefined
        for (const etag of [undefined, 'W/"weak"']) {
            state.remote!.etag = etag
            await assertRejects(() => syncWebdavNow(), Error, '强 ETag')
        }
        assertEquals((await storage.local.get('webdav')).webdav?.fingerprint, fingerprint)
        assertEquals((await storage.sync.get()).tabtitle, 'Unsynced edit')
        assertEquals(state.requests.some((request) => request.method === 'PUT'), false)
    }))

Deno.test('WebDAV auto sync rechecks edits made while downloading a remote revision', () =>
    fixture(async (state) => {
        await state.establish()
        state.remote!.etag = '"other-device"'
        state.remote!.backup.settings.tabtitle = 'Remote change'
        state.beforeRequest = async () => {
            await storage.sync.set({ tabtitle: 'Edit during download' })
        }
        await assertRejects(() => syncWebdavNow(), Error, '本地设置已变化')
        assertEquals((await storage.sync.get()).tabtitle, 'Edit during download')
        assertEquals(state.reloads, 0)
    }))

Deno.test('WebDAV auto sync does not mark edits made during upload as already synchronized', () =>
    fixture(async (state) => {
        await state.establish()
        await storage.sync.set({ tabtitle: 'First edit' })
        state.beforeRequest = async (method) => {
            if (method === 'PUT') await storage.sync.set({ tabtitle: 'Edit during upload' })
        }
        await syncWebdavNow()
        assertEquals(state.remote!.backup.settings.tabtitle, 'First edit')
        assertEquals((await storage.local.get('webdav')).webdav?.fingerprint === await webdavFingerprint(), false)
        state.beforeRequest = undefined
        await syncWebdavNow()
        assertEquals(state.remote!.backup.settings.tabtitle, 'Edit during upload')
    }))

Deno.test('WebDAV auto sync checks for local edits again after downloading media', () =>
    fixture(async (state) => {
        await storage.local.set({ 'x-icon-test': 'data:image/png;base64,aGVsbG8=' })
        await syncWebdavNow()
        state.remote!.etag = '"other-device"'
        state.remote!.backup.settings.tabtitle = 'Remote change'
        state.beforeRequest = async (method, path) => {
            if (method === 'GET' && path.includes('bonjourr-icon-')) {
                await storage.sync.set({ tabtitle: 'Edit during media download' })
            }
        }
        await assertRejects(() => syncWebdavNow(), Error, '本地设置已变化')
        assertEquals((await storage.sync.get()).tabtitle, 'Edit during media download')
        assertEquals(state.reloads, 0)
    }))

Deno.test('WebDAV auto sync preserves the baseline if another device wins the upload race', () =>
    fixture(async (state) => {
        await state.establish()
        const fingerprint = (await storage.local.get('webdav')).webdav?.fingerprint
        await storage.sync.set({ tabtitle: 'Local edit' })
        state.beforeRequest = async (method) => {
            if (method === 'PUT') state.remote!.etag = '"other-device"'
        }
        await assertRejects(() => syncWebdavNow(), Error, '其他设备')
        assertEquals((await storage.sync.get()).tabtitle, 'Local edit')
        assertEquals((await storage.local.get('webdav')).webdav?.fingerprint, fingerprint)
        assertEquals((await storage.local.get('webdav')).webdav?.etag, '"revision-1"')
    }))

Deno.test('WebDAV auto sync and manual actions cannot run concurrently', () =>
    fixture(async (state) => {
        await withWebdavLock(async () => {
            await assertRejects(() => syncWebdavNow(), Error, '正在同步')
        })
        assertEquals(state.requests.length, 0)
        await syncWebdavNow()
        assertEquals(state.remote !== undefined, true)
    }))

Deno.test('WebDAV sync fingerprints ignore transport state and include equal-size icon edits', () =>
    fixture(async () => {
        await storage.local.set({ 'x-icon-test': 'data:image/png;base64,aGVsbG8=' })
        const fingerprint = await webdavFingerprint()
        await storage.local.set({ webdav: { ...config, error: 'offline', lastSync: 'now', etag: 'changed' } })
        assertEquals(await webdavFingerprint(), fingerprint)
        await storage.local.set({ 'x-icon-test': 'data:image/png;base64,d29ybGQ=' })
        assertEquals(await webdavFingerprint() === fingerprint, false)
    }))

Deno.test('WebDAV auto sync reuses unchanged media and gives changed icons immutable filenames', () =>
    fixture(async (state) => {
        await storage.local.set({ 'x-icon-test': 'data:image/png;base64,aGVsbG8=' })
        await syncWebdavNow()
        const originalName = backupIconName(state.remote!.backup.icons[0])
        state.requests = []
        await storage.sync.set({ tabtitle: 'Settings only' })
        await syncWebdavNow()
        assertEquals(state.requests.filter((request) => request.method === 'PUT').map((request) => request.path), [
            '/dav/Bonjourr/bonjourr-latest.json',
        ])
        await storage.local.set({ 'x-icon-test': 'data:image/png;base64,d29ybGQ=' })
        await syncWebdavNow()
        assertEquals(backupIconName(state.remote!.backup.icons[0]) === originalName, false)
    }))
