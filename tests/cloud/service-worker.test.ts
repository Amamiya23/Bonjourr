import { assertEquals } from '@std/assert'

const script = await Deno.readTextFile(new URL('../../src/scripts/services/service-worker.js', import.meta.url))

Deno.test('PWA cache upgrades preserve local media and bypass authenticated or external requests', async () => {
    const handlers: Record<
        string,
        (event: { request?: Request; waitUntil?: (promise: Promise<void>) => void }) => void
    > = {}
    const deleted: string[] = []
    const self = {
        location: { origin: 'https://example.com' },
        clients: { claim: () => Promise.resolve() },
        addEventListener: (name: string, callback: typeof handlers[string]) => {
            handlers[name] = callback
        },
    }
    const caches = {
        keys: () => Promise.resolve(['22.3.0', 'bonjourr-shell-old', 'local-files', 'unrelated']),
        delete: (key: string) => {
            deleted.push(key)
            return Promise.resolve(true)
        },
    }
    new Function('globalThis', 'self', 'caches', script)({}, self, caches)
    let activation: Promise<void> | undefined
    handlers.activate({
        waitUntil: (promise) => {
            activation = promise
        },
    })
    await activation
    assertEquals(deleted.sort(), ['22.3.0', 'bonjourr-shell-old'])
    for (
        const request of [
            new Request('https://example.com/api/state'),
            new Request('https://example.com/private', { headers: { Authorization: 'Bearer test' } }),
            new Request('https://external.example/image'),
        ]
    ) {
        // These must return without invoking respondWith or touching caches.
        handlers.fetch({ request })
    }
})
