import { assertEquals } from '@std/assert'
import '../init.ts'
import type { MediaCandidateResult } from '../../src/types/media.ts'

const html = await Deno.readTextFile(new URL('../../src/index.html', import.meta.url))
document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)![1]
const { SYNC_DEFAULT } = await import('../../src/scripts/defaults.ts')
const { storage } = await import('../../src/scripts/storage.ts')
const { initLogoSearch, prepareLogoSearch } = await import('../../src/scripts/features/links/logo.ts')
initLogoSearch()

const artwork = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
const favicon = { id: 'favicon:gmail', source: 'favicon' as const, name: 'Gmail', url: artwork, autoAssignable: true }
const app = { id: 'appStore:gmail', source: 'appStore' as const, name: 'Gmail', url: artwork, autoAssignable: false }

async function showSearchResult(state: NonNullable<MediaCandidateResult['appStoreStatus']>['state']): Promise<void> {
    const originalFetch = globalThis.fetch
    const originalGet = storage.sync.get
    storage.sync.get = () => Promise.resolve(structuredClone(SYNC_DEFAULT))
    globalThis.fetch = (() =>
        Promise.resolve(Response.json({
            items: [{
                id: 'search',
                query: 'gmail',
                builtIn: [],
                appStore: state === 'ok' || state === 'partial' ? [app] : [],
                favicon: [favicon],
                best: favicon,
                appStoreStatus: { state },
            }],
        }))) as typeof fetch
    try {
        prepareLogoSearch('Gmail', 'https://mail.google.com/')
        ;(document.getElementById('e-url') as HTMLInputElement).value = 'https://mail.google.com/'
        document.getElementById('b_logo-search')!.click()
        await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
        globalThis.fetch = originalFetch
        storage.sync.get = originalGet
    }
}

for (
    const [state, message] of [
        ['rateLimited', 'App Store is temporarily rate limited. Try again later.'],
        ['unavailable', 'Could not load App Store logos. Try again later.'],
        ['empty', 'No App Store logos found.'],
        ['partial', 'Some App Store regions could not be searched. Try again later.'],
    ] as const
) {
    Deno.test(`Logo search shows ${state} status even when a website favicon exists`, async () => {
        await showSearchResult(state)
        assertEquals(document.getElementById('e-logo-status')!.textContent, message)
        assertEquals(document.querySelectorAll('.logo-group-favicon .logo-candidate').length, 1)
    })
}

Deno.test('A broken App Store image reports a loading problem rather than silently leaving only the favicon', async () => {
    await showSearchResult('ok')
    assertEquals(document.getElementById('e-logo-status')!.textContent, '')
    document.querySelector('.logo-group-appStore img')!.dispatchEvent(new Event('error'))
    assertEquals(
        document.getElementById('e-logo-status')!.textContent,
        'Could not load App Store images. Check your connection.',
    )
    assertEquals(document.querySelectorAll('.logo-group-favicon .logo-candidate').length, 1)
})
