import { getLinksInGroup } from './helpers.ts'
import { initblocks, linksUpdate, resetLinkScroll } from './index.ts'
import { startDrag } from './drag.ts'

import { transitioner } from '../../utils/transitioner.ts'
import { tradThis } from '../../utils/translations.ts'
import { storage } from '../../storage.ts'

import type { LinkGroups, Sync } from '../../../types/sync.ts'

const domlinkblocks = document.getElementById('linkblocks') as HTMLDivElement

export function initGroups(data: Sync, init?: true): void {
    if (!init) {
        for (const node of document.querySelectorAll('#link-mini button') ?? []) {
            node.remove()
        }
    }

    createGroups(data.linkgroups)

    // navigating through groups with scroll wheel
    if (init) {
        document.querySelector('#link-mini')?.addEventListener('wheel', (event) => {
            changeGroup(event)
            event.preventDefault()
        }, { passive: false })
    }
    if (init) {
        const form = document.querySelector<HTMLFormElement>('#app-page-form')
        const input = document.querySelector<HTMLInputElement>('#app-page-name')
        const status = document.getElementById('app-page-status')
        form?.addEventListener('submit', async (event) => {
            event.preventDefault()
            const title = input?.value.trim() ?? ''
            const current = await storage.sync.get()
            if (!title || title === '+' || title === 'default' || current.linkgroups.groups.includes(title)) {
                if (status) status.textContent = '请输入不重复的页面名称。'
                return
            }
            await linksUpdate({ addGroups: [{ title }], groups: true })
            form.classList.add('hidden')
            if (input) input.value = ''
            if (status) status.textContent = ''
        })
        document.getElementById('app-page-cancel')?.addEventListener('click', () => form?.classList.add('hidden'))
        document.querySelector('#link-mini')?.addEventListener('keydown', (event) => {
            const e = event as KeyboardEvent
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.link-title:not(.add-group)'))
            if (!buttons.length) return
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const next = e.key === 'Home'
                ? 0
                : e.key === 'End'
                ? buttons.length - 1
                : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
            e.preventDefault()
            buttons[next].click()
            buttons[next].focus()
        })
    }
}

function createGroups(linkgroups: LinkGroups): void {
    const { groups, pinned, synced, selected } = linkgroups

    for (const group of [...groups, '+']) {
        const button = document.createElement('button')
        const isTopSite = group === 'topsites'
        const isDefault = group === 'default'
        const isAddMore = group === '+'

        if (pinned.includes(group)) {
            continue
        }

        button.textContent = group
        button.dataset.group = group
        button.classList.add('link-title')
        button.classList.toggle('selected-group', group === selected)
        button.classList.toggle('synced', synced.includes(group))

        if (isTopSite) {
            button.textContent = tradThis('Most visited')
            button.classList.add('topsites-title')
        }

        if (isDefault) {
            button.textContent = tradThis('Favorites')
        }

        if (isAddMore) {
            button.classList.add('add-group')
            button.setAttribute('aria-label', tradThis('New app page'))
            button.addEventListener('click', () => {
                document.getElementById('app-page-form')?.classList.remove('hidden')
                document.getElementById('app-page-name')?.focus()
            })
        } else {
            button.setAttribute('aria-pressed', String(group === selected))
            button.addEventListener('click', changeGroup)
            button.addEventListener('pointerdown', startDrag)
        }

        document.querySelector('#link-mini div')?.appendChild(button)
    }

    domlinkblocks?.classList.toggle('with-groups', linkgroups.on)
}

