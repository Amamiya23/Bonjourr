import { tradThis } from '../utils/translations.ts'

let rebuildMenu: (() => void) | undefined

function searchIcon(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('engine-search-icon')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    circle.setAttribute('cx', '10.5')
    circle.setAttribute('cy', '10.5')
    circle.setAttribute('r', '6.5')
    const handle = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    handle.setAttribute('d', 'm15.5 15.5 4.5 4.5')
    svg.append(circle, handle)
    return svg
}

export function updateEnginePicker(select: HTMLSelectElement): void {
    const trigger = document.getElementById('sb-engine-toggle')
    const label = select.selectedOptions[0]?.textContent ?? select.value
    if (trigger) {
        const text = document.createElement('span')
        text.className = 'engine-name'
        text.textContent = label
        const chevron = document.createElement('span')
        chevron.className = 'engine-chevron'
        chevron.setAttribute('aria-hidden', 'true')
        trigger.replaceChildren(searchIcon(), text, chevron)
        trigger.setAttribute('aria-label', `${tradThis('Search engine')}: ${label}`)
        trigger.setAttribute('title', `${tradThis('Search engine')} · ${label}`)
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('#sb-engine-menu button')) {
        const selected = button.dataset.engine === select.value
        button.setAttribute('aria-checked', String(selected))
        button.classList.toggle('selected', selected)
    }
}

export function initEnginePicker(select: HTMLSelectElement): void {
    if (document.getElementById('sb-engine-toggle')) {
        rebuildMenu?.()
        updateEnginePicker(select)
        return
    }
    const picker = document.createElement('div')
    picker.id = 'sb-engine-picker'
    const trigger = document.createElement('button')
    trigger.id = 'sb-engine-toggle'
    trigger.type = 'button'
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-controls', 'sb-engine-menu')
    trigger.setAttribute('aria-expanded', 'false')
    const menu = document.createElement('div')
    menu.id = 'sb-engine-menu'
    menu.hidden = true
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', tradThis('Search engine'))
    const close = (focus = false): void => {
        menu.hidden = true
        trigger.setAttribute('aria-expanded', 'false')
        document.getElementById('sb_container')?.classList.remove('engine-menu-open')
        if (focus) trigger.focus()
    }
    const open = (last = false): void => {
        document.getElementById('sb-suggestions')?.classList.remove('shown')
        document.getElementById('searchbar')?.setAttribute('aria-expanded', 'false')
        menu.hidden = false
        trigger.setAttribute('aria-expanded', 'true')
        document.getElementById('sb_container')?.classList.add('engine-menu-open')
        const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button'))
        const selected = buttons.find((button) => button.dataset.engine === select.value)
        ;(last ? buttons.at(-1) : selected ?? buttons[0])?.focus()
    }
    rebuildMenu = () => {
        close()
        menu.replaceChildren()
        for (const option of Array.from(select.options)) {
            const button = document.createElement('button')
            button.type = 'button'
            button.tabIndex = -1
            button.dataset.engine = option.value
            button.setAttribute('role', 'menuitemradio')
            const text = document.createElement('span')
            text.textContent = option.textContent
            const check = document.createElement('span')
            check.className = 'engine-check'
            check.textContent = '✓'
            check.setAttribute('aria-hidden', 'true')
            button.append(text, check)
            button.addEventListener('click', () => {
                select.value = option.value
                updateEnginePicker(select)
                close()
                select.dispatchEvent(new Event('change', { bubbles: true }))
            })
            menu.appendChild(button)
        }
    }
    rebuildMenu()
    trigger.addEventListener('click', () => menu.hidden ? open() : close())
    trigger.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            event.stopPropagation()
            open(event.key === 'ArrowUp')
        }
    })
    menu.addEventListener('keydown', (event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close(true)
            return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button'))
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home'
            ? 0
            : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
    })
    document.addEventListener('pointerdown', (event) => {
        if (event.target instanceof Node && !picker.contains(event.target)) close()
    })
    picker.addEventListener('focusout', (event) => {
        if (!(event.relatedTarget instanceof Node) || !picker.contains(event.relatedTarget)) close()
    })
    picker.append(trigger, menu)
    select.after(picker)
    select.hidden = true
    updateEnginePicker(select)
}
