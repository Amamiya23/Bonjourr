import { assertEquals } from '@std/assert'
import '../init.ts'

const html = await Deno.readTextFile(new URL('../../src/index.html', import.meta.url))
document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)![1]

let resizeMenu = () => {}
globalThis.ResizeObserver = class extends ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
        super(callback)
        resizeMenu = () => callback([], this)
    }
}

const viewport = Object.assign(new EventTarget(), { width: 1000, height: 700, offsetLeft: 0, offsetTop: 0 })
Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 })
const { positionContextMenu } = await import('../../src/scripts/features/contextmenu.ts')
const dialog = document.getElementById('contextmenu') as HTMLDialogElement

function menuSize(width: number, height: number): void {
    dialog.getBoundingClientRect = () => new DOMRect(0, 0, width, height)
    dialog.show()
}

Deno.test('Context menu stays inside the bottom and right edges when opened', () => {
    menuSize(300, 250)
    positionContextMenu(new MouseEvent('contextmenu', { clientX: 980, clientY: 680 }))
    assertEquals(dialog.style.transform, 'translate(692px, 442px)')
})

Deno.test('Async logo results move the open menu back into view', () => {
    menuSize(300, 200)
    positionContextMenu(new MouseEvent('contextmenu', { clientX: 400, clientY: 350 }))
    assertEquals(dialog.style.transform, 'translate(400px, 350px)')
    menuSize(300, 600)
    resizeMenu()
    assertEquals(dialog.style.transform, 'translate(400px, 92px)')
    assertEquals(dialog.style.maxHeight, '684px')
})

Deno.test('Keyboard viewport changes limit menu height and respect viewport offsets', () => {
    menuSize(300, 280)
    positionContextMenu(new MouseEvent('contextmenu', { clientX: 400, clientY: 350 }))
    Object.assign(viewport, { width: 390, height: 300, offsetLeft: 20, offsetTop: 100 })
    viewport.dispatchEvent(new Event('resize'))
    assertEquals(dialog.style.transform, 'translate(102px, 112px)')
    assertEquals(dialog.style.maxHeight, '284px')
    assertEquals(dialog.style.maxWidth, '374px')
    Object.assign(viewport, { width: 1000, height: 700, offsetLeft: 0, offsetTop: 0 })
})

Deno.test('An oversized menu never moves above or to the left of the viewport', () => {
    menuSize(1200, 900)
    positionContextMenu(new MouseEvent('contextmenu', { clientX: -20, clientY: -20 }))
    assertEquals(dialog.style.transform, 'translate(8px, 8px)')
})

Deno.test('A long press near the top of a phone keeps the menu visible', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    viewport.width = 390
    menuSize(300, 200)
    positionContextMenu(Object.assign(new Event('touchstart'), { touches: [{ clientX: 350, clientY: 40 }] }))
    assertEquals(dialog.style.transform, 'translate(45px, 8px)')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
    viewport.width = 1000
})

Deno.test('Local file icons keep logo search available when switching icon types', () => {
    const select = document.getElementById('e-icon-type') as HTMLSelectElement
    const search = document.getElementById('edit-logo')!
    const file = document.getElementById('edit-icon-file')!
    const url = document.getElementById('edit-icon-url')!

    for (const type of ['file', 'url', 'auto', 'file']) {
        select.value = type
        select.dispatchEvent(new Event('change', { bubbles: true }))
        assertEquals(search.classList.contains('on'), true, type)
        assertEquals(file.classList.contains('on'), type === 'file')
        assertEquals(url.classList.contains('on'), type === 'url')
    }
})
