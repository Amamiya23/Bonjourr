import { assertEquals } from '@std/assert'
import '../init.ts'

const html = await Deno.readTextFile(new URL('../../src/index.html', import.meta.url))
const settings = await Deno.readTextFile(new URL('../../src/settings.html', import.meta.url))
const parsed = new DOMParser().parseFromString(html.replace('<!-- settings -->', settings), 'text/html')
document.body.innerHTML = parsed.body.innerHTML

const { SYNC_DEFAULT, LOCAL_DEFAULT } = await import('../../src/scripts/defaults.ts')
const { storage } = await import('../../src/scripts/storage.ts')
const { quickLinks } = await import('../../src/scripts/features/links/index.ts')
const { searchbar } = await import('../../src/scripts/features/searchbar.ts')
const { weatherApiSettings } = await import('../../src/scripts/features/weather/api-settings.ts')
const { synchronization } = await import('../../src/scripts/features/synchronization/index.ts')
const { personalLayout } = await import('../../src/scripts/features/personal-layout.ts')
const { loadCallbacks } = await import('../../src/scripts/utils/onsettingsload.ts')

localStorage.bonjourr = JSON.stringify(SYNC_DEFAULT)
await storage.init()
const sync = structuredClone(SYNC_DEFAULT)
const local = structuredClone(LOCAL_DEFAULT)
await quickLinks({ sync, local })
searchbar(sync.searchbar)
weatherApiSettings(sync, local)
synchronization(local)
personalLayout(sync)
loadCallbacks()
const flush = () => new Promise((resolve) => setTimeout(resolve, 30))

Deno.test({
    name: 'Application pages can be created without changing time, weather or search',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const fixed = ['time', 'main', 'sb_container'].map((id) => document.getElementById(id)?.outerHTML)
        const add = document.querySelector<HTMLButtonElement>('#link-mini .add-group')!
        add.click()
        const form = document.querySelector<HTMLFormElement>('#app-page-form')!
        assertEquals(form.classList.contains('hidden'), false)
        const input = document.querySelector<HTMLInputElement>('#app-page-name')!
        input.value = '工作'
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await flush()
        const data = await storage.sync.get()
        assertEquals(data.linkgroups.groups, ['default', '工作'])
        assertEquals(data.linkgroups.selected, '工作')
        assertEquals(form.classList.contains('hidden'), true)
        assertEquals(['time', 'main', 'sb_container'].map((id) => document.getElementById(id)?.outerHTML), fixed)
    },
})

Deno.test({
    name: 'Search engine can be changed from the visible search bar',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const trigger = document.querySelector<HTMLButtonElement>('#sb-engine-toggle')!
        trigger.click()
        assertEquals(document.getElementById('sb-engine-menu')?.hidden, false)
        document.querySelector<HTMLButtonElement>('#sb-engine-menu button[data-engine="bing"]')!.click()
        await flush()
        assertEquals(document.getElementById('sb_container')?.dataset.engine, 'bing')
        assertEquals(document.querySelector<HTMLSelectElement>('#i_sbengine')?.value, 'bing')
        assertEquals(document.getElementById('sb-engine-menu')?.hidden, true)
        assertEquals(trigger.querySelectorAll('.engine-search-icon').length, 1)
        assertEquals(trigger.textContent, 'Bing')
    },
})

Deno.test({
    name: 'Engine picker supports keyboard navigation, Escape and outside dismissal',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const trigger = document.querySelector<HTMLButtonElement>('#sb-engine-toggle')!
        const menu = document.getElementById('sb-engine-menu')!
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
        assertEquals(menu.hidden, false)
        assertEquals((document.activeElement as HTMLElement).dataset.engine, 'bing')
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
        assertEquals((document.activeElement as HTMLElement).dataset.engine, 'google')
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
        assertEquals((document.activeElement as HTMLElement).dataset.engine, 'baidu')
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        assertEquals(menu.hidden, true)
        assertEquals(document.activeElement, trigger)
        trigger.click()
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        assertEquals(menu.hidden, true)
        assertEquals(trigger.getAttribute('aria-expanded'), 'false')
    },
})

Deno.test({
    name: 'Search uses one shared icon, text engine names and respects explicit widths',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        assertEquals(document.documentElement.style.getPropertyValue('--searchbar-width'), '44em')
        assertEquals(document.querySelectorAll('#sb-engine-picker img').length, 0)
        assertEquals(document.querySelectorAll('#sb-engine-picker svg').length, 1)
        assertEquals(document.querySelectorAll('#sb-engine-menu svg').length, 0)
        assertEquals(
            Array.from(document.querySelectorAll<HTMLElement>('#sb-engine-menu button')).map((button) =>
                button.dataset.engine
            ),
            ['google', 'bing', 'baidu'],
        )
        searchbar(undefined, { width: '50' })
        await flush()
        assertEquals(document.documentElement.style.getPropertyValue('--searchbar-width'), '50em')
    },
})

