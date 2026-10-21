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
            isPrimary: true,
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
            if (pointerType === 'touch') await flush(480)
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
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
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
        await flush(480)
        pointer(anchor, 'pointermove', 500, 500, 'touch')
        assertEquals(document.querySelectorAll('.folder-drag-preview').length, 1)
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

async function renderApps(): Promise<HTMLAnchorElement> {
    await renderFolder()
    const sync = await storage.sync.get()
    delete sync.linksfolder
    for (let i = 0; i < 3; i++) {
        const link = sync[`links${String(i).padStart(6, '0')}`] as LinkElem
        link.parent = 'default'
    }
    localStorage.bonjourr = JSON.stringify(sync)
    for (const group of document.querySelectorAll('.link-group')) group.remove()
    await quickLinks({ sync, local: structuredClone(LOCAL_DEFAULT) })
    const group = document.querySelector('.link-group')!
    setBounds(group, 100, 100, 300, 80)
    setBounds(group.querySelector('.link-list')!, 100, 100, 300, 80)
    for (const [i, item] of group.querySelectorAll('li').entries()) {
        setBounds(item, 120 + i * 70, 120, 64, 64)
    }
    return document.querySelector<HTMLAnchorElement>('#links000000 a')!
}

function touchScrollIsBlocked(target: Element): boolean {
    const event = new Event('touchmove', { bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event.defaultPrevented
}

for (const location of ['desktop', 'folder preview', 'expanded folder', 'page navigation']) {
    Deno.test({
        name: `A touch swipe on ${location} scrolls without starting a drag, even if the finger then pauses`,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: async () => {
            let target: HTMLElement
            if (location === 'desktop') {
                target = await renderApps()
            } else {
                target = await renderFolder()
                if (location === 'expanded folder') {
                    document.querySelector<HTMLButtonElement>('.folder-more')!.click()
                    await flush(150)
                    target = document.querySelector<HTMLAnchorElement>('#links000000 a')!
                } else if (location === 'page navigation') {
                    target = document.querySelector<HTMLButtonElement>('#link-mini .link-title:not(.add-group)')!
                }
            }
            let captures = 0
            target.setPointerCapture = () => captures++
            const before = await storage.sync.get()
            pointer(target, 'pointerdown', 130, 130, 'touch')
            assertEquals(touchScrollIsBlocked(target), false)
            pointer(target, 'pointermove', 130, 180, 'touch')
            await flush(480)
            pointer(target, 'pointermove', 130, 250, 'touch')
            pointer(target, 'pointerup', 130, 250, 'touch')
            assertEquals(captures, 0)
            assertEquals(touchScrollIsBlocked(target), false)
            assertEquals(document.querySelector('.in-drag, .folder-drag-preview, .drag-ready'), null)
            assertEquals(await storage.sync.get(), before)
        },
    })
}

Deno.test({
    name: 'A touch tap with slight finger movement keeps normal link activation and never captures the pointer',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderApps()
        let captures = 0
        anchor.setPointerCapture = () => captures++
        pointer(anchor, 'pointerdown', 130, 130, 'touch')
        pointer(anchor, 'pointermove', 134, 133, 'touch')
        pointer(anchor, 'pointerup', 134, 133, 'touch')
        assertEquals(clickReachesLink(anchor), true)
        await flush(480)
        assertEquals(captures, 0)
        assertEquals(document.querySelector('.drag-ready, .in-drag'), null)
        assertEquals(touchScrollIsBlocked(anchor), false)
    },
})

for (const cancellation of ['pointercancel', 'scroll']) {
    Deno.test({
        name: `A ${cancellation} before the long press clears the pending touch gesture`,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: async () => {
            const anchor = await renderApps()
            pointer(anchor, 'pointerdown', 130, 130, 'touch')
            if (cancellation === 'pointercancel') {
                pointer(anchor, 'pointercancel', 130, 130, 'touch')
            } else {
                document.dispatchEvent(new Event('scroll'))
            }
            await flush(480)
            pointer(anchor, 'pointermove', 200, 200, 'touch')
            pointer(anchor, 'pointerup', 200, 200, 'touch')
            assertEquals(document.querySelector('.drag-ready, .in-drag'), null)
            assertEquals(touchScrollIsBlocked(anchor), false)
            assertEquals(((await storage.sync.get()).links000000 as LinkElem).order, 0)
        },
    })
}

Deno.test({
    name: 'Releasing a stationary long press opens editing instead of navigating to the app',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderApps()
        pointer(anchor, 'pointerdown', 130, 130, 'touch')
        await flush(480)
        pointer(anchor, 'pointerup', 130, 130, 'touch')
        assertEquals(clickReachesLink(anchor), false)
        await flush()
        assertEquals((document.getElementById('contextmenu') as HTMLDialogElement).open, true)
        assertEquals(document.querySelector('.drag-ready, .in-drag'), null)
        assertEquals(touchScrollIsBlocked(anchor), false)
        document.dispatchEvent(new Event('close-edit'))
        await flush(250)
    },
})

