/// <reference lib="deno.ns" />
import { assertEquals, assertRejects } from '@std/assert'
import {
    mediaCandidates,
    normalizeBrandName,
    parseCandidateRequest,
    rankAppleResults,
    scoreBrandMatch,
} from './media.ts'
import { HttpError } from './http.ts'

Deno.test('normalizes and scores App Store matches', () => {
    assertEquals(normalizeBrandName('  Café & Co.  '), 'cafe and co')
    assertEquals(scoreBrandMatch('Netflix', 'Netflix'), 1)
    assertEquals(scoreBrandMatch('Netflix', 'Netflix, Inc.'), 0.9)
    assertEquals(scoreBrandMatch('flix', 'Netflix, Inc.'), 0.7)
    assertEquals(scoreBrandMatch('music apple', 'Apple Music'), 0.55)
    assertEquals(scoreBrandMatch('nfx', 'Netflix'), 0.35)
})

Deno.test('ranks Apple candidates, prioritizes US and deduplicates track IDs', () => {
    const results = rankAppleResults([
        {
            storefront: 'cn',
            order: 0,
            result: {
                trackName: 'Netflix',
                sellerName: 'Netflix, Inc.',
                bundleId: 'com.netflix.Netflix',
                trackId: 363590051,
                artworkUrl512: 'https://is1-ssl.mzstatic.com/image/thumb/cn/512x512bb.jpg',
            },
        },
        {
            storefront: 'us',
            order: 0,
            result: {
                trackName: 'Netflix',
                sellerName: 'Netflix, Inc.',
                bundleId: 'com.netflix.Netflix',
                trackId: 363590051,
                artworkUrl512: 'https://is1-ssl.mzstatic.com/image/thumb/us/512x512bb.jpg',
            },
        },
        {
            storefront: 'us',
            order: 1,
            result: {
                trackName: 'Netflix Party',
                sellerName: 'Example',
                bundleId: 'example.party',
                trackId: 42,
                artworkUrl100: 'https://is2-ssl.mzstatic.com/image/thumb/party/100x100bb.jpg',
            },
        },
        {
            storefront: 'us',
            order: 2,
            result: {
                trackName: 'Netflix Unofficial',
                sellerName: 'Example',
                bundleId: 'example.unofficial',
                trackId: 43,
                artworkUrl60: 'https://example.com/not-mzstatic.jpg',
            },
        },
    ], 'Netflix')

    assertEquals(results.length, 2)
    assertEquals(results[0].storefront, 'US')
    assertEquals(results[0].autoAssignable, false)
    assertEquals(results[0].url, 'https://is1-ssl.mzstatic.com/image/thumb/us/512x512bb.jpg')
    assertEquals(results[1]?.name, 'Netflix Party')
})

Deno.test('sorts by score before storefront priority across regions', () => {
    const results = rankAppleResults([
        {
            storefront: 'us',
            order: 0,
            result: {
                trackName: 'Netflix Party',
                trackId: 1,
                artworkUrl512: 'https://is1-ssl.mzstatic.com/image/us-prefix.jpg',
            },
        },
        {
            storefront: 'cn',
            order: 0,
            result: {
                trackName: 'Netflix',
                trackId: 2,
                artworkUrl512: 'https://is1-ssl.mzstatic.com/image/cn-exact.jpg',
            },
        },
    ], 'Netflix')

    assertEquals(results.map((candidate) => candidate.storefront), ['CN', 'US'])
})

Deno.test('parses supported storefronts and preserves defaults when empty', () => {
    const parsed = parseCandidateRequest({
        kind: 'logo',
        mode: 'search',
        items: [{ id: 'search', name: 'Netflix', website: 'https://netflix.com' }],
        onlineIconSources: { appStore: { enabled: true, storefronts: ['cn', 'us', 'fr'] } },
    })
    assertEquals(parsed.appStore.storefronts, ['us', 'cn'])

    const empty = parseCandidateRequest({
        kind: 'logo',
        mode: 'search',
        items: [{ id: 'search', name: 'Netflix', website: 'https://netflix.com' }],
        onlineIconSources: { appStore: { enabled: true, storefronts: [] } },
    })
    assertEquals(empty.appStore.storefronts, ['us', 'cn'])
    assertEquals(empty.appStore.enabled, true)

    const disabledByDefault = parseCandidateRequest({
        kind: 'logo',
        mode: 'search',
        items: [{ id: 'search', name: 'Netflix', website: 'https://netflix.com' }],
    })
    assertEquals(disabledByDefault.appStore.enabled, false)
})

Deno.test('rejects invalid candidate websites', async () => {
    await assertRejects(
        () =>
            mediaCandidates(
                new Request('https://example.com/api/app/media/candidates', {
                    method: 'POST',
                    body: JSON.stringify({
                        kind: 'icon',
                        mode: 'search',
                        items: [{ id: 'search', name: 'Bad', website: 'javascript:alert(1)' }],
                    }),
                }),
            ),
        HttpError,
    )
})

Deno.test('does not request App Store for icon kind', async () => {
    const response = await mediaCandidates(
        new Request('https://example.com/api/app/media/candidates', {
            method: 'POST',
            body: JSON.stringify({
                kind: 'icon',
                mode: 'search',
                items: [{ id: 'search', name: 'Netflix', website: 'https://netflix.com' }],
            }),
        }),
    )
    const data = await response.json() as { items: Array<{ appStore: unknown[]; favicon: unknown[] }> }
    assertEquals(data.items[0].appStore, [])
    assertEquals(data.items[0].favicon.length, 1)
})

Deno.test('does not request App Store for batch searches', async () => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (() => {
        requests++
        return Promise.reject(new Error('unexpected request'))
    }) as typeof fetch
    try {
        const response = await mediaCandidates(
            new Request('https://example.com/api/app/media/candidates', {
                method: 'POST',
                body: JSON.stringify({
                    kind: 'logo',
                    mode: 'search',
                    items: [
                        { id: 'first', name: 'Netflix', website: 'https://netflix.com' },
                        { id: 'second', name: 'Spotify', website: 'https://spotify.com' },
                    ],
                }),
            }),
        )
        const data = await response.json() as { items: Array<{ appStore: unknown[] }> }
        assertEquals(requests, 0)
        assertEquals(data.items.map((item) => item.appStore.length), [0, 0])
    } finally {
        globalThis.fetch = originalFetch
    }
})

Deno.test('App Store failures do not remove favicon candidates', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error('Apple unavailable'))) as typeof fetch
    try {
        const response = await mediaCandidates(
            new Request('https://example.com/api/app/media/candidates', {
                method: 'POST',
                body: JSON.stringify({
                    kind: 'logo',
                    mode: 'search',
                    items: [{ id: 'search', name: 'Netflix', website: 'https://netflix.com' }],
                    onlineIconSources: { appStore: { enabled: true, storefronts: ['us'] } },
                }),
            }),
        )
        const data = await response.json() as {
            items: Array<{ appStore: unknown[]; favicon: unknown[]; best: unknown }>
        }
        assertEquals(data.items[0].appStore, [])
        assertEquals(data.items[0].favicon.length, 1)
        assertEquals(data.items[0].best !== null, true)
    } finally {
        globalThis.fetch = originalFetch
    }
})
