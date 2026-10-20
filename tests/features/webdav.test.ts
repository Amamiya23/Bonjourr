import { assertEquals, assertRejects, assertThrows } from '@std/assert'
import '../init.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import {
    downloadWebdav,
    hasStrongWebdavEtag,
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

function etagResponse(
    etag = '&quot;dav-revision&quot;',
    status = '200 OK',
    href = '/dav/Bonjourr/bonjourr-latest.json',
): Response {
    return new Response(
        `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag></d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat></d:response></d:multistatus>`,
        { status: 207 },
    )
}

Deno.test('WebDAV reads OpenList property ETags when proxy GET headers omit or use a different validator', async () => {
    const original = globalThis.fetch
    try {
        for (const upstreamEtag of [undefined, 'W/"upstream"', '"upstream"']) {
            const requests: string[] = []
            globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
                requests.push(init?.method ?? 'GET')
                if (init?.method === 'PROPFIND') {
                    assertEquals(new Headers(init.headers).get('Depth'), '0')
                    assertEquals(String(init.body).includes('getetag'), true)
                    return Promise.resolve(etagResponse())
                }
                assertEquals(new Headers(init?.headers).has('If-Match'), false)
                return Promise.resolve(Response.json(backup, { headers: upstreamEtag ? { ETag: upstreamEtag } : {} }))
            }) as typeof fetch
            const result = await downloadWebdav(config)
            assertEquals(result.etag, '"dav-revision"')
            assertEquals(result.backup.settings.tabtitle, backup.settings.tabtitle)
            assertEquals(requests, ['GET', 'PROPFIND', 'GET', 'PROPFIND'])
        }
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('WebDAV does not associate a changed property ETag with an older backup', async () => {
    const original = globalThis.fetch
    let properties = 0
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PROPFIND') return Promise.resolve(etagResponse(`&quot;revision-${++properties}&quot;`))
        return Promise.resolve(Response.json(backup))
    }) as typeof fetch
    try {
        await assertRejects(() => downloadWebdav(config), Error, '读取期间已变化')
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('WebDAV ignores property errors and validators belonging to other resources', async () => {
    const original = globalThis.fetch
    try {
        for (
            const response of [
                etagResponse('&quot;missing&quot;', '404 Not Found'),
                etagResponse('&quot;other&quot;', '200 OK', '/dav/Bonjourr/other.json'),
                etagResponse('W/&quot;weak&quot;'),
                new Response('', { status: 405 }),
            ]
        ) {
            globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
                Promise.resolve(init?.method === 'PROPFIND' ? response : Response.json(backup))) as typeof fetch
            assertEquals((await downloadWebdav(config)).etag, undefined)
        }
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('WebDAV validates strong ETags and requires an explicit override for weak ones', async () => {
    assertEquals(hasStrongWebdavEtag('"revision"'), true)
    for (const value of [undefined, '', 'W/"revision"', 'revision', '"invalid\n"']) {
        assertEquals(hasStrongWebdavEtag(value), false)
    }
    await assertRejects(() => uploadWebdav({ ...config, etag: 'W/"revision"' }, backup), Error, '弱 ETag')
})

Deno.test('WebDAV permits explicitly confirmed overwrites without ETags and verifies uploaded content', async () => {
    const original = globalThis.fetch
    let payload = ''
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PROPFIND') return Promise.resolve(collectionResponse())
        if (init?.method === 'PUT') {
            assertEquals(new Headers(init.headers).has('If-Match'), false)
            assertEquals(new Headers(init.headers).has('If-None-Match'), false)
            payload = String(init.body)
            return Promise.resolve(new Response(null, { status: 204 }))
        }
        return Promise.resolve(new Response(payload))
    }) as typeof fetch
    try {
        assertEquals(await uploadWebdav(config, structuredClone(backup), undefined, true), undefined)
        assertEquals(payload.includes('bonjourr-webdav'), true)
        globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
            if (init?.method === 'PROPFIND') return Promise.resolve(collectionResponse())
            return Promise.resolve(
                init?.method === 'PUT'
                    ? new Response(null, { status: 204 })
                    : Response.json({ ...backup, createdAt: 'other' }),
            )
        }) as typeof fetch
        await assertRejects(
            () => uploadWebdav(config, structuredClone(backup), undefined, true),
            Error,
            '上传后已被其他设备修改',
        )
    } finally {
        globalThis.fetch = original
    }
})