Deno.test({
    name: 'A stationary touch long press arms app reordering, blocks scrolling during drag, and clears on release',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderApps()
        pointer(anchor, 'pointerdown', 130, 130, 'touch')
        pointer(anchor, 'pointermove', 133, 132, 'touch')
        await flush(480)
        assertEquals(anchor.closest('.link')!.classList.contains('drag-ready'), true)
        assertEquals(touchScrollIsBlocked(anchor), true)
        const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        anchor.dispatchEvent(menu)
        assertEquals(menu.defaultPrevented, true)
        assertEquals((document.getElementById('contextmenu') as HTMLDialogElement).open, false)
        pointer(anchor, 'pointermove', 160, 130, 'touch')
        assertEquals(document.querySelector('.link-group')?.classList.contains('dragging'), true)
        pointer(anchor, 'pointermove', 220, 130, 'touch')
        pointer(anchor, 'pointermove', 247, 130, 'touch')
        pointer(anchor, 'pointerup', 247, 130, 'touch')
        assertEquals(clickReachesLink(anchor), false)
        assertEquals(touchScrollIsBlocked(anchor), false)
        await flush(260)
        assertEquals(((await storage.sync.get()).links000000 as LinkElem).order, 1)
        assertEquals(document.querySelector('.drag-ready, .in-drag'), null)
    },
})

function clickReachesLink(anchor: HTMLAnchorElement, detail = 1): boolean {
    let reached = false
    const listener = (event: MouseEvent): void => {
        reached = !event.defaultPrevented
        event.preventDefault()
    }
    anchor.addEventListener('click', listener)
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }))
    anchor.removeEventListener('click', listener)
    return reached
}

async function renderMixedGrid(): Promise<HTMLAnchorElement> {
    await renderFolder(9)
    const sync = await storage.sync.get()
    for (let i = 3; i < 9; i++) {
        const link = sync[`links${String(i).padStart(6, '0')}`] as LinkElem
        link.parent = 'default'
        link.order = i - 2
    }
    localStorage.bonjourr = JSON.stringify(sync)
    for (const group of document.querySelectorAll('.link-group')) group.remove()
    await quickLinks({ sync, local: structuredClone(LOCAL_DEFAULT) })
    const group = document.querySelector('.link-group')!
    setBounds(group, 100, 100, 390, 290)
    setBounds(group.querySelector('.link-list')!, 100, 100, 390, 290)
    setBounds(document.getElementById('linksfolder')!, 100, 100, 190, 190)
    for (let i = 3; i < 9; i++) {
        const column = i < 7 ? 2 + (i - 3) % 2 : i - 7
        const row = i < 7 ? Math.floor((i - 3) / 2) : 2
        setBounds(
            document.getElementById(`links${String(i).padStart(6, '0')}`)!,
            100 + column * 100,
            100 + row * 100,
            90,
            90,
        )
    }
    return document.querySelector<HTMLAnchorElement>('#links000003 a')!
}

for (const releaseOnly of [false, true]) {
    Deno.test({
        name: `A desktop app moves to the blank end of the third row beside a large folder${
            releaseOnly ? ' using release coordinates' : ''
        }`,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: async () => {
            const anchor = await renderMixedGrid()
            pointer(anchor, 'pointerdown', 320, 120)
            pointer(anchor, 'pointermove', 345, 120)
            if (!releaseOnly) pointer(anchor, 'pointermove', 350, 330)
            pointer(anchor, 'pointerup', 350, 330)
            assertEquals(clickReachesLink(anchor), false)
            await flush(260)
            const data = await storage.sync.get()
            assertEquals((data.links000003 as LinkElem).order, 6)
            assertEquals((data.links000008 as LinkElem).order, 5)
            assertEquals((data.links000003 as LinkElem).parent, 'default')
            assertEquals((data.linksfolder as LinkFolder).order, 0)
        },
    })
}

