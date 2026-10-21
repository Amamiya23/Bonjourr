import { assertEquals, assertRejects } from '@std/assert'
import '../init.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import { storage } from '../../src/scripts/storage.ts'
import { captureCloudData, recoverCloudFolders } from '../../src/scripts/features/synchronization/cloud-data.ts'
import { adoptCloud, initializeCloud, syncCloudNow } from '../../src/scripts/features/synchronization/cloud-sync.ts'
import { sha256 } from '../../src/scripts/shared/cloud.ts'
import type { CloudChange, CloudConnection, CloudState } from '../../src/scripts/shared/cloud.ts'

interface Fixture {
    state: CloudState
    posts: { id: string; changes: CloudChange[] }[]
    beforeGet?: () => Promise<void>
    beforeAsset?: () => Promise<void>
    media?: Uint8Array
    loseResponse?: boolean
    connect: () => Promise<void>
}

async function fixture(run: (state: Fixture) => Promise<void>): Promise<void> {
    const originalFetch = globalThis.fetch
    const originalCaches = globalThis.caches
    const reload = globalThis.location.reload
    const saved = Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!]))
    const entries = new Map<string, Response>()
    const config: CloudConnection = {
        url: 'https://cloud.example',
        token: 'a'.repeat(64),
        deviceId: 'test',
        owner: true,
        name: 'Test',
    }
    const seen = new Set<string>()
    const state: Fixture = {
        state: { initialized: true, records: [] },
        posts: [],
        connect: async () => {
            const capture = await captureCloudData()
            state.state.records = Object.entries(capture.records).map(([key, json]) => ({
                key,
                json,
                revision: 1,
                deleted: false,
            }))
            await storage.local.set({ cloud: { ...config, baseline: structuredClone(state.state) } })
        },
    }
    try {
        localStorage.clear()
        storage.type.init()
        localStorage.bonjourr = JSON.stringify(SYNC_DEFAULT)
        await storage.local.set({ cloud: config, syncType: 'cloud', backgroundFiles: {}, backgroundUrls: {} })
        globalThis.location.reload = () => {}
        Object.defineProperty(globalThis, 'caches', {
            configurable: true,
            value: {
                open: () =>
                    Promise.resolve({
                        match: (key: string) => Promise.resolve(entries.get(key)?.clone()),
                        put: (key: string, value: Response) => {
                            entries.set(key, value.clone())
                            return Promise.resolve()
                        },
                        keys: () => Promise.resolve([]),
                        delete: () => Promise.resolve(true),
                    }),
            },
        })
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            if (String(_url).includes('/api/assets/')) {
                await state.beforeAsset?.()
                return new Response(state.media as Uint8Array<ArrayBuffer>)
            }
            if (!init?.method || init.method === 'GET') {
                await state.beforeGet?.()
                return Response.json(state.state)
            }
            const request = JSON.parse(String(init.body)) as { id: string; changes: CloudChange[] }
            state.posts.push(request)
            if (!seen.has(request.id)) {
                for (const change of request.changes) {
                    const record = state.state.records.find((item) => item.key === change.key)
                    if ((record?.revision ?? 0) !== change.baseRevision) {
                        return Response.json({ error: '云端已变化' }, { status: 409 })
                    }
                }
                for (const change of request.changes) {
                    state.state.records = state.state.records.filter((item) => item.key !== change.key)
                    state.state.records.push({
                        key: change.key,
                        json: change.json,
                        deleted: change.deleted,
                        revision: change.baseRevision + 1,
                    })
                }
                seen.add(request.id)
            }
            if (state.loseResponse) {
                state.loseResponse = false
                throw new TypeError('lost response')
            }
            if (String(_url).endsWith('/api/initialize')) state.state.initialized = true
            return Response.json(state.state)
        }) as typeof fetch
        await run(state)
    } finally {
        globalThis.fetch = originalFetch
        globalThis.location.reload = reload
        Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches })
        localStorage.clear()
        for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value)
    }
}

