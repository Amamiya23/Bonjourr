import { assertEquals, assertRejects, assertThrows } from '@std/assert'
import '../init.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import {
    downloadWebdav,
    testWebdav,
    uploadWebdav,
    webdavDirectory,
    webdavFile,
} from '../../src/scripts/features/synchronization/webdav.ts'
import { parseBackup } from '../../src/scripts/features/synchronization/backup.ts'
import type { Backup } from '../../src/scripts/features/synchronization/backup.ts'

const config = { url: 'https://example.com/dav/Bonjourr', username: '用户', password: 'test-password' }
const collectionXml =
    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
const collectionResponse = () => new Response(collectionXml, { status: 207 })
const backup: Backup = {
    format: 'bonjourr-webdav',
    version: 2,
    createdAt: '2026-10-19T00:00:00.000Z',
    settings: structuredClone(SYNC_DEFAULT),
    local: { backgroundFiles: {}, backgroundUrls: {} },
    assets: [],
    icons: [],
}

Deno.test('WebDAV directory paths retain their final folder', () => {
    assertEquals(webdavFile(config).href, 'https://example.com/dav/Bonjourr/bonjourr-latest.json')
    assertThrows(() => webdavFile({ ...config, url: 'https://example.com/?token=secret' }))
    assertThrows(() => webdavFile({ ...config, url: 'https://user:secret@example.com/dav/' }))
})

Deno.test('WebDAV editable backup directories stay beneath the service and encode folder names', () => {
    const base = { ...config, url: 'https://example.com/dav', directory: 'Bonjourr' }
    assertEquals(webdavFile(base).href, 'https://example.com/dav/Bonjourr/bonjourr-latest.json')
    assertEquals(webdavDirectory({ ...base, directory: '' }).href, 'https://example.com/dav/')
    assertEquals(
        webdavDirectory({ ...base, directory: '备份/我的 起始页' }).pathname,
        '/dav/%E5%A4%87%E4%BB%BD/%E6%88%91%E7%9A%84%20%E8%B5%B7%E5%A7%8B%E9%A1%B5/',
    )
    for (const directory of ['../elsewhere', 'a/../b', 'a\\b', 'a//b']) {
        assertThrows(() => webdavDirectory({ ...base, directory }), Error, '目录名称无效')
    }
})

Deno.test('WebDAV connection test uses PROPFIND Depth 0 with UTF-8 credentials', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        assertEquals(String(url), 'https://example.com/dav/Bonjourr/')
        assertEquals(init?.method, 'PROPFIND')
        assertEquals(new Headers(init?.headers).get('Depth'), '0')
        const encoded = new Headers(init?.headers).get('Authorization')?.slice(6) ?? ''
        assertEquals(
            new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))),
            '用户:test-password',
        )
        assertEquals(init?.redirect, 'error')
        return Promise.resolve(collectionResponse())
    }) as typeof fetch
    try {
        await testWebdav(config)
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('WebDAV tests create a missing backup directory and verify it before succeeding', async () => {
    const original = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname
        requests.push(`${init?.method} ${path}`)
        if (requests.length === 1) return Promise.resolve(new Response('', { status: 404 }))
        if (init?.method === 'MKCOL') return Promise.resolve(new Response('', { status: 201 }))
        return Promise.resolve(collectionResponse())
    }) as typeof fetch
    try {
        await testWebdav({ ...config, url: 'https://example.com/dav/', directory: 'Bonjourr/备份' })
        assertEquals(requests, [
            'PROPFIND /dav/Bonjourr/%E5%A4%87%E4%BB%BD/',
            'PROPFIND /dav/',
            'MKCOL /dav/Bonjourr/',
            'MKCOL /dav/Bonjourr/%E5%A4%87%E4%BB%BD/',
            'PROPFIND /dav/Bonjourr/%E5%A4%87%E4%BB%BD/',
        ])
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('WebDAV does not create folders for auth failures or report invalid multistatus as success', async () => {
    const original = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
        requests.push(init?.method ?? '')
        return Promise.resolve(new Response('', { status: 403 }))
    }) as typeof fetch
    try {
        await assertRejects(() => testWebdav({ ...config, directory: 'Bonjourr' }), Error, '访问权限')
        assertEquals(requests, ['PROPFIND'])
        globalThis.fetch = (() =>
            Promise.resolve(
                new Response(collectionXml.replace('200 OK', '403 Forbidden'), { status: 207 }),
            )) as typeof fetch
        await assertRejects(
            () => testWebdav(config),
            Error,
            '可访问的 WebDAV 目录',
        )
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('WebDAV initial uploads never overwrite an existing remote backup', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PROPFIND') return Promise.resolve(collectionResponse())
        assertEquals(new Headers(init?.headers).get('If-None-Match'), '*')
        assertEquals(new Headers(init?.headers).has('If-Match'), false)
        return Promise.resolve(new Response('', { status: 412 }))
    }) as typeof fetch
    try {
        await assertRejects(() => uploadWebdav(config, backup), Error, '其他设备')
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('WebDAV sync uses the last observed ETag and surfaces conflicts', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PROPFIND') return Promise.resolve(collectionResponse())
        assertEquals(new Headers(init?.headers).get('If-Match'), '"revision-1"')
        assertEquals(new Headers(init?.headers).has('If-None-Match'), false)
        return Promise.resolve(new Response('', { status: 201, headers: { ETag: '"revision-2"' } }))
    }) as typeof fetch
    try {
        assertEquals(await uploadWebdav({ ...config, etag: '"revision-1"' }, backup), '"revision-2"')
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('WebDAV download returns validated data and its conflict token', async () => {
    const original = globalThis.fetch
    globalThis.fetch =
        (() => Promise.resolve(Response.json(backup, { headers: { ETag: '"revision-3"' } }))) as typeof fetch
    try {
        const result = await downloadWebdav(config)
        assertEquals(result.etag, '"revision-3"')
        assertEquals(result.backup.settings.compactLayout, true)
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('Backups reject missing media and do not import local credentials', () => {
    const malicious = {
        ...backup,
        settings: { ...backup.settings, webdav: { password: 'secret' }, weatherApiKey: 'secret' },
    }
    const parsed = parseBackup(JSON.stringify(malicious))
    assertEquals('webdav' in parsed.settings, false)
    assertEquals('weatherApiKey' in parsed.settings, false)
    assertThrows(() => parseBackup(JSON.stringify({ ...backup, version: 999 })), Error, '版本')
    assertThrows(
        () =>
            parseBackup(JSON.stringify({
                ...backup,
                local: { ...backup.local, backgroundFiles: { missing: { format: 'image' } } },
            })),
        Error,
        '不完整',
    )
    assertThrows(
        () => parseBackup(JSON.stringify({ ...backup, settings: { ...backup.settings, move: 'invalid' } })),
        Error,
        '类型',
    )
})
