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
import type { AppStoreStorefront, MediaCandidateResult, MediaCandidatesResponse } from '../src/types/media.ts'

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
            items: MediaCandidateResult[]
        }
        assertEquals(data.items[0].appStore, [])
        assertEquals(data.items[0].favicon.length, 1)
        assertEquals(data.items[0].best !== null, true)
        assertEquals(data.items[0].appStoreStatus, { state: 'unavailable' })
    } finally {
        globalThis.fetch = originalFetch
    }
})

const gmailResult = {
    trackName: 'Gmail - Email by Google',
    sellerName: 'Google LLC',
    trackId: 422689480,
    artworkUrl512: 'https://is1-ssl.mzstatic.com/image/gmail.jpg',
}

async function searchAppStore(
    name: string,
    handle = mediaCandidates,
    storefronts: AppStoreStorefront[] = ['us'],
): Promise<MediaCandidateResult> {
    const response = await handle(
        new Request('https://example.com/api/app/media/candidates', {
            method: 'POST',
            body: JSON.stringify({
                kind: 'logo',
                mode: 'search',
                items: [{ id: 'search', name, website: 'https://mail.google.com/' }],
                onlineIconSources: { appStore: { enabled: true, storefronts } },
            }),
        }),
    )
    assertEquals(response.headers.get('Cache-Control'), 'no-store')
    return (await response.json() as MediaCandidatesResponse).items[0]
}

async function withAppStoreMock(fetcher: typeof fetch, run: () => Promise<void>): Promise<void> {
    const originalFetch = globalThis.fetch
    const originalCache = Object.getOwnPropertyDescriptor(globalThis, 'caches')
    const values = new Map<string, Response>()
    Object.defineProperty(globalThis, 'caches', {
        configurable: true,
        value: {
            default: {
                match: (request: Request) => Promise.resolve(values.get(request.url)?.clone()),
                put: (request: Request, response: Response) => {
                    values.set(request.url, response.clone())
                    return Promise.resolve()
                },
            },
        },
    })
    globalThis.fetch = fetcher
    try {
        await run()
    } finally {
        globalThis.fetch = originalFetch
        if (originalCache) Object.defineProperty(globalThis, 'caches', originalCache)
        else Reflect.deleteProperty(globalThis, 'caches')
    }
}

Deno.test('Apple 429 is reported, shares cooldown across workers, and recovers without caching the failure', async () => {
    const firstWorker = await import('./media.ts?rate-limit-first')
    const secondWorker = await import('./media.ts?rate-limit-second')
    const originalNow = Date.now
    let now = originalNow()
    let requests = 0
    let limited = true
    Date.now = () => now
    try {
        await withAppStoreMock(
            (() => {
                requests++
                return Promise.resolve(
                    limited
                        ? new Response(null, { status: 429, headers: { 'Retry-After': '30' } })
                        : Response.json({ results: [gmailResult] }),
                )
            }) as typeof fetch,
            async () => {
                const failed = await searchAppStore('Gmail', firstWorker.mediaCandidates)
                assertEquals(failed.appStoreStatus, { state: 'rateLimited', retryAfter: 30 })
                assertEquals(failed.favicon.length, 1)
                const repeated = await searchAppStore('ChatGPT', secondWorker.mediaCandidates)
                assertEquals(repeated.appStoreStatus, { state: 'rateLimited', retryAfter: 30 })
                assertEquals(requests, 1)

                now += 31000
                limited = false
                const recovered = await searchAppStore('Gmail', firstWorker.mediaCandidates)
                assertEquals(recovered.appStore.map((candidate) => candidate.id), ['appStore:422689480'])
                assertEquals(recovered.appStoreStatus, { state: 'ok' })
                assertEquals(requests, 2)
                await searchAppStore('gmail', secondWorker.mediaCandidates)
                assertEquals(requests, 2)

                limited = true
                await searchAppStore('YouTube', firstWorker.mediaCandidates)
                const cached = await searchAppStore('Gmail', firstWorker.mediaCandidates)
                assertEquals(cached.appStoreStatus, { state: 'ok' })
                assertEquals(cached.appStore.length, 1)
                assertEquals(requests, 3)
            },
        )
    } finally {
        Date.now = originalNow
    }
})

Deno.test('An unavailable storefront preserves Gmail from another region and reports partial results', async () => {
    await withAppStoreMock(
        ((input: string | URL | Request) => {
            const country = new URL(String(input)).searchParams.get('country')
            return Promise.resolve(
                country === 'us' ? Response.json({ results: [gmailResult] }) : new Response(null, { status: 503 }),
            )
        }) as typeof fetch,
        async () => {
            const result = await searchAppStore('Gmail', mediaCandidates, ['us', 'cn'])
            assertEquals(result.appStore.length, 1)
            assertEquals(result.appStoreStatus, { state: 'partial' })
        },
    )
})

Deno.test('An empty Apple search is distinct from an upstream failure', async () => {
    await withAppStoreMock((() => Promise.resolve(Response.json({ results: [] }))) as typeof fetch, async () => {
        const result = await searchAppStore('No matching app')
        assertEquals(result.appStoreStatus, { state: 'empty' })
        assertEquals(result.favicon.length, 1)
    })
})

Deno.test('Malformed Apple responses are not cached as an empty search', async () => {
    let requests = 0
    await withAppStoreMock(
        (() => {
            requests++
            return Promise.resolve(Response.json(requests === 1 ? {} : { results: [gmailResult] }))
        }) as typeof fetch,
        async () => {
            assertEquals((await searchAppStore('Gmail')).appStoreStatus, { state: 'unavailable' })
            assertEquals((await searchAppStore('Gmail')).appStoreStatus, { state: 'ok' })
            assertEquals(requests, 2)
        },
    )
})

Deno.test('A failed refresh retains stale Gmail artwork', async () => {
    const originalNow = Date.now
    let now = originalNow()
    let requests = 0
    Date.now = () => now
    try {
        await withAppStoreMock(
            (() => {
                requests++
                return requests === 1
                    ? Promise.resolve(Response.json({ results: [gmailResult] }))
                    : Promise.reject(new Error('Apple unavailable'))
            }) as typeof fetch,
            async () => {
                await searchAppStore('Gmail')
                now += 25 * 60 * 60 * 1000
                const result = await searchAppStore('Gmail')
                assertEquals(result.appStore.length, 1)
                assertEquals(result.appStoreStatus, { state: 'ok' })
                assertEquals(requests, 2)
            },
        )
    } finally {
        Date.now = originalNow
    }
})
