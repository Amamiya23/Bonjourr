import { assertEquals } from '@std/assert'
import '../init.ts'

const html = await Deno.readTextFile(new URL('../../src/index.html', import.meta.url))
document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
const { setGridAreas } = await import('../../src/scripts/features/move/dom.ts')
const { getLayout, getWidgetsStorage } = await import('../../src/scripts/features/move/helpers.ts')
const { SYNC_DEFAULT } = await import('../../src/scripts/defaults.ts')

Deno.test('Empty weather row can collapse without changing the saved grid', () => {
    const grid = [['time'], ['main'], ['searchbar'], ['quicklinks']]
    setGridAreas(grid)

    assertEquals(document.documentElement.style.getPropertyValue('--grid'), "'time' 'main' 'searchbar' 'quicklinks'")
    assertEquals(
        document.documentElement.style.getPropertyValue('--grid-without-main'),
        "'time' 'searchbar' 'quicklinks'",
    )
    assertEquals(grid, [['time'], ['main'], ['searchbar'], ['quicklinks']])
})

Deno.test('Collapsing the weather row preserves neighboring widgets and intentional empty rows', () => {
    setGridAreas("'time quotes' 'main quotes' '. .' 'searchbar searchbar'")

    assertEquals(
        document.documentElement.style.getPropertyValue('--grid-without-main'),
        "'time quotes' '. quotes' '. .' 'searchbar searchbar'",
    )
})

Deno.test('A layout containing only weather retains a valid grid', () => {
    setGridAreas([['main']])

    assertEquals(document.documentElement.style.getPropertyValue('--grid-without-main'), "'main'")
})

Deno.test('Legacy note and timer rows no longer leave gaps or create movable widgets', () => {
    const sync = structuredClone(SYNC_DEFAULT)
    const grid = [['time'], ['notes'], ['pomodoro'], ['main'], ['searchbar'], ['quicklinks']]
    sync.move.layouts.single!.grid = grid
    sync.notes!.on = true
    sync.pomodoro.on = true

    const layout = getLayout(sync)
    const widgets: string[] = getWidgetsStorage(sync)
    assertEquals(layout.grid, [['time'], ['main'], ['searchbar'], ['quicklinks']])
    assertEquals(widgets.includes('notes'), false)
    assertEquals(widgets.includes('pomodoro'), false)
    assertEquals(sync.move.layouts.single!.grid, grid)
    assertEquals(grid.length, 6)
})

Deno.test('Legacy widget removal preserves adjacent widgets and explicit empty rows', () => {
    const sync = structuredClone(SYNC_DEFAULT)
    sync.move.layouts.single!.grid = [['time', 'quotes'], ['notes', 'quotes'], ['.', '.'], ['searchbar', 'searchbar']]

    assertEquals(getLayout(sync).grid, [['time', 'quotes'], ['.', 'quotes'], ['.', '.'], ['searchbar', 'searchbar']])
})

Deno.test('Removed widgets and their settings no longer appear in the interface', async () => {
    const settings = await Deno.readTextFile(new URL('../../src/settings.html', import.meta.url))
    const parsed = new DOMParser().parseFromString(html.replace('<!-- settings -->', settings), 'text/html')

    assertEquals(parsed.querySelector('#greetings, #notes_container, #pomodoro_container, #pomodoro-info'), null)
    assertEquals(parsed.querySelector('#i_greeting, #i_greethide, #i_notes, #i_pomodoro'), null)
    assertEquals(parsed.querySelector('[data-attribute="notes_title"], [data-attribute="pomodoro_title"]'), null)
    assertEquals(parsed.querySelector('#main_title h2')?.textContent, 'Weather')
})