Deno.test('A new unadopted device never uploads defaults over cloud data', () =>
    fixture(async (state) => {
        state.state.records = [{ key: 'sync/tabtitle', json: '"Keep remote"', revision: 7, deleted: false }]
        await syncCloudNow()
        assertEquals(state.posts.length, 0)
        assertEquals(state.state.records[0].json, '"Keep remote"')
    }))

Deno.test('First upload recovers missing folders without changing child links or existing folders', () =>
    fixture(async (state) => {
        state.state = { initialized: false, records: [] }
        const child = {
            _id: 'linksAliyun',
            title: '阿里云控制台',
            url: 'https://example.com',
            parent: 'linksMissing',
            order: 0,
        }
        const sibling = { ...child, _id: 'linksSibling', title: 'Another link', order: 1 }
        const folder = { _id: 'linksExisting', parent: '常用', folder: true, title: 'Keep folder', order: 3 }
        await storage.sync.set({
            linkgroups: { on: true, selected: '服务器', groups: ['常用', '服务器'], pinned: [], synced: [] },
            linksAliyun: child,
            linksSibling: sibling,
            linksExisting: folder,
            linksNested: { ...child, _id: 'linksNested', parent: 'linksExisting' },
        })
        await initializeCloud()
        const settings = await storage.sync.get()
        assertEquals(settings.linksAliyun, child)
        assertEquals(settings.linksSibling, sibling)
        assertEquals(settings.linksExisting, folder)
        assertEquals(settings.linksMissing, {
            _id: 'linksMissing',
            parent: '常用',
            folder: true,
            size: 'large',
            title: '恢复的文件夹',
            order: 4,
        })
        const captured = await captureCloudData()
        assertEquals(
            Object.fromEntries(state.state.records.map((record) => [record.key, record.json])),
            captured.records,
        )
        await syncCloudNow()
        assertEquals(state.posts.length, 1)
    }))

Deno.test('Folder recovery never overwrites an existing non-folder entry or repairs ongoing sync silently', () =>
    fixture(async (state) => {
        const existing = {
            _id: 'linksParent',
            title: 'Keep link',
            url: 'https://example.com',
            parent: 'default',
            order: 0,
        }
        const child = { ...existing, _id: 'linksChild', parent: 'linksParent' }
        await storage.sync.set({ linksParent: existing, linksChild: child })
        await recoverCloudFolders()
        assertEquals((await storage.sync.get()).linksParent, existing)
        await state.connect()
        await storage.sync.set({ linksChild: { ...child, parent: 'linksMissing' } })
        await syncCloudNow()
        assertEquals((await storage.sync.get()).linksMissing, undefined)
    }))

Deno.test('Unset device connections are not treated as the string undefined', () =>
    fixture(async () => {
        localStorage.setItem('cloud', 'undefined')
        assertEquals((await storage.local.get('cloud')).cloud, undefined)
        await storage.local.set({ cloud: undefined })
        assertEquals(localStorage.getItem('cloud'), null)
    }))

Deno.test('Cloud sync merges independent offline edits and pauses same-field conflicts', () =>
    fixture(async (state) => {
        await state.connect()
        await storage.sync.set({ tabtitle: 'Local title' })
        const greeting = state.state.records.find((item) => item.key === 'sync/greeting')!
        greeting.json = '"Remote greeting"'
        greeting.revision++
        await syncCloudNow()
        assertEquals((await storage.sync.get()).tabtitle, 'Local title')
        assertEquals((await storage.sync.get()).greeting, 'Remote greeting')
        assertEquals(state.posts[0].changes.length, 1)
        await storage.sync.set({ tabtitle: 'Local conflict' })
        const title = state.state.records.find((item) => item.key === 'sync/tabtitle')!
        title.json = '"Remote conflict"'
        title.revision++
        await assertRejects(() => syncCloudNow(), Error, '同时修改')
        assertEquals((await storage.sync.get()).tabtitle, 'Local conflict')
        assertEquals(title.json, '"Remote conflict"')
        await syncCloudNow({ resolutions: { 'sync/tabtitle': 'remote' } })
        assertEquals((await storage.sync.get()).tabtitle, 'Remote conflict')
    }))

