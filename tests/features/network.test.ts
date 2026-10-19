import { assertRejects } from '@std/assert'
import '../init.ts'
import { fetchWithTimeout } from '../../src/scripts/shared/network.ts'

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
