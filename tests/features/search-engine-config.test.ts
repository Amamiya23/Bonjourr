import { assertEquals } from '@std/assert'
import '../init.ts'
import { configuredEngines, validSearchTemplate } from '../../src/scripts/features/search-engine-config.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'

Deno.test('Only Google, Bing and Baidu are offered before users configure extra engines', () => {
    assertEquals(configuredEngines(SYNC_DEFAULT.searchbar).map((item) => item.id), ['google', 'bing', 'baidu'])
})

Deno.test('Configured engines require names, stable user IDs and safe HTTP search templates', () => {
    const entries = configuredEngines({
        ...SYNC_DEFAULT.searchbar,
        customEngines: [
            { id: 'user-docs', name: 'Docs', url: 'https://example.org/search?q=%s' },
            { id: 'google', name: 'Fake Google', url: 'https://other.example/?q=%s' },
            { id: 'user-unsafe', name: 'Unsafe', url: 'javascript:alert("%s")' },
            { id: 'user-missing', name: 'No query', url: 'https://example.com/' },
            { id: 'user-docs', name: 'Duplicate', url: 'https://other.example/?q=%s' },
        ],
    })
    assertEquals(entries.map((item) => item.id), ['google', 'bing', 'baidu', 'user-docs'])
    assertEquals(validSearchTemplate('https://user:secret@example.com/?q=%s'), false)
    assertEquals(validSearchTemplate('file:///search?q=%s'), false)
})

Deno.test('Existing configured custom URLs appear by their hostname, without a generic custom entry', () => {
    const entries = configuredEngines({ ...SYNC_DEFAULT.searchbar, request: 'https://search.example/?q=%s' })
    assertEquals(entries.at(-1)?.name, 'search.example')
    assertEquals(entries.length, 4)
})