Deno.test({
    name: 'Custom engines are added and removed only through settings, with safe query encoding',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const name = document.querySelector<HTMLInputElement>('#i_sbname')!
        const url = document.querySelector<HTMLInputElement>('#i_sbrequest')!
        name.value = 'My Search'
        url.value = 'https://example.org/search?q=%s'
        searchbar(undefined, { request: true })
        await flush()
        const saved = await storage.sync.get()
        const engine = saved.searchbar.customEngines?.[0]
        assertEquals(engine?.name, 'My Search')
        assertEquals(saved.searchbar.engine, engine?.id)
        assertEquals(document.querySelectorAll('#sb-engine-menu button').length, 4)
        assertEquals(document.getElementById('sb-engine-toggle')?.textContent?.includes('My Search'), true)
        assertEquals(document.querySelector('#sb-engine-menu [data-engine="custom"]'), null)
        const originalOpen = globalThis.open
        let opened = ''
        globalThis.open = ((url: string) => {
            opened = url
            return null
        }) as typeof globalThis.open
        try {
            document.querySelector<HTMLInputElement>('#searchbar')!.value = '中文 & test'
            document.querySelector<HTMLFormElement>('#sb_container')!.dispatchEvent(
                new Event('submit', { cancelable: true }),
            )
            assertEquals(opened, 'https://example.org/search?q=%E4%B8%AD%E6%96%87%20%26%20test')
        } finally {
            globalThis.open = originalOpen
        }
        searchbar(undefined, { removeEngine: engine!.id })
        await flush()
        assertEquals(document.querySelectorAll('#sb-engine-menu button').length, 3)
        assertEquals((await storage.sync.get()).searchbar.engine, 'google')
    },
})

Deno.test({
    name: 'Weather API form persists its local key and updates displayed weather',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const original = globalThis.fetch
        globalThis.fetch = (() =>
            Promise.resolve(Response.json({ temperature: 18, weather: '晴', city: '北京' }))) as typeof fetch
        try {
            document.querySelector<HTMLInputElement>('#weather-api-city')!.value = '北京'
            document.querySelector<HTMLInputElement>('#weather-api-key')!.value = 'uapi-test'
            document.querySelector<HTMLFormElement>('#weather-api-form')!.dispatchEvent(
                new Event('submit', { cancelable: true }),
            )
            await flush()
            assertEquals((await storage.local.get('weatherApiKey')).weatherApiKey, 'uapi-test')
            assertEquals((await storage.sync.get()).weather.city, '北京')
            assertEquals(document.getElementById('weather-api-status')?.textContent?.startsWith('连接成功'), true)
            assertEquals(document.getElementById('current-desc')?.textContent, '晴. ')
        } finally {
            globalThis.fetch = original
        }
    },
})

Deno.test({
    name: 'WebDAV connection tests show pending, success and failure feedback beside the test button',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const original = globalThis.fetch
        const form = document.querySelector<HTMLFormElement>('#webdav-form')!
        const directory = document.querySelector<HTMLInputElement>('#webdav-directory')!
        const button = document.querySelector<HTMLButtonElement>('#webdav-test')!
        const status = document.getElementById('webdav-status')!
        assertEquals(directory.value, 'Bonjourr')
        assertEquals(status.parentElement?.id, form.id)
        document.querySelector<HTMLInputElement>('#webdav-url')!.value = 'https://example.com/dav/'
        let finish: (response: Response) => void = () => {}
        globalThis.fetch = (() =>
            new Promise<Response>((resolve) => {
                finish = resolve
            })) as typeof fetch
        try {
            form.dispatchEvent(new Event('submit', { cancelable: true }))
            await flush()
            assertEquals(button.textContent, '正在测试…')
            assertEquals(button.disabled, true)
            assertEquals(status.dataset.state, 'pending')
            finish(
                new Response(
                    '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
                    { status: 207 },
                ),
            )
            await flush()
            assertEquals(status.dataset.state, 'success')
            assertEquals(status.textContent?.includes('/dav/Bonjourr/'), true)
            assertEquals((await storage.local.get('webdav')).webdav?.directory, 'Bonjourr')
            assertEquals(button.disabled, false)
            directory.value = 'My Page'
            globalThis.fetch = (() => Promise.resolve(new Response('', { status: 401 }))) as typeof fetch
            form.dispatchEvent(new Event('submit', { cancelable: true }))
            await flush()
            assertEquals(status.dataset.state, 'error')
            assertEquals(status.textContent?.includes('用户名或密码错误'), true)
            assertEquals(button.textContent, '保存并测试连接')
            assertEquals(button.disabled, false)
        } finally {
            globalThis.fetch = original
        }
    },
})

