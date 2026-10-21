import { assertEquals, assertRejects } from '@std/assert'
import '../init.ts'
import { fetchWithTimeout } from '../../src/scripts/shared/network.ts'
import { uploadCloudMedia } from '../../src/scripts/features/synchronization/cloud-data.ts'
import { sha256 } from '../../src/scripts/shared/cloud.ts'

function emptyStreamResponse(status: number): Response {
    const response = new Response(new Uint8Array())
    // Reproduce Chrome exposing a stream even for a response that cannot have a body.
    Object.defineProperty(response, 'status', { value: status })
    return response
}

Deno.test('Network adapter accepts null-body statuses even when Chrome exposes an empty stream', async () => {
    const original = globalThis.fetch
    try {
        for (const status of [204, 205, 304]) {
            const response = emptyStreamResponse(status)
            globalThis.fetch = (() => Promise.resolve(response)) as typeof fetch
            assertEquals(await fetchWithTimeout('https://example.com/'), response)
        }
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('Cloud media uploads a missing chunk and accepts an empty streamed 204 response', async () => {
    const original = globalThis.fetch
    const bytes = new TextEncoder().encode('test icon')
    const hash = await sha256(bytes)
    const requests: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        assertEquals(String(input), `https://cloud.example/api/assets/${hash}`)
        requests.push(init!.method!)
        if (init?.method === 'HEAD') return new Response(null, { status: 404 })
        assertEquals(await (init?.body as Blob).text(), 'test icon')
        return emptyStreamResponse(204)
    }) as typeof fetch
    try {
        await uploadCloudMedia({
            url: 'https://cloud.example',
            token: 'test-token',
            deviceId: 'test',
            name: 'Test',
            owner: true,
        }, {
            records: {
                'icon/x-icon-test': JSON.stringify({
                    type: 'image/png',
                    bytes: bytes.length,
                    parts: [{ hash, bytes: bytes.length }],
                }),
            },
            files: new Map([['icon/x-icon-test', new Blob([bytes], { type: 'image/png' })]]),
        })
        assertEquals(requests, ['HEAD', 'PUT'])
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('Network adapter times out while reading the body, not just waiting for headers', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
                controller.enqueue(new Uint8Array([1]))
            },
        })
        return Promise.resolve(new Response(stream))
    }) as typeof fetch
    try {
        await assertRejects(() => fetchWithTimeout('https://example.com/', {}, 100, 5), Error, '超时')
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('Network adapter bounds streamed response size without trusting Content-Length', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response('too much data'))) as typeof fetch
    try {
        await assertRejects(() => fetchWithTimeout('https://example.com/', {}, 2), Error, '大小')
    } finally {
        globalThis.fetch = original
    }
})
