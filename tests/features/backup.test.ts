import { assertEquals } from '@std/assert'
import '../init.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import { storage } from '../../src/scripts/storage.ts'
import {
    createBackup,
    parseBackup,
    recoveryBackup,
    restoreBackup,
    saveRecoveryBackup,
} from '../../src/scripts/features/synchronization/backup.ts'

localStorage.bonjourr = JSON.stringify(SYNC_DEFAULT)
await storage.init()

Deno.test('Full backups round trip settings, local wallpapers and custom icons without credentials', async () => {
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
            })
        },
    } as unknown as CacheStorage
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: fakeCaches })
    try {
        await storage.local.set({
            weatherApiKey: 'uapi-private-test',
            webdav: { url: 'https://example.com/dav/', username: 'private-user', password: 'private-password' },
            backgroundFiles: { test: { format: 'image', lastUsed: '' } },
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
        assertEquals(backup.assets.length, 2)
        assertEquals(backup.local.icons['x-icon-test'], 'data:image/png;base64,aGVsbG8=')
        const serialized = JSON.stringify(backup)
        assertEquals(serialized.includes('uapi-private-test'), false)
        assertEquals(serialized.includes('private-password'), false)
        await saveRecoveryBackup()
        await storage.sync.set({ tabtitle: 'changed' })
        await restoreBackup(parseBackup(serialized))
        assertEquals((await storage.sync.get()).tabtitle, SYNC_DEFAULT.tabtitle)
        assertEquals(await (await cache.match('http://127.0.0.1:8888/test/full'))?.text(), 'full-image')
        assertEquals((await storage.local.get('weatherApiKey')).weatherApiKey, 'uapi-private-test')
        assertEquals((await recoveryBackup()).format, 'bonjourr-webdav')
    } finally {
        Object.defineProperty(globalThis, 'caches', { configurable: true, value: original })
    }
})
