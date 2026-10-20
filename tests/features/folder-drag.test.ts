import { assertEquals } from '@std/assert'
import '../init.ts'
import type { LinkElem, LinkFolder } from '../../src/types/shared.ts'

const html = await Deno.readTextFile(new URL('../../src/index.html', import.meta.url))
document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML

const { SYNC_DEFAULT, LOCAL_DEFAULT } = await import('../../src/scripts/defaults.ts')
const { storage } = await import('../../src/scripts/storage.ts')
const { quickLinks } = await import('../../src/scripts/features/links/index.ts')
const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

async function renderFolder(count = 3): Promise<HTMLAnchorElement> {
    const sync = structuredClone(SYNC_DEFAULT)
    sync.linkstyle = 'large'
    sync.linkgroups = { on: true, selected: 'default', groups: ['default'], pinned: [], synced: [] }
    sync.linksfolder = { _id: 'linksfolder', title: 'Work', folder: true, size: 'large', parent: 'default', order: 0 }
    for (let i = 0; i < count; i++) {
        const id = `links${String(i).padStart(6, '0')}`
        sync[id] = {
            _id: id,
            title: `App ${i}`,
            url: `https://example.com/${i}`,
            parent: 'linksfolder',
            order: i,
        }
    }
    localStorage.bonjourr = JSON.stringify(sync)
    await storage.init()
    document.getElementById('linkblocks')!.className = ''
    for (const group of document.querySelectorAll('.link-group')) group.remove()
    await quickLinks({ sync, local: structuredClone(LOCAL_DEFAULT) })
    const anchor = document.querySelector<HTMLAnchorElement>('.folder-app')!
    setBounds(anchor.closest('.link-icon')!, 100, 100, 240, 240)
    setBounds(anchor.querySelector('img')!, 120, 120, 48, 48)
    return anchor
}

function setBounds(element: Element, x: number, y: number, width: number, height: number): void {
    element.getBoundingClientRect = () => new DOMRect(x, y, width, height)
}

function pointer(target: Element, type: string, x: number, y: number, pointerType = 'mouse'): void {
    target.dispatchEvent(
        new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            pointerType,
            clientX: x,
            clientY: y,
        }),
    )
}

for (const pointerType of ['mouse', 'touch']) {
    Deno.test({
        name:
            `A ${pointerType} drag extracts a preview app using release coordinates even with a captured event target`,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: async () => {
            const anchor = await renderFolder()
            pointer(anchor, 'pointerdown', 130, 130, pointerType)
            pointer(anchor, 'pointermove', 500, 500, pointerType)
            assertEquals(document.querySelectorAll('.folder-drag-preview').length, 1)
            assertEquals(document.querySelector('.link-group')?.classList.contains('in-drag'), false)
            pointer(anchor, 'pointerup', 500, 500, pointerType)
            await flush()
            const data = await storage.sync.get()
            assertEquals((data.links000000 as LinkElem).parent, 'default')
            assertEquals((data.links000001 as LinkElem).parent, 'linksfolder')
            assertEquals((data.linksfolder as LinkFolder).parent, 'default')
            assertEquals(document.querySelectorAll('.large-folder .folder-app').length, 2)
            assertEquals(document.querySelectorAll('.link-list > #links000000').length, 1)
            assertEquals(document.querySelector('.folder-drag-preview'), null)
        },
    })
}

Deno.test({
    name: 'Dropping a preview app back inside the folder preserves membership and suppresses the post-drag click',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderFolder()
        pointer(anchor, 'pointerdown', 130, 130)
        pointer(anchor, 'pointermove', 200, 200)
        pointer(anchor, 'pointerup', 200, 200)
        const click = new MouseEvent('click', { bubbles: true, cancelable: true })
        anchor.dispatchEvent(click)
        await flush()
        assertEquals(click.defaultPrevented, true)
        assertEquals(((await storage.sync.get()).links000000 as LinkElem).parent, 'linksfolder')
        assertEquals(document.querySelector('.folder-drag-preview'), null)
        assertEquals(document.querySelector('.extracting-app'), null)
    },
})

Deno.test({
    name: 'Cancelling a preview drag leaves its app in the folder',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderFolder()
        pointer(anchor, 'pointerdown', 130, 130, 'touch')
        pointer(anchor, 'pointermove', 500, 500, 'touch')
        pointer(anchor, 'pointercancel', 500, 500, 'touch')
        await flush()
        assertEquals(((await storage.sync.get()).links000000 as LinkElem).parent, 'linksfolder')
        assertEquals(document.querySelector('.folder-drag-preview'), null)
    },
})

Deno.test({
    name: 'Extracting an app from a two-app folder restores both apps to the desktop and removes the folder',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderFolder(2)
        pointer(anchor, 'pointerdown', 130, 130)
        pointer(anchor, 'pointermove', 500, 500)
        pointer(anchor, 'pointerup', 500, 500)
        await flush()
        const data = await storage.sync.get()
        assertEquals(data.linksfolder, undefined)
        assertEquals((data.links000000 as LinkElem).parent, 'default')
        assertEquals((data.links000001 as LinkElem).parent, 'default')
        assertEquals(document.querySelectorAll('.link-list > .link-elem').length, 2)
    },
})

Deno.test({
    name:
        'Pressing an expanded app captures its image rather than the list item so a normal click still targets the link',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderFolder()
        document.querySelector<HTMLButtonElement>('.folder-more')!.click()
        await flush(150)
        const image = document.querySelector<HTMLImageElement>('#links000000 img')!
        const item = image.closest('li')!
        const captured: string[] = []
        image.setPointerCapture = () => captured.push('image')
        item.setPointerCapture = () => captured.push('item')
        pointer(image, 'pointerdown', 130, 130)
        pointer(image, 'pointerup', 130, 130)
        assertEquals(captured, ['image'])
        assertEquals(document.querySelector('.in-drag'), null)
    },
})

for (const outside of [true, false]) {
    Deno.test({
        name: `An expanded folder ${outside ? 'releases' : 'retains'} a captured app dropped ${
            outside ? 'outside' : 'inside'
        } its bounds`,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: async () => {
            await renderFolder()
            document.querySelector<HTMLButtonElement>('.folder-more')!.click()
            await flush(150)
            const group = document.querySelector('.link-group')!
            setBounds(group, 100, 100, 240, 280)
            setBounds(group.querySelector('.link-list')!, 100, 100, 240, 240)
            for (const [i, item] of group.querySelectorAll('li').entries()) {
                setBounds(item, 120 + i * 70, 120, 64, 64)
            }
            const anchor = document.querySelector<HTMLAnchorElement>('#links000000 a')!
            pointer(anchor, 'pointerdown', 130, 130)
            pointer(anchor, 'pointermove', 155, 130)
            const end = outside ? 500 : 155
            pointer(anchor, 'pointerup', end, end)
            await flush(260)
            assertEquals(
                ((await storage.sync.get()).links000000 as LinkElem).parent,
                outside ? 'default' : 'linksfolder',
            )
            assertEquals(group.classList.contains('in-folder'), !outside)
            assertEquals(document.querySelector('.in-drag'), null)
        },
    })
}