Deno.test({
    name: 'WebDAV controls are available when selected and compact layout is reversible',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        synchronization(undefined, { type: 'webdav' })
        await flush()
        assertEquals(document.getElementById('webdav-sync')?.classList.contains('shown'), true)
        assertEquals((await storage.local.get('syncType')).syncType, 'webdav')
        const input = document.querySelector<HTMLInputElement>('#compact-layout')!
        assertEquals(document.getElementById('interface')?.classList.contains('compact'), true)
        input.checked = false
        input.dispatchEvent(new Event('change'))
        await flush()
        assertEquals(document.getElementById('interface')?.classList.contains('compact'), false)
        assertEquals((await storage.sync.get()).compactLayout, false)
    },
})

Deno.test({
    name: 'General new-tab setting controls search and existing, added and recreated quick links',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const { setOpenInNewTab } = await import('../../src/scripts/features/link-navigation.ts')
        const { initblocks, linksUpdate } = await import('../../src/scripts/features/links/index.ts')
        const previous = await storage.sync.get()
        const originalOpen = globalThis.open
        const opened: unknown[][] = []
        globalThis.open = ((...args: unknown[]) => {
            opened.push(args)
            return null
        }) as typeof globalThis.open
        try {
            assertEquals(document.querySelectorAll('#i_opennewtab').length, 1)
            assertEquals(
                document.querySelector('#i_opennewtab')?.closest('.param')?.previousElementSibling?.id,
                'general_title',
            )
            assertEquals(document.querySelector('#i_sbnewtab, #i_linknewtab'), null)
            await linksUpdate({ addLinks: [{ title: 'Example', url: 'https://example.org' }] })
            await setOpenInNewTab(true)
            assertEquals(document.querySelector<HTMLAnchorElement>('#linkblocks .link a')?.target, '_blank')
            document.querySelector<HTMLInputElement>('#searchbar')!.value = 'https://example.org'
            document.querySelector<HTMLFormElement>('#sb_container')!.dispatchEvent(
                new Event('submit', { cancelable: true }),
            )
            assertEquals(opened.at(-1)?.[1], '_blank')
            await linksUpdate({ addLinks: [{ title: 'Second', url: 'https://example.net' }] })
            assertEquals(
                Array.from(document.querySelectorAll<HTMLAnchorElement>('#linkblocks .link a')).every((a) =>
                    a.target === '_blank'
                ),
                true,
            )
            const reloaded = await storage.init()
            assertEquals(reloaded.sync?.linknewtab, true)
            assertEquals(reloaded.sync?.searchbar.newtab, true)
            initblocks(reloaded.sync!)
            assertEquals(document.querySelector<HTMLAnchorElement>('#linkblocks .link a')?.target, '_blank')
            await setOpenInNewTab(false)
            assertEquals(
                document.querySelector<HTMLAnchorElement>('#linkblocks .link a')?.hasAttribute('target'),
                false,
            )
            document.querySelector<HTMLFormElement>('#sb_container')!.dispatchEvent(
                new Event('submit', { cancelable: true }),
            )
            assertEquals(opened.at(-1)?.[1], '_self')
            const disabled = await storage.sync.get()
            assertEquals(disabled.linknewtab, false)
            assertEquals(disabled.searchbar.newtab, false)
        } finally {
            globalThis.open = originalOpen
            localStorage.bonjourr = JSON.stringify(previous)
            initblocks(previous)
            document.getElementById('sb_container')?.setAttribute('data-newtab', String(previous.searchbar.newtab))
        }
    },
})

Deno.test({
    name: 'Existing search-only or quick-link-only new-tab preferences migrate to the shared setting',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const previous = localStorage.bonjourr
        try {
            for (const [links, search] of [[false, true], [true, false], [false, false]]) {
                localStorage.bonjourr = JSON.stringify({
                    ...SYNC_DEFAULT,
                    linknewtab: links,
                    searchbar: { ...SYNC_DEFAULT.searchbar, newtab: search },
                })
                const loaded = await storage.sync.get()
                assertEquals(loaded.linknewtab, links || search)
                assertEquals(loaded.searchbar.newtab, links || search)
            }
        } finally {
            localStorage.bonjourr = previous
        }
    },
})
