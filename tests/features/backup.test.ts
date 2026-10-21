import { assertEquals, assertThrows } from '@std/assert'
import '../init.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import { storage } from '../../src/scripts/storage.ts'
import {
    backupIconName,
    createBackup,
    parseBackup,
    restoreBackup,
} from '../../src/scripts/features/synchronization/backup.ts'
import { restoreWebdav, uploadWebdav } from '../../src/scripts/features/synchronization/webdav.ts'
import type { Backup } from '../../src/scripts/features/synchronization/backup.ts'

localStorage.bonjourr = JSON.stringify(SYNC_DEFAULT)
await storage.init()

Deno.test('Backups accept legacy string-valued links per row across backup versions', () => {
    for (const version of [1, 2, 3]) {
        for (const rows of ['1', '8', '16', 8]) {
            const backup = parseBackup(JSON.stringify({
                format: 'bonjourr-webdav',
                version,
                createdAt: '2026-10-21T00:00:00.000Z',
                settings: { ...SYNC_DEFAULT, linksrow: rows },
                local: { backgroundFiles: {}, backgroundUrls: {}, icons: {} },
                assets: [],
                icons: [],
            }))
            assertEquals(backup.settings.linksrow, Number(rows))
        }
    }
})

Deno.test('Backups still reject invalid links per row and other mismatched settings', () => {
    for (
        const settings of [
            ...['', '0', '8px', '8.5', '9007199254740992', null, true, [], {}].map((linksrow) => ({ linksrow })),
            { pagewidth: '80' },
        ]
    ) {
        assertThrows(
            () =>
                parseBackup(JSON.stringify({
                    format: 'bonjourr-webdav',
                    version: 3,
                    createdAt: '2026-10-21T00:00:00.000Z',
                    settings: { ...SYNC_DEFAULT, ...settings },
                    local: { backgroundFiles: {}, backgroundUrls: {} },
                    assets: [],
                    icons: [],
                })),
            Error,
            `备份中的 ${'linksrow' in settings ? 'linksrow' : 'pagewidth'} 类型无效。`,
        )
    }
})

Deno.test('Full backups keep every persistent value and reference media outside the manifest', async () => {
    const original = globalThis.caches
    const stores = new Map<string, Map<string, Response>>()
    const fakeCaches = {
        open: (name: string) => {
            if (!stores.has(name)) stores.set(name, new Map())
            const entries = stores.get(name)!
            return Promise.resolve({
                put: (key: string | Request, response: Response) => {
                    entries.set(typeof key === 'string' ? key : key.url, response.clone())
                    return Promise.resolve()
                },
                match: (key: string) => Promise.resolve(entries.get(key)?.clone()),
                delete: (key: string | Request) => {
                    entries.delete(typeof key === 'string' ? key : key.url)
                    return Promise.resolve(true)
                },
                keys: () => Promise.resolve([...entries.keys()].map((url) => new Request(url))),
            })
        },
    } as unknown as CacheStorage
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: fakeCaches })
    try {
        localStorage.bonjourr = JSON.stringify({ ...SYNC_DEFAULT, linksrow: '6' })
        await storage.local.set({
            weatherApiKey: 'uapi-private-test',
            weatherApiOrigin: 'https://uapis.cn',
            gistToken: 'gist-private-token',
            backgroundCompressFiles: false,
            backgroundLastChange: '2026-10-20T00:00:00.000Z',
            webdav: {
                url: 'https://example.com/dav/',
                username: 'private-user',
                password: 'private-password',
            },
            backgroundFiles: { test: { format: 'image', lastUsed: '' } },
            backgroundUrls: {},
            'x-icon-test': 'data:image/png;base64,aGVsbG8=',
        })
        const cache = await caches.open('local-files')
        await cache.put(
            'http://127.0.0.1:8888/test/full',
            new Response('full-image', { headers: { 'Content-Type': 'image/png' } }),
        )
        await cache.put(
            'http://127.0.0.1:8888/test/small',
            new Response('thumbnail', { headers: { 'Content-Type': 'image/png' } }),
        )

        const backup = await createBackup()
        assertEquals(backup.version, 3)
        assertEquals(backup.settings.linksrow, 6)
        assertEquals(backup.assets.length, 2)
        assertEquals(backup.assets.some((asset) => 'data' in asset), false)
        assertEquals(backup.icons, [{
            key: 'x-icon-test',
            type: 'image/png',
            bytes: 5,
            hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        }])
        assertEquals(backup.local.weatherApiKey, 'uapi-private-test')
        assertEquals(backup.local.webdav?.password, 'private-password')
        assertEquals(backup.local.backgroundCompressFiles, false)
        assertEquals(backup.local.backgroundLastChange, '2026-10-20T00:00:00.000Z')

        const serialized = JSON.stringify(backup)
        assertEquals(serialized.includes('full-image'), false)
        assertEquals(serialized.includes('data:image'), false)
        assertEquals(parseBackup(serialized).version, 3)

        await storage.sync.set({ tabtitle: 'changed' })
        await storage.local.set({ 'x-icon-old': 'data:image/png;base64,b2xk' })
        await cache.put(
            'http://127.0.0.1:8888/old/full',
            new Response('old-image', { headers: { 'Content-Type': 'image/png' } }),
        )

        await restoreBackup(backup, { 'x-icon-test': 'data:image/png;base64,aGVsbG8=' })

        assertEquals((await storage.sync.get()).tabtitle, SYNC_DEFAULT.tabtitle)
        assertEquals((await storage.local.get('weatherApiKey')).weatherApiKey, 'uapi-private-test')
        assertEquals(await (await cache.match('http://127.0.0.1:8888/test/full'))?.text(), 'full-image')
        assertEquals((await cache.match('http://127.0.0.1:8888/old/full')) === undefined, true)

        const restored = await storage.local.get()
        assertEquals(restored['x-icon-test'], 'data:image/png;base64,aGVsbG8=')
        assertEquals(restored['x-icon-old'], undefined)
        assertEquals(restored.weatherApiKey, 'uapi-private-test')
    } finally {
        Object.defineProperty(globalThis, 'caches', { configurable: true, value: original })
    }
})