Deno.test({
    name: 'Dropping in the gap before the third row inserts the app before that row',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderMixedGrid()
        pointer(anchor, 'pointerdown', 320, 120)
        pointer(anchor, 'pointermove', 345, 120)
        pointer(anchor, 'pointermove', 140, 295)
        pointer(anchor, 'pointerup', 140, 295)
        await flush(260)
        const data = await storage.sync.get()
        assertEquals((data.links000003 as LinkElem).order, 4)
        assertEquals((data.links000007 as LinkElem).order, 5)
    },
})

Deno.test({
    name: 'Dropping outside the desktop does not append an app to its blank row',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderMixedGrid()
        pointer(anchor, 'pointerdown', 320, 120)
        pointer(anchor, 'pointermove', 345, 120)
        pointer(anchor, 'pointermove', 650, 330)
        pointer(anchor, 'pointerup', 650, 330)
        await flush(260)
        assertEquals(((await storage.sync.get()).links000003 as LinkElem).order, 1)
    },
})

Deno.test({
    name: 'Moving from a pending folder merge to blank desktop space cancels the merge',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderMixedGrid()
        pointer(anchor, 'pointerdown', 320, 120)
        pointer(anchor, 'pointermove', 345, 120)
        pointer(anchor, 'pointermove', 180, 180)
        pointer(anchor, 'pointermove', 180, 180)
        await flush(140)
        assertEquals(document.getElementById('linksfolder')!.classList.contains('drop-target'), true)
        assertEquals(document.querySelector<HTMLElement>('.link-drop-preview')!.hidden, true)
        pointer(anchor, 'pointermove', 350, 330)
        assertEquals(document.querySelector('.drop-target'), null)
        assertEquals(document.querySelector<HTMLElement>('.link-drop-preview')!.hidden, false)
        pointer(anchor, 'pointerup', 350, 330)
        await flush(260)
        const data = await storage.sync.get()
        assertEquals((data.links000003 as LinkElem).parent, 'default')
        assertEquals((data.links000003 as LinkElem).order, 6)
    },
})

Deno.test({
    name: 'App drag feedback follows its sorted slot and clears after landing',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderApps()
        pointer(anchor, 'pointerdown', 130, 130)
        pointer(anchor, 'pointermove', 160, 130)
        const preview = document.querySelector<HTMLElement>('.link-drop-preview')!
        assertEquals(preview.getAttribute('aria-hidden'), 'true')
        assertEquals(preview.style.width, '64px')
        assertEquals(preview.style.height, '64px')
        assertEquals(preview.style.transform, 'translate(20px, 20px)')
        assertEquals(document.querySelector('.drag-layout [id]'), null)
        assertEquals(document.querySelector<HTMLElement>('.drag-layout')!.inert, true)
        pointer(anchor, 'pointermove', 220, 130)
        pointer(anchor, 'pointermove', 247, 130)
        assertEquals(preview.style.transform, 'translate(90px, 20px)')
        pointer(anchor, 'pointerup', 247, 130)
        assertEquals(preview.classList.contains('settling'), true)
        assertEquals(document.querySelector('.drag-layout'), null)
        await flush(260)
        assertEquals(document.querySelector('.link-drop-preview'), null)
        assertEquals(document.getElementById('links000000')!.classList.contains('drop-landed'), true)
        await flush(280)
        assertEquals(document.querySelector('.drop-landed'), null)
    },
})

Deno.test({
    name: 'A large folder preview uses its full measured grid span after reordering',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        await renderMixedGrid()
        const folder = document.getElementById('linksfolder')!
        pointer(folder, 'pointerdown', 110, 110)
        pointer(folder, 'pointermove', 145, 110)
        const preview = document.querySelector<HTMLElement>('.link-drop-preview')!
        assertEquals(preview.classList.contains('large-folder-preview'), true)
        assertEquals(preview.style.width, '190px')
        const layout = document.querySelector('.drag-layout')!
        setBounds(layout.querySelector('.link-list')!, 0, 0, 390, 290)
        setBounds(layout.querySelector('.large-folder')!, 200, 100, 190, 190)
        for (const [i, item] of layout.querySelectorAll('.link-elem').entries()) {
            setBounds(item, (i % 4) * 100, Math.floor(i / 4) * 100, 90, 90)
        }
        pointer(folder, 'pointermove', 350, 330)
        assertEquals(preview.style.width, '190px')
        assertEquals(preview.style.height, '190px')
        assertEquals(preview.style.transform, 'translate(200px, 100px)')
        assertEquals(document.getElementById('links000003')!.style.transform, 'translate(0px, 0px)')
        pointer(folder, 'pointerup', 350, 330)
        await flush(260)
        assertEquals(((await storage.sync.get()).linksfolder as LinkFolder).order, 6)
        assertEquals(document.querySelector('.link-drop-preview'), null)
        assertEquals(document.querySelector('.drag-layout'), null)
    },
})

