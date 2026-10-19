import { assertEquals } from '@std/assert'
import '../init.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import { searchLinks } from '../../src/scripts/features/search-index.ts'

Deno.test('Unified search finds links on other pages and inside folders', () => {
    const data = {
        ...structuredClone(SYNC_DEFAULT),
        folder1: { _id: 'folder1', folder: true as const, title: '文档', parent: '工作', order: 0 },
        app1: { _id: 'app1', title: 'Deno Docs', url: 'https://docs.deno.com/', parent: 'folder1', order: 0 },
        app2: { _id: 'app2', title: '生活', url: 'https://example.com/', parent: '生活', order: 0 },
    }
    assertEquals(searchLinks(data, '工作 文档')[0]?.url, 'https://docs.deno.com/')
    assertEquals(searchLinks(data, 'deno')[0]?.text, 'Deno Docs')
    assertEquals(searchLinks(data, 'missing'), [])
    assertEquals(searchLinks(data, '  '), [])
})

Deno.test('Unified search handles cyclic folders and excludes executable URLs', () => {
    const data = {
        ...structuredClone(SYNC_DEFAULT),
        cyclic: { _id: 'cyclic', folder: true as const, title: '循环', parent: 'cyclic', order: 0 },
        link: { _id: 'link', title: 'Safe', url: 'https://example.com/', parent: 'cyclic', order: 0 },
        unsafe: { _id: 'unsafe', title: 'Unsafe', url: 'javascript:alert(1)', order: 0 },
    }
    assertEquals(searchLinks(data, 'safe').length, 1)
    assertEquals(searchLinks(data, 'unsafe'), [])
})