function changeGroup(event: Event): void {
    let button: HTMLButtonElement

    if (event.type === 'wheel') {
        // all the selectable group buttons
        const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>('.link-title:not(.add-group)[data-group]'),
        )

        // gets the index of the currently selected group
        const index = buttons.findIndex((btn) => btn.classList.contains('selected-group'))

        button = buttons[
            // unsmooth brain thing to get the index for the previous/next button
            (index + ((event as WheelEvent).deltaY > 0 ? 1 : -1) + buttons.length) % buttons.length
        ]
    } else { // click event (probably)
        button = event.currentTarget as HTMLButtonElement
    }

    const transition = transitioner()

    if (!!domlinkblocks.dataset.folderid || button.classList.contains('selected-group')) {
        return
    }

    transition.first(hideCurrentGroup)
    transition.after(recreateLinksFromNewGroup)
    transition.finally(showNewGroup)
    transition.transition(100)

    async function recreateLinksFromNewGroup(): Promise<void> {
        const buttons = document.querySelectorAll<HTMLElement>('#link-mini button')
        const data = await storage.sync.get()
        const group = button.dataset.group ?? data.linkgroups.groups[0]

        for (const div of buttons ?? []) {
            div.classList.remove('selected-group')
            div.setAttribute('aria-pressed', 'false')
        }
        button.classList.add('selected-group')
        button.setAttribute('aria-pressed', 'true')
        data.linkgroups.selected = group
        storage.sync.set(data)
        initblocks(data)
        resetLinkScroll()
    }

    function hideCurrentGroup(): void {
        domlinkblocks.classList.remove('in-folder')
        domlinkblocks.classList.add('hiding')
    }

    function showNewGroup(): void {
        domlinkblocks.classList.remove('hiding')
    }
}

// Updates

export function toggleGroups(on: boolean, data: Sync): Sync {
    domlinkblocks?.classList.toggle('with-groups', on)
    data.linkgroups.on = on
    return data
}

export function changeGroupTitle(title: { old: string; new: string }, data: Sync): Sync {
    const index = data.linkgroups.groups.indexOf(title.old)

    for (const link of getLinksInGroup(data, title.old)) {
        data[link._id] = {
            ...link,
            parent: title.new,
        }
    }

    data.linkgroups.groups[index] = title.new
    data.linkgroups.selected = title.new
    initGroups(data)
    return data
}

export function addGroup(groups: { title: string; sync?: boolean }[], data: Sync): Sync {
    for (const { title, sync } of groups) {
        const isReserved = title === 'default' || title === '+'
        const isAlreadyUsed = data.linkgroups.groups.includes(title)

        if (isReserved || isAlreadyUsed) {
            return data
        }

        for (const link of getLinksInGroup(data, '+')) {
            data[link._id] = {
                ...link,
                parent: title,
            }
        }

        data.linkgroups.selected = title
        data.linkgroups.groups.push(title)

        if (sync) {
            data.linkgroups.synced.push(title)
        }
    }

    initGroups(data)
    initblocks(data)
    return data
}

export function deleteGroup(group: string, data: Sync): Sync {
    const { groups, pinned, synced, selected } = data.linkgroups

    const isBroken = groups.indexOf(group) === -1
    const isMinimum = groups.length === 1

    if (isMinimum || isBroken) {
        return data
    }

    for (const link of getLinksInGroup(data, group)) {
        delete data[link._id]
    }

    data.linkgroups.selected = group === selected || pinned.includes(group) ? groups[0] : selected
    data.linkgroups.pinned = pinned.filter((p) => p !== group)
    data.linkgroups.synced = synced.filter((g) => g !== group)
    data.linkgroups.groups = groups.filter((g) => g !== group)

    if (groups.length === 2) {
        data.linkgroups.pinned = []
    }

    storage.sync.clear()
    initblocks(data)
    initGroups(data)
    return data
}

export function moveGroups(mini: string[], data: Sync): Sync {
    const userMini = mini.filter((name) => name !== '+')

    data.linkgroups.groups = data.linkgroups.pinned.concat(userMini)
    initGroups(data)

    return data
}

export async function togglePinGroup(group: string, action: 'pin' | 'unpin'): Promise<void> {
    const data = await storage.sync.get()
    const { groups, pinned } = data.linkgroups

    if (action === 'pin') {
        data.linkgroups.pinned.push(group)
    }
    if (action === 'unpin') {
        data.linkgroups.pinned = pinned.filter((pinned) => pinned !== group)
    }

    if (group === data.linkgroups.selected) {
        const unpinned = groups.filter((id) => pinned.includes(id) === false)
        data.linkgroups.selected = unpinned[0]
    }

    storage.sync.set(data)

    initblocks(data)
    initGroups(data)
}
