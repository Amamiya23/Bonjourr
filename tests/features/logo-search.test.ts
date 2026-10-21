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

async function showSearchResult(
    state: NonNullable<MediaCandidateResult['appStoreStatus']>['state'],
    extra: Partial<MediaCandidateResult> = {},
): Promise<void> {
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
                ...extra,
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

Deno.test('TheSVG candidates can be selected and report broken images without removing other sources', async () => {
    const svg = {
        id: 'theSvg:gmail:default',
        source: 'theSvg' as const,
        name: 'Gmail',
        url: artwork,
        autoAssignable: false,
    }
    await showSearchResult('ok', { theSvg: [svg], theSvgStatus: { state: 'ok' }, best: svg })
    const candidate = document.querySelector<HTMLButtonElement>('.logo-group-theSvg .logo-candidate')!
    assertEquals(candidate.classList.contains('best'), true)
    candidate.click()
    assertEquals((document.getElementById('e-icon-url') as HTMLInputElement).value, artwork)
    assertEquals((document.getElementById('e-icon-type') as HTMLSelectElement).value, 'url')
    assertEquals(candidate.classList.contains('selected'), true)
    candidate.querySelector('img')!.dispatchEvent(new Event('error'))
    assertEquals(
        document.getElementById('e-logo-status')!.textContent,
        'Could not load TheSVG images. Check your connection.',
    )
    assertEquals(document.querySelectorAll('.logo-group-appStore .logo-candidate').length, 1)
    assertEquals(document.querySelectorAll('.logo-group-favicon .logo-candidate').length, 1)
})

Deno.test('TheSVG errors remain visible alongside App Store errors', async () => {
    await showSearchResult('unavailable', { theSvg: [], theSvgStatus: { state: 'unavailable' } })
    assertEquals(
        document.getElementById('e-logo-status')!.textContent,
        'Could not load TheSVG logos. Try again later. Could not load App Store logos. Try again later.',
    )
})

Deno.test('Older settings gain TheSVG defaults while preserving disabled sources', async () => {
    const saved = localStorage.getItem('bonjourr')
    storage.type.init()
    try {
        localStorage.bonjourr = JSON.stringify({
            onlineIconSources: { appStore: { enabled: false, storefronts: ['cn'] } },
        })
        const migrated = await storage.sync.get()
        assertEquals(migrated.onlineIconSources.theSvg.enabled, true)
        assertEquals(migrated.onlineIconSources.appStore, { enabled: false, storefronts: ['cn'] })
        await storage.sync.set({ onlineIconSources: { ...migrated.onlineIconSources, theSvg: { enabled: false } } })
        assertEquals((await storage.sync.get()).onlineIconSources.theSvg.enabled, false)
    } finally {
        if (saved === null) localStorage.removeItem('bonjourr')
        else localStorage.setItem('bonjourr', saved)
    }
})
