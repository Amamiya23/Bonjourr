import { assertEquals } from '@std/assert'
import '../init.ts'
import type { LinkFolder } from '../../src/types/shared.ts'

const html = await Deno.readTextFile(new URL('../../src/index.html', import.meta.url))
const parsed = new DOMParser().parseFromString(html, 'text/html')
document.body.innerHTML = parsed.body.innerHTML

const { SYNC_DEFAULT, LOCAL_DEFAULT } = await import('../../src/scripts/defaults.ts')
const { storage } = await import('../../src/scripts/storage.ts')
const { quickLinks, linksUpdate } = await import('../../src/scripts/features/links/index.ts')
const { openContextMenu } = await import('../../src/scripts/features/contextmenu.ts')
const flush = () => new Promise((resolve) => setTimeout(resolve, 150))

async function renderFolder(count = 13, size: LinkFolder['size'] = 'large', style = 'large'): Promise<void> {
    const sync = structuredClone(SYNC_DEFAULT)
    sync.linkstyle = style as typeof sync.linkstyle
    sync.linkgroups = { on: true, selected: 'default', groups: ['default'], pinned: [], synced: [] }
    sync.linknewtab = true
    sync.linksfolder = { _id: 'linksfolder', title: 'Work', folder: true, size, parent: 'default', order: 0 }
    for (let i = 0; i < count; i++) {
        const id = `links${String(i).padStart(6, '0')}`
        sync[id] = {
            _id: id,
            title: `App ${i}`,
            url: `https://example.com/${i}`,
            parent: 'linksfolder',
            order: i,
            icon: { type: 'url', value: 'src/assets/favicons/favicon-128x128.png' },
        }
    }
    localStorage.bonjourr = JSON.stringify(sync)
    await storage.init()
    document.getElementById('linkblocks')!.className = ''
    await quickLinks({ sync, local: structuredClone(LOCAL_DEFAULT) })
}

Deno.test({
    name: 'Large folders expose eight ordered app links and an overflow preview without nested link items',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderFolder()
        const folder = document.getElementById('linksfolder')!
        const links = folder.querySelectorAll<HTMLAnchorElement>('.folder-app')
        assertEquals(links.length, 8)
        assertEquals(Array.from(links).map((link) => link.title), Array.from({ length: 8 }, (_, i) => `App ${i}`))
        assertEquals(links[0].href, 'https://example.com/0')
        assertEquals(links[0].target, '_blank')
        assertEquals(links[0].rel, 'noreferrer noopener')
        assertEquals(folder.querySelectorAll('li').length, 0)
        assertEquals(folder.querySelectorAll('.folder-more img').length, 4)
        assertEquals(folder.querySelector<HTMLElement>('.folder-more')?.dataset.count, '+5')
    },
})

Deno.test({
    name: 'Direct app activation preserves the collapsed folder and normal keyboard link behavior',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderFolder(3)
        const anchor = document.querySelector<HTMLAnchorElement>('.folder-app')!
        const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        anchor.dispatchEvent(key)
        assertEquals(key.defaultPrevented, false)
        anchor.addEventListener('click', (event) => event.preventDefault(), { once: true })
        anchor.click()
        await flush()
        assertEquals(document.querySelector('.link-group')?.getAttribute('data-folder') ?? '', '')
        const more = document.querySelector<HTMLButtonElement>('.folder-more')!
        assertEquals(more.classList.contains('empty'), true)
        assertEquals(more.dataset.count, '')
    },
})

Deno.test({
    name: 'The overflow button expands all apps and closing restores the large folder',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderFolder()
        document.querySelector<HTMLButtonElement>('.folder-more')!.click()
        await flush()
        assertEquals(document.querySelector('.link-group')?.classList.contains('in-folder'), true)
        assertEquals(document.querySelectorAll('.link-group .link-elem').length, 13)
        document.dispatchEvent(new Event('close-folder'))
        await flush()
        assertEquals(document.querySelectorAll('.large-folder .folder-app').length, 8)
    },
})

Deno.test({
    name: 'Folder size can be changed through the context menu and persists without dropping its children',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderFolder()
        const folder = document.getElementById('linksfolder')!
        folder.addEventListener('contextmenu', openContextMenu, { once: true })
        folder.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
        await flush()
        const input = document.getElementById('e-folder-size') as HTMLSelectElement
        assertEquals(input.value, 'large')
        assertEquals(document.getElementById('edit-folder-size')?.classList.contains('on'), true)
        input.value = 'small'
        document.querySelector<HTMLButtonElement>('#edit-apply')!.click()
        await flush()
        const resized = await storage.sync.get()
        assertEquals((resized.linksfolder as LinkFolder).size, 'small')
        assertEquals(document.getElementById('linksfolder')?.classList.contains('large-folder'), false)
        await linksUpdate({ updateLink: { id: 'linksfolder', title: 'Work', folderSize: 'large' } })
        assertEquals(document.querySelectorAll('.large-folder .folder-app').length, 8)
        const stored = await storage.sync.get()
        assertEquals(
            Object.values(stored).filter((value) => (value as { parent?: string })?.parent === 'linksfolder').length,
            13,
        )
    },
})

Deno.test({
    name: 'Legacy folders remain small and text and inline layouts keep their compact presentation',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderFolder(3, undefined)
        // Remove the optional size field as in an existing backup.
        const data = await storage.sync.get()
        delete (data.linksfolder as LinkFolder).size
        localStorage.bonjourr = JSON.stringify(data)
        const { initblocks } = await import('../../src/scripts/features/links/index.ts')
        initblocks(data, structuredClone(LOCAL_DEFAULT))
        assertEquals(document.querySelector('.large-folder'), null)
        for (const style of ['inline', 'text']) {
            await renderFolder(3, 'large', style)
            assertEquals(document.querySelector('.large-folder'), null)
        }
    },
})

Deno.test({
    name: 'New folders use the large layout by default',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderFolder(3)
        await linksUpdate({ addFolder: { ids: ['links000000', 'links000001'], group: 'default' } })
        const stored = await storage.sync.get()
        const folder = Object.values(stored).find((value) =>
            (value as LinkFolder)?.folder && (value as LinkFolder)._id !== 'linksfolder'
        ) as LinkFolder
        assertEquals(folder.size, 'large')
        assertEquals(document.getElementById(folder._id)?.classList.contains('large-folder'), true)
    },
})