Deno.test({
    name: 'Drag feedback hides outside the desktop and cancellation leaves no landing highlight',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderMixedGrid()
        pointer(anchor, 'pointerdown', 320, 120)
        pointer(anchor, 'pointermove', 345, 120)
        pointer(anchor, 'pointermove', 650, 330)
        const preview = document.querySelector<HTMLElement>('.link-drop-preview')!
        assertEquals(preview.hidden, true)
        pointer(anchor, 'pointercancel', 650, 330)
        await flush(260)
        assertEquals(document.querySelector('.link-drop-preview'), null)
        assertEquals(document.querySelector('.drag-layout'), null)
        assertEquals(document.querySelector('.drop-landed'), null)
    },
})

Deno.test({
    name: 'Dropping a desktop app suppresses its generated click and preserves the next deliberate click',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderApps()
        pointer(anchor, 'pointerdown', 130, 130)
        pointer(anchor, 'pointermove', 160, 130)
        assertEquals(document.querySelector('.link-group')?.classList.contains('dragging'), true)
        assertEquals(anchor.closest<HTMLElement>('li')?.style.width, '64px')
        assertEquals(anchor.closest<HTMLElement>('li')?.style.height, '64px')
        pointer(anchor, 'pointermove', 220, 130)
        pointer(anchor, 'pointermove', 247, 130)
        pointer(anchor, 'pointerup', 247, 130)
        assertEquals(clickReachesLink(anchor), false)
        await flush(260)
        const data = await storage.sync.get()
        assertEquals((data.links000000 as LinkElem).order, 1)
        assertEquals((data.links000001 as LinkElem).order, 0)
        const currentAnchor = document.querySelector<HTMLAnchorElement>('#links000000 a')!
        assertEquals(currentAnchor.closest<HTMLElement>('li')?.style.width, '')
        assertEquals(currentAnchor.closest<HTMLElement>('li')?.style.height, '')
        pointer(currentAnchor, 'pointerdown', 160, 130)
        pointer(currentAnchor, 'pointerup', 160, 130)
        assertEquals(clickReachesLink(currentAnchor), true)
    },
})

Deno.test({
    name: 'A drag click retargeted to the destination app cannot activate that link',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderApps()
        const destination = document.querySelector<HTMLAnchorElement>('#links000001 a')!
        pointer(anchor, 'pointerdown', 130, 130)
        pointer(anchor, 'pointermove', 160, 130)
        pointer(anchor, 'pointerup', 160, 130)
        assertEquals(clickReachesLink(destination), false)
        await flush(260)
    },
})

Deno.test({
    name: 'Moving within the click deadzone still activates a desktop app',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const anchor = await renderApps()
        pointer(anchor, 'pointerdown', 130, 130)
        pointer(anchor, 'pointermove', 135, 130)
        pointer(anchor, 'pointerup', 135, 130)
        assertEquals(document.querySelector('.in-drag'), null)
        assertEquals(clickReachesLink(anchor), true)
    },
})

for (const nextGesture of ['pointerdown', 'keydown']) {
    Deno.test({
        name: `A ${nextGesture} after a drag without a generated click clears its pending click guard`,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: async () => {
            const anchor = await renderApps()
            pointer(anchor, 'pointerdown', 130, 130)
            pointer(anchor, 'pointermove', 160, 130)
            pointer(anchor, 'pointerup', 160, 130)
            await flush(260)
            if (nextGesture === 'pointerdown') {
                pointer(anchor, 'pointerdown', 130, 130)
                pointer(anchor, 'pointerup', 130, 130)
            } else {
                anchor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
            }
            assertEquals(clickReachesLink(anchor, nextGesture === 'keydown' ? 0 : 1), true)
        },
    })
}