Deno.test('Cloud sync replays ambiguous requests once and keeps subsequent offline edits', () =>
    fixture(async (state) => {
        await state.connect()
        await storage.sync.set({ tabtitle: 'First edit' })
        state.loseResponse = true
        await assertRejects(() => syncCloudNow())
        const pending = (await storage.local.get('cloud')).cloud!.pending!
        assertEquals(!!pending, true)
        await storage.sync.set({ tabtitle: 'Later edit' })
        await syncCloudNow()
        assertEquals(state.posts[0].id, state.posts[1].id)
        assertEquals((await storage.sync.get()).tabtitle, 'Later edit')
        assertEquals(state.state.records.find((item) => item.key === 'sync/tabtitle')!.json, '"Later edit"')
        assertEquals((await storage.local.get('cloud')).cloud!.pending, undefined)
    }))

Deno.test('Local edits during a cloud download remain pending instead of being overwritten', () =>
    fixture(async (state) => {
        await state.connect()
        const title = state.state.records.find((item) => item.key === 'sync/tabtitle')!
        title.json = '"Remote title"'
        title.revision++
        state.beforeGet = async () => {
            state.beforeGet = undefined
            await storage.sync.set({ greeting: 'Typed while downloading' })
        }
        await syncCloudNow()
        assertEquals((await storage.sync.get()).tabtitle, 'Remote title')
        assertEquals((await storage.sync.get()).greeting, 'Typed while downloading')
        await syncCloudNow()
        assertEquals(
            state.state.records.find((item) => item.key === 'sync/greeting')!.json,
            '"Typed while downloading"',
        )
    }))

Deno.test('Cloud data excludes device credentials and local layout', () =>
    fixture(async () => {
        await storage.local.set({
            webdav: { url: 'https://private.example', username: 'private', password: 'private-backup-password' },
        })
        const capture = await captureCloudData()
        assertEquals(
            Object.keys(capture.records).some((key) =>
                key.includes('cloud') || key.includes('webdav') || key.includes('pagewidth') || key.includes('selected')
            ),
            false,
        )
        assertEquals(JSON.stringify(capture.records).includes('private-backup-password'), false)
    }))

Deno.test('Explicit cloud adoption downloads shared data while keeping local layout', () =>
    fixture(async (state) => {
        await state.connect()
        state.state.records.find((item) => item.key === 'sync/tabtitle')!.json = '"Adopted cloud"'
        await storage.sync.set({ pagewidth: 77 })
        const connection = (await storage.local.get('cloud')).cloud!
        await storage.local.set({ cloud: { ...connection, baseline: undefined } })
        await adoptCloud()
        assertEquals((await storage.sync.get()).tabtitle, 'Adopted cloud')
        assertEquals((await storage.sync.get()).pagewidth, 77)
        assertEquals((await storage.local.get('cloud')).cloud!.baseline?.initialized, true)
        assertEquals(state.posts.length, 0)
    }))

Deno.test('Adoption aborts before applying settings if the user edits during media download', () =>
    fixture(async (state) => {
        await state.connect()
        const bytes = new TextEncoder().encode('test icon')
        state.media = bytes
        state.state.records.push({
            key: 'icon/x-icon-remote',
            json: JSON.stringify({
                type: 'image/png',
                bytes: bytes.length,
                parts: [{ hash: await sha256(bytes), bytes: bytes.length }],
            }),
            revision: 1,
            deleted: false,
        })
        state.beforeAsset = async () => {
            state.beforeAsset = undefined
            await storage.sync.set({ tabtitle: 'Edit during media download' })
        }
        await assertRejects(() => adoptCloud(), Error, '本机有修改')
        assertEquals((await storage.sync.get()).tabtitle, 'Edit during media download')
        assertEquals((await storage.local.get())['x-icon-remote'], undefined)
    }))
