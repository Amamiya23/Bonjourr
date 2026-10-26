import { assertEquals, assertNotEquals } from '@std/assert'
import '../init.ts'
import type { LinkElem, LinkIcon } from '../../src/types/shared.ts'
import type { Sync } from '../../src/types/sync.ts'

const html = await Deno.readTextFile(new URL('../../src/index.html', import.meta.url))
document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML

const { SYNC_DEFAULT, LOCAL_DEFAULT } = await import('../../src/scripts/defaults.ts')
const { storage } = await import('../../src/scripts/storage.ts')
const { quickLinks, linksUpdate } = await import('../../src/scripts/features/links/index.ts')
const { copyLink, hasCopiedLink } = await import('../../src/scripts/features/links/clipboard.ts')
const { getLinksInGroup, getLinksInFolder } = await import('../../src/scripts/features/links/helpers.ts')

async function renderLinks(icon?: LinkIcon, inFolder = false): Promise<void> {
    localStorage.clear()
    const sync = structuredClone(SYNC_DEFAULT)
    sync.linkstyle = 'large'
    sync.linkgroups = {
        on: true,
        selected: 'default',
        groups: ['default', 'Work', 'Pinned', 'Synced'],
        pinned: ['Pinned'],
        synced: [],
    }
    sync.linkssource = {
        _id: 'linkssource',
        title: 'Saved app',
        url: 'https://example.com/app',
        parent: inFolder ? 'linksfolder' : 'default',
        order: 0,
        ...(icon ? { icon } : {}),
    }
    sync.linksexisting = {
        _id: 'linksexisting',
        title: 'Existing app',
        url: 'https://example.com/existing',
        parent: 'Work',
        order: 0,
    }
    if (inFolder) {
        sync.linksfolder = {
            _id: 'linksfolder',
            title: 'Folder',
            parent: 'default',
            folder: true,
            size: 'large',
            order: 0,
        }
        sync.linkssibling = {
            _id: 'linkssibling',
            title: 'Sibling app',
            url: 'https://example.com/sibling',
            parent: 'linksfolder',
            order: 1,
        }
    }
    localStorage.bonjourr = JSON.stringify(sync)
    await storage.init()
    document.getElementById('linkblocks')!.className = ''
    for (const group of document.querySelectorAll('.link-group')) group.remove()
    await quickLinks({ sync, local: structuredClone(LOCAL_DEFAULT) })
    // Synced bookmark groups are read-only destinations; avoid browser bookmark initialization in this fixture.
    sync.linkgroups.synced = ['Synced']
    await storage.sync.set({ linkgroups: sync.linkgroups })
}

function copiedLink(data: Sync): LinkElem {
    const links = getLinksInGroup(data, 'Work')
    assertEquals(links.length, 2)
    return links.find((link) => link._id !== 'linksexisting') as LinkElem
}

Deno.test({
    name: 'Copy captures an app without changing data and paste creates an independent saved link',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderLinks()
        assertEquals(hasCopiedLink(), false)
        const before = await storage.sync.get()
        await linksUpdate({ pasteLink: { target: 'Work' } })
        assertEquals(await storage.sync.get(), before)
        assertEquals(await copyLink('linkssource'), true)
        assertEquals(hasCopiedLink(), true)
        assertEquals(await storage.sync.get(), before)
        await linksUpdate({ pasteLink: { target: 'Work' } })
        const data = await storage.sync.get()
        const copy = copiedLink(data)
        assertNotEquals(copy._id, 'linkssource')
        assertEquals(copy.title, 'Saved app')
        assertEquals(copy.url, 'https://example.com/app')
        assertEquals(copy.parent, 'Work')
        assertEquals(copy.order, 1)
        assertEquals(data.linkssource, before.linkssource)
        assertEquals(data.linkgroups.selected, 'default')
    },
})

Deno.test({
    name: 'Paste retains the title URL and icon captured before the original app was changed',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        for (
            const icon of [
                { type: 'auto', value: 'https://example.com/favicon?r=123' },
                { type: 'url', value: 'https://example.com/custom.svg' },
            ] satisfies LinkIcon[]
        ) {
            await renderLinks(icon)
            await copyLink('linkssource')
            const source = (await storage.sync.get()).linkssource as LinkElem
            await storage.sync.set({ linkssource: { ...source, title: 'Changed', url: 'https://changed.example' } })
            await linksUpdate({ pasteLink: { target: 'Work' } })
            const copy = copiedLink(await storage.sync.get())
            assertEquals(copy.title, 'Saved app')
            assertEquals(copy.url, 'https://example.com/app')
            assertEquals(copy.icon, icon)
        }
    },
})

Deno.test({
    name: 'A copied app and its file icon survive deleting the original before pasting',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderLinks({ type: 'file', value: 'custom.png' })
        const image = 'data:image/png;base64,aWNvbg=='
        await storage.local.set({ 'x-icon-linkssource': image })
        await copyLink('linkssource')
        await linksUpdate({ deleteLinks: ['linkssource'] })
        await linksUpdate({ pasteLink: { target: 'Work' } })
        const copy = copiedLink(await storage.sync.get())
        assertEquals(copy.icon, { type: 'file', value: 'custom.png' })
        const key = `x-icon-${copy._id}` as const
        assertEquals((await storage.local.get(key))[key], image)
        assertEquals((await storage.sync.get()).linkssource, undefined)
        assertEquals((await storage.sync.get())[copy._id], copy)
    },
})

Deno.test({
    name: 'Invalid copies preserve the clipboard and paste validates pages and folders',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderLinks(undefined, true)
        await copyLink('linkssource')
        for (const id of ['missing', 'linksfolder', 'linkgroups']) {
            assertEquals(await copyLink(id), false)
        }
        const before = await storage.sync.get()
        for (const target of ['Missing', 'Synced', 'linkssource']) {
            await linksUpdate({ pasteLink: { target } })
        }
        assertEquals(await storage.sync.get(), before)
        await linksUpdate({ pasteLink: { target: 'Work' } })
        await linksUpdate({ pasteLink: { target: 'linksfolder' } })
        const data = await storage.sync.get()
        assertEquals(copiedLink(data).title, 'Saved app')
        assertEquals(getLinksInFolder(data, 'linksfolder').length, 3)
        assertEquals((data.linkssource as LinkElem).parent, 'linksfolder')
        assertEquals((data.linkssibling as LinkElem).parent, 'linksfolder')
    },
})

Deno.test({
    name: 'Repeated pastes append independent links and allow the original and pinned pages',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderLinks()
        await copyLink('linkssource')
        await linksUpdate({ pasteLink: { target: 'Work' } })
        await linksUpdate({ pasteLink: { target: 'Work' } })
        await linksUpdate({ pasteLink: { target: 'default' } })
        await linksUpdate({ pasteLink: { target: 'Pinned' } })
        const data = await storage.sync.get()
        const work = getLinksInGroup(data, 'Work')
        assertEquals(work.map((link) => link.order), [0, 1, 2])
        assertEquals(new Set(work.map((link) => link._id)).size, 3)
        assertEquals(getLinksInGroup(data, 'default').length, 2)
        assertEquals(getLinksInGroup(data, 'Pinned').length, 1)
    },
})
