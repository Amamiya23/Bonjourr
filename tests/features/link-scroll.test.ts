import { assertEquals, assertExists } from '@std/assert'
import '../init.ts'

const html = await Deno.readTextFile(new URL('../../src/index.html', import.meta.url))
document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML

const { SYNC_DEFAULT, LOCAL_DEFAULT } = await import('../../src/scripts/defaults.ts')
const { storage } = await import('../../src/scripts/storage.ts')
const links = await import('../../src/scripts/features/links/index.ts')
const flush = () => new Promise((resolve) => setTimeout(resolve, 150))

const sync = structuredClone(SYNC_DEFAULT)
sync.linkgroups = { on: true, selected: 'default', groups: ['default', 'Work'], pinned: [], synced: [] }
sync.linkssmallfolder = {
    _id: 'linkssmallfolder',
    title: 'Small folder',
    folder: true,
    size: 'small',
    parent: 'default',
    order: 0,
}
sync.linkslargefolder = {
    _id: 'linkslargefolder',
    title: 'Large folder',
    folder: true,
    size: 'large',
    parent: 'default',
    order: 1,
}
for (const [index, parent] of ['linkssmallfolder', 'linkslargefolder', 'Work'].entries()) {
    const id = `linkstest${index}`
    sync[id] = {
        _id: id,
        title: `Link ${index}`,
        url: `https://example.com/${index}`,
        parent,
        order: 0,
        icon: { type: 'url', value: 'src/assets/favicons/favicon-128x128.png' },
    }
}

localStorage.bonjourr = JSON.stringify(sync)
await storage.init()
await links.quickLinks({ sync, local: structuredClone(LOCAL_DEFAULT) })

function scrollContainer(): HTMLElement {
    const container = document.getElementById('link-scroll')
    assertExists(container, 'Quick links must have a scroll container')
    return container
}

Deno.test({
    name: 'resetLinkScroll resets the quick links scroll position',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
        const container = scrollContainer()
        container.scrollTop = 180
        const reset = Reflect.get(links, 'resetLinkScroll')
        assertEquals(typeof reset, 'function')
        reset()
        assertEquals(container.scrollTop, 0)
    },
})

Deno.test({
    name: 'Switching groups resets scroll while selecting the active group preserves it',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const container = scrollContainer()
        container.scrollTop = 180
        document.querySelector<HTMLButtonElement>('#link-mini [data-group="default"]')!.click()
        await flush()
        assertEquals(container.scrollTop, 180)

        document.querySelector<HTMLButtonElement>('#link-mini [data-group="Work"]')!.click()
        await flush()
        assertEquals((await storage.sync.get()).linkgroups.selected, 'Work')
        assertEquals(container.scrollTop, 0)

        container.scrollTop = 90
        document.querySelector<HTMLButtonElement>('#link-mini [data-group="default"]')!.click()
        await flush()
        assertEquals((await storage.sync.get()).linkgroups.selected, 'default')
        assertEquals(container.scrollTop, 0)
    },
})

Deno.test({
    name: 'Ordinary quick link rerenders preserve scroll position',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const container = scrollContainer()
        container.scrollTop = 180
        links.initblocks(await storage.sync.get())
        assertEquals(container.scrollTop, 180)
    },
})

for (
    const [name, selector] of [
        ['small folder', '#linkssmallfolder'],
        ['large folder', '#linkslargefolder .folder-more'],
    ]
) {
    Deno.test({
        name: `Opening a ${name} resets scroll and closing restores its previous position`,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: async () => {
            const container = scrollContainer()
            container.scrollTop = 180
            document.querySelector<HTMLElement>(selector)!.click()
            await flush()
            assertEquals(document.querySelector('.link-group')?.classList.contains('in-folder'), true)
            assertEquals(container.scrollTop, 0)

            container.scrollTop = 70
            document.dispatchEvent(new Event('close-folder'))
            await flush()
            assertEquals(document.querySelector('.link-group')?.classList.contains('in-folder'), false)
            assertEquals(container.scrollTop, 180)
        },
    })
}