Deno.test('WebDAV restore downloads media files and rebuilds icon data URLs', async () => {
    const originalCaches = globalThis.caches
    const originalFetch = globalThis.fetch
    const stores = new Map<string, Map<string, Response>>()
    const fakeCaches = {
        open: (name: string) => {
            if (!stores.has(name)) stores.set(name, new Map())
            const entries = stores.get(name)!
            return Promise.resolve({
                put: (key: string | Request, response: Response) => {
                    entries.set(typeof key === 'string' ? key : key.url, response.clone())
                    return Promise.resolve()
                },
                match: (key: string) => Promise.resolve(entries.get(key)?.clone()),
                delete: (key: string | Request) => {
                    entries.delete(typeof key === 'string' ? key : key.url)
                    return Promise.resolve(true)
                },
                keys: () => Promise.resolve([...entries.keys()].map((url) => new Request(url))),
            })
        },
    } as unknown as CacheStorage
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: fakeCaches })

    const backup: Backup = {
        format: 'bonjourr-webdav',
        version: 2,
        createdAt: '2026-10-20T00:00:00.000Z',
        settings: structuredClone(SYNC_DEFAULT),
        local: {
            weatherApiKey: 'restored-key',
            backgroundFiles: { test: { format: 'image', lastUsed: '' } },
            backgroundUrls: {},
        },
        assets: [
            { id: 'test', size: 'full', type: 'image/png', bytes: 5 },
            { id: 'test', size: 'small', type: 'image/png', bytes: 4 },
        ],
        icons: [{ key: 'x-icon-test', type: 'image/png', bytes: 5 }],
    }

    globalThis.fetch = ((url: string | URL | Request) => {
        const path = new URL(String(url)).pathname
        if (path.endsWith('-full')) return Promise.resolve(new Response('hello'))
        if (path.endsWith('-small')) return Promise.resolve(new Response('tiny'))
        if (path.includes('bonjourr-icon-')) return Promise.resolve(new Response('icon!'))
        return Promise.resolve(new Response('', { status: 404 }))
    }) as typeof fetch

    try {
        await restoreWebdav({ url: 'https://example.com/dav/', username: 'user', password: 'pass' }, backup)

        const cache = await caches.open('local-files')
        assertEquals(await (await cache.match('http://127.0.0.1:8888/test/full'))?.text(), 'hello')
        assertEquals(await (await cache.match('http://127.0.0.1:8888/test/small'))?.text(), 'tiny')
        assertEquals((await storage.local.get()).weatherApiKey, 'restored-key')
        assertEquals((await storage.local.get())['x-icon-test'], 'data:image/png;base64,aWNvbiE=')
    } finally {
        Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches })
        globalThis.fetch = originalFetch
    }
})

Deno.test('WebDAV upload sends media files before the manifest', async () => {
    const originalCaches = globalThis.caches
    const originalFetch = globalThis.fetch
    const stores = new Map<string, Map<string, Response>>()
    const fakeCaches = {
        open: (name: string) => {
            if (!stores.has(name)) stores.set(name, new Map())
            const entries = stores.get(name)!
            return Promise.resolve({
                put: (key: string | Request, response: Response) => {
                    entries.set(typeof key === 'string' ? key : key.url, response.clone())
                    return Promise.resolve()
                },
                match: (key: string) => Promise.resolve(entries.get(key)?.clone()),
                delete: (key: string | Request) => {
                    entries.delete(typeof key === 'string' ? key : key.url)
                    return Promise.resolve(true)
                },
                keys: () => Promise.resolve([...entries.keys()].map((url) => new Request(url))),
            })
        },
    } as unknown as CacheStorage
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: fakeCaches })

    await storage.local.set({
        backgroundFiles: { test: { format: 'image', lastUsed: '' } },
        'x-icon-test': 'data:image/png;base64,aGVsbG8=',
    })
    const cache = await caches.open('local-files')
    await cache.put('http://127.0.0.1:8888/test/full', new Response('full-image'))
    await cache.put('http://127.0.0.1:8888/test/small', new Response('thumbnail'))
    const backup = await createBackup()

    const requests: string[] = []
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        const method = init?.method ?? 'GET'
        requests.push(`${method} ${path}`)
        if (method === 'PROPFIND') {
            return Promise.resolve(
                new Response(
                    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
                    { status: 207 },
                ),
            )
        }
        return Promise.resolve(new Response('', { status: 201, headers: { ETag: '"revision-1"' } }))
    }) as typeof fetch

    try {
        assertEquals(
            await uploadWebdav({ url: 'https://example.com/dav/', username: 'user', password: 'pass' }, backup),
            '"revision-1"',
        )
        assertEquals(requests, [
            'PROPFIND /dav/',
            'PUT /dav/bonjourr-asset-test-full',
            'PUT /dav/bonjourr-asset-test-small',
            `PUT /dav/${backupIconName(backup.icons[0])}`,
            'PUT /dav/bonjourr-latest.json',
        ])
    } finally {
        Object.defineProperty(globalThis, 'caches', { configurable: true, value: originalCaches })
        globalThis.fetch = originalFetch
    }
})
