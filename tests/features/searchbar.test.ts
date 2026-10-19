import { assertEquals } from '@std/assert'
import '../init.ts'

document.body.innerHTML = `
    <main id="interface"></main>
    <dialog id="contextmenu"></dialog>
    <button id="b_interface-quotes-refresh"></button>
    <form id="sb_container">
        <input id="searchbar" />
        <ul id="sb-suggestions"></ul>
    </form>
`

const { searchbar } = await import('../../src/scripts/features/searchbar.ts')

searchbar()

Deno.test({
    name: 'Search opens results in a new tab without an opener',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        assertEquals(submitSearch('bonjourr', true), [
            ['https://www.bing.com/search?q=bonjourr', '_blank', 'noopener'],
        ])
    },
})

Deno.test({
    name: 'Search opens results in the current tab without new-tab features',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        assertEquals(submitSearch('bonjourr', false), [
            ['https://www.bing.com/search?q=bonjourr', '_self'],
        ])
    },
})

Deno.test({
    name: 'Search opens bare domains in a new tab without an opener',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        assertEquals(submitSearch('example.com', true), [
            ['https://example.com', '_blank', 'noopener'],
        ])
    },
})

Deno.test({
    name: 'Search does not open a page for empty input',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        assertEquals(submitSearch('', true), [])
    },
})

Deno.test({
    name: 'Unified search renders app results even when online suggestions are disabled',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const { storage } = await import('../../src/scripts/storage.ts')
        const { SYNC_DEFAULT } = await import('../../src/scripts/defaults.ts')
        localStorage.bonjourr = JSON.stringify({
            ...SYNC_DEFAULT,
            app: { _id: 'app', title: 'My application', url: 'https://example.com/app', parent: '工作', order: 0 },
        })
        await storage.init()
        const container = document.getElementById('sb_container') as HTMLFormElement
        const input = document.getElementById('searchbar') as HTMLInputElement
        container.dataset.suggestions = 'false'
        Object.defineProperty(document.body, 'offsetHeight', { configurable: true, value: 900 })
        input.value = 'application'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 0))
        const result = document.querySelector<HTMLElement>('#sb-suggestions li.shown')
        assertEquals(result?.dataset.url, 'https://example.com/app')
        const originalOpen = globalThis.open
        const calls: unknown[][] = []
        globalThis.open = ((...args: unknown[]) => {
            calls.push(args)
            return null
        }) as typeof globalThis.open
        try {
            result?.click()
            assertEquals(calls[0]?.[0], 'https://example.com/app')
        } finally {
            globalThis.open = originalOpen
        }
    },
})

/*
 * Functions
 */

function submitSearch(value: string, newtab: boolean): unknown[][] {
    const container = document.getElementById('sb_container') as HTMLFormElement
    const input = document.getElementById('searchbar') as HTMLInputElement
    const calls: unknown[][] = []
    const originalOpen = globalThis.open

    container.dataset.engine = 'bing'
    container.dataset.newtab = newtab.toString()
    input.value = value
    globalThis.open = ((...args: unknown[]) => {
        calls.push(args)
        return null
    }) as typeof globalThis.open

    try {
        container.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    } finally {
        globalThis.open = originalOpen
    }

    return calls
}
