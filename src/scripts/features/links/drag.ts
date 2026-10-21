import { getLiFromEvent, getTitleFromEvent } from './helpers.ts'
import { linksUpdate } from './index.ts'

type Coords = {
    x: number
    y: number
    w: number
    h: number
}

type DropType = 'mini' | 'link' | 'group'

type DropArea = 'left' | 'right' | 'center' | ''

type Dropzones = Map<string, Coords>

const blocks: Map<string, HTMLElement> = new Map()
const groups: Map<string, HTMLElement> = new Map()
const dropzones: Record<DropType, Dropzones> = {
    group: new Map(),
    link: new Map(),
    mini: new Map(),
}

let [dx, dy, cox, coy, lastIndex] = [0, 0, 0, 0, 0, 0]
let lastdropAreas: DropArea[] = ['']
let draggedGroup = ''
let draggedId = ''
let targetId = ''
let targetGroup = ''
let ids: string[] = []
let initids: string[] = []
let coords: Coords[] = []
let dragContainers: NodeListOf<HTMLElement>
let dragChangeParentTimeout: ReturnType<typeof setTimeout>
let dragAnimationFrame = 0
let dragPointerId = 0
let folderBounds: DOMRect | undefined
let desktopBounds: DOMRect | undefined
let clearDragClick: (() => void) | undefined
let dropPreview: HTMLLIElement | undefined
let dragLayout: HTMLDivElement | undefined
const layoutItems = new Map<string, HTMLElement>()

const domlinkblocks = document.getElementById('linkblocks') as HTMLDivElement
let domlinklinks: NodeListOf<HTMLLIElement>
let domlinktitles: NodeListOf<HTMLButtonElement>
let domlinkgroups: NodeListOf<HTMLDivElement>
let domlinkgroup: HTMLDivElement

// Leave native scrolling alone until a stationary long press explicitly arms a drag.
function waitForTouchDrag(event: PointerEvent, target: HTMLElement, start: (event: PointerEvent) => void): void {
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const captureTarget = event.target as Element
    let armed = false
    let started = false
    const timer = setTimeout(() => {
        if (!target.isConnected) return clear()
        armed = true
        target.classList.add('drag-ready')
    }, 450)

    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
    document.addEventListener('pointerdown', cancelOtherPointer)
    document.addEventListener('touchmove', preventScroll, { passive: false })
    document.addEventListener('touchend', clear)
    document.addEventListener('touchcancel', clear)
    document.addEventListener('contextmenu', preventMenu, true)
    document.addEventListener('scroll', cancelScroll, true)
    globalThis.addEventListener('blur', clear)

    function move(event: PointerEvent): void {
        if (event.pointerId !== pointerId || started) return
        if (!target.isConnected) return clear()
        if (Math.hypot(event.clientX - startX, event.clientY - startY) <= 8) return
        if (!armed) return clear()

        started = true
        target.classList.remove('drag-ready')
        captureTarget.setPointerCapture?.(pointerId)
        start(event)
    }

    function preventScroll(event: TouchEvent): void {
        if (armed && event.cancelable) event.preventDefault()
    }

    function preventMenu(event: Event): void {
        if (!target.contains(event.target as Node)) return
        event.preventDefault()
        event.stopImmediatePropagation()
    }

    function cancelOtherPointer(event: PointerEvent): void {
        if (!started && event.pointerId !== pointerId) clear()
    }

    function cancelScroll(): void {
        if (!started) clear()
    }

    function finish(event: PointerEvent): void {
        if (event.pointerId !== pointerId) return
        const showMenu = armed && !started && event.type === 'pointerup'
        clear()
        if (showMenu) {
            preventClickAfterDrag()
            captureTarget.dispatchEvent(
                new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: startX,
                    clientY: startY,
                }),
            )
        }
    }

    function clear(): void {
        clearTimeout(timer)
        target.classList.remove('drag-ready')
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', finish)
        document.removeEventListener('pointercancel', finish)
        document.removeEventListener('pointerdown', cancelOtherPointer)
        document.removeEventListener('touchmove', preventScroll)
        document.removeEventListener('touchend', clear)
        document.removeEventListener('touchcancel', clear)
        document.removeEventListener('contextmenu', preventMenu, true)
        document.removeEventListener('scroll', cancelScroll, true)
        globalThis.removeEventListener('blur', clear)
    }
}

function preventClickAfterDrag(): void {
    clearDragClick?.()

    function clear(): void {
        document.removeEventListener('click', suppressClick, true)
        document.removeEventListener('pointerdown', clear, true)
        document.removeEventListener('keydown', clear, true)
        clearDragClick = undefined
    }

    function suppressClick(event: MouseEvent): void {
        // Keyboard and programmatic activation do not belong to the pointer gesture.
        if (event.detail === 0) return
        event.preventDefault()
        event.stopImmediatePropagation()
        clear()
    }

    // Capture at the document: a drop can reparent the icon or retarget its click.
    document.addEventListener('click', suppressClick, true)
    document.addEventListener('pointerdown', clear, { capture: true, once: true })
    document.addEventListener('keydown', clear, { capture: true, once: true })
    clearDragClick = clear
}

export function startFolderAppDrag(event: PointerEvent): void {
    if (event.button !== 0 || domlinkblocks.classList.contains('select-all')) return
    if (event.pointerType === 'touch' && !event.isPrimary) return

    const anchor = event.currentTarget as HTMLAnchorElement
    event.stopPropagation()

    if (event.pointerType === 'touch') {
        waitForTouchDrag(event, anchor, (move) => dragFolderApp(move, anchor, event))
    } else {
        dragFolderApp(event, anchor)
    }
}

function dragFolderApp(event: PointerEvent, anchor: HTMLAnchorElement, origin = event): void {
    const folder = anchor.closest<HTMLLIElement>('.large-folder')
    const group = anchor.closest<HTMLDivElement>('.link-group')
    const panel = folder?.querySelector('.link-icon')
    const img = anchor.querySelector('img')
    const id = anchor.dataset.linkId
    if (!(folder && group && panel && img && id)) return

    anchor.setPointerCapture?.(event.pointerId)

    const bounds = panel.getBoundingClientRect()
    const iconBounds = img.getBoundingClientRect()
    const startX = origin.clientX
    const startY = origin.clientY
    const eventId = event.pointerId
    let ghost: HTMLDivElement | undefined
    let moved = false

    document.addEventListener('pointermove', move, { passive: false })
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)

    function move(event: PointerEvent): void {
        if (event.pointerId !== eventId) return
        if (!moved && Math.hypot(event.clientX - startX, event.clientY - startY) < 8) return

        event.preventDefault()
        if (!ghost) {
            moved = true
            ghost = document.createElement('div')
            ghost.className = 'folder-drag-preview'
            ghost.setAttribute('aria-hidden', 'true')
            ghost.style.width = `${iconBounds.width}px`
            ghost.style.height = `${iconBounds.height}px`
            ghost.append(img!.cloneNode(true))
            document.body.append(ghost)
            anchor.classList.add('extracting')
            folder!.classList.add('extracting-app')
        }

        const x = event.clientX - iconBounds.width / 2
        const y = event.clientY - iconBounds.height / 2
        ghost.style.transform = `translate(${x}px, ${y}px)`
    }

    function finish(event: PointerEvent): void {
        if (event.pointerId !== eventId) return
        if (moved) preventClickAfterDrag()
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', finish)
        document.removeEventListener('pointercancel', finish)
        ghost?.remove()
        anchor.classList.remove('extracting')
        folder!.classList.remove('extracting-app')

        if (
            moved && event.type === 'pointerup' && anchor.isConnected && isOutsideFolder(bounds, {
                x: event.clientX,
                y: event.clientY,
            })
        ) {
            void linksUpdate({ moveOutFolder: { ids: [id!], group: group!.dataset.group ?? '' } })
        }
    }

    if (event.type === 'pointermove') move(event)
}

function isOutsideFolder(bounds: DOMRect, { x, y }: { x: number; y: number }): boolean {
    return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom
}

export function startDrag(event: PointerEvent): void {
    const path = event.composedPath() as HTMLElement[]
    const type = path.some((element) => element?.className?.includes('link-title')) ? 'mini' : 'link'
    const isMini = type === 'mini'

    if (event.button > 0) {
        return
    }
    if (event.pointerType === 'touch' && !event.isPrimary) return

    if (event.type === 'pointerdown') {
        beforeStartDrag(event, type)
        return
    }

    ids = []
    dragPointerId = event.pointerId
    coords = []
    initids = []
    lastdropAreas = []
    targetId = ''
    lastIndex = -1
    clearTimeout(dragChangeParentTimeout)
    blocks.clear()
    dropzones.group.clear()
    dropzones.link.clear()
    dropzones.mini.clear()

    //

    domlinkgroup = path.find((node) => node?.classList?.contains('link-group')) as HTMLDivElement
    folderBounds = domlinkgroup?.classList.contains('in-folder')
        ? domlinkgroup.querySelector('.link-list')?.getBoundingClientRect()
        : undefined
    desktopBounds = !isMini && !folderBounds
        ? domlinkgroup?.querySelector('.link-list')?.getBoundingClientRect()
        : undefined
    domlinkgroups = document.querySelectorAll<HTMLDivElement>('#linkblocks .link-group')
    domlinklinks = document.querySelectorAll<HTMLLIElement>('#linkblocks li')
    domlinktitles = document.querySelectorAll<HTMLButtonElement>('#link-mini button')
    dragContainers = document.querySelectorAll<HTMLElement>(isMini ? '#link-mini' : '.link-group')

    const tagName = isMini ? 'BUTTON' : 'LI'
    const target = path.find((node) => node.tagName === tagName)
    const pos = getPosFromEvent(event)

    draggedId = findIdFromElement(target)
    draggedGroup = findIdFromElement(isMini ? target : domlinkgroup)
    targetGroup = draggedGroup

    // START RANT
    // HOW DO I CENTER THE DRAGGED GROUP ON THE CURSOR
    // AFTER UPDATING THEIR WIDTH ????????????????????
    const groupSizeOffsets: Map<string, number> = new Map()

    if (isMini) {
        const beforeMap: Map<string, number> = new Map()

        for (const group of domlinktitles) {
            beforeMap.set(group.dataset.group ?? '', group.getBoundingClientRect().x)
            group.style.width = '12ch'
        }

        for (const group of domlinktitles) {
            const id = group.dataset.group ?? ''
            const before = beforeMap.get(id) ?? 0
            const after = group.getBoundingClientRect().x

            groupSizeOffsets.set(id, after - before)
        }
    }
    // END RANT

    for (const element of [...domlinkgroups, ...domlinktitles, ...domlinklinks]) {
        const type = findTypeFromElement(element)
        const rect = element.getBoundingClientRect()
        const id = findIdFromElement(element)

        if (type !== 'group') {
            blocks.set(id, element)
        } else {
            groups.set(id, element)
        }

        dropzones[type].set(id, {
            x: rect.x,
            y: rect.y,
            h: rect.height,
            w: rect.width,
        })
    }

    if (!isMini) createDragLayout()

    for (const container of Object.values(dragContainers)) {
        const elements = container.querySelectorAll<HTMLElement>(tagName)
        const wrapper = isMini ? container : container.querySelector('.link-list')
        const rect = wrapper?.getBoundingClientRect()

        if (!rect) {
            continue
        }

        for (const element of elements) {
            const type = findTypeFromElement(element)
            const id = findIdFromElement(element, type)
            let { x, y, w, h } = dropzones[type].get(id) ?? { x: 0, y: 0, w: 0, h: 0 }

            x -= rect?.x
            y -= rect?.y

            if (type === 'link') {
                element.style.width = `${w}px`
                element.style.height = `${h}px`
            }

            ids.push(id)
            initids.push(id)
            coords.push({ x, y, w, h })

            // Only disable transitions for a few frames
            element.style.transition = 'none'
            setTimeout(() => element.style.removeProperty('transition'), 10)

            deplaceElem(element, x, y)

            if (id === draggedId) {
                cox = pos.x - x + (groupSizeOffsets.get(id) ?? 0)
                coy = pos.y - y
                dx = pos.x
                dy = pos.y
                element.classList.add('on')
            }
        }

        container.style.setProperty('--drag-width', `${Math.floor(rect?.width ?? 0)}px`)
        container.style.setProperty('--drag-height', `${Math.floor(rect?.height ?? 0)}px`)
        container.classList.add('in-drag', 'dragging')
    }

    if (!isMini) {
        dropPreview = document.createElement('li')
        dropPreview.className = 'link-drop-preview'
        dropPreview.setAttribute('aria-hidden', 'true')
        dropPreview.classList.toggle('large-folder-preview', blocks.get(draggedId)?.classList.contains('large-folder'))
        domlinkgroup.querySelector('.link-list')?.append(dropPreview)
        updateDragLayout()
    }

    document.dispatchEvent(new Event('remove-select-all'))
    dragAnimationFrame = globalThis.requestAnimationFrame(deplaceDraggedElem)

    document.documentElement.addEventListener('pointermove', moveDrag)
    document.documentElement.addEventListener('pointerup', endDrag)
    if (event.pointerType !== 'touch') {
        document.documentElement.addEventListener('pointerleave', endDrag)
    }
    document.documentElement.addEventListener('pointercancel', endDrag)
}

function beforeStartDrag(event: PointerEvent, type: 'mini' | 'link'): void {
    // Prevent drag move event if user slips on click
    // By only starting drag if pointer moves more than 10px deadzone

    const target = type === 'mini' ? getTitleFromEvent(event) : getLiFromEvent(event)
    const startX = event.clientX
    const startY = event.clientY

    if (!target) {
        return
    }

    if (event.pointerType === 'touch') {
        waitForTouchDrag(event, target, startDrag)
        return
    }

    if (event.target instanceof Element) {
        event.target.setPointerCapture?.(event.pointerId)
    }

    target?.addEventListener('pointermove', pointerDeadzone)
    target?.addEventListener('pointerup', pointerDeadzone)
    target?.addEventListener('pointercancel', pointerDeadzone)

    function pointerDeadzone(event: PointerEvent): void {
        const precision = 14
        const ox = Math.abs(startX - event.clientX)
        const oy = Math.abs(startY - event.clientY)

        const isEndEvents = event.type === 'pointerup' || event.type === 'pointercancel'
        const isHalfOutside = ox > precision / 2 || oy > precision / 2
        const isOutside = ox > precision || oy > precision

        if (isHalfOutside) {
            document.dispatchEvent(new Event('stop-select-all'))
        }

        if (isOutside && !isEndEvents) {
            startDrag(event)
        }

        if (isOutside || isEndEvents) {
            target?.removeEventListener('pointermove', pointerDeadzone)
            target?.removeEventListener('pointerup', pointerDeadzone)
            target?.removeEventListener('pointercancel', pointerDeadzone)
        }
    }
}

function moveDrag(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) return
    const { x, y } = getPosFromEvent(event)

    dx = x - cox
    dy = y - coy

    if (moveOverEmptySpace({ x, y })) return

    const [curr, id, type] = isDraggingOver({ x, y }) ?? ['', '']
    if (dropPreview) {
        dropPreview.hidden = !curr || type === 'mini' || type === 'group' ||
            !!blocks.get(draggedId)?.classList.contains('drop-source')
    }
    const last = lastdropAreas[lastdropAreas.length - 1]
    const secondlast = lastdropAreas[lastdropAreas.length - 2]
    const staysOutsideCenter = curr === last && curr !== 'center'
    const isDifferentGroup = targetGroup !== draggedGroup

    if (type === 'group') {
        targetGroup = id

        if (isDifferentGroup) {
            applyDragChangeParent(id, 'group')
        }

        if (targetGroup === draggedGroup) {
            for (const block of blocks.values()) {
                block.classList.remove('drop-target', 'drop-source')
            }

            for (const block of groups.values()) {
                block.classList.remove('drop-target', 'drop-source')
            }
        }

        return
    }

    if (staysOutsideCenter || isDifferentGroup) {
        return
    }

    if (curr === '') {
        lastdropAreas.push('')
        clearTimeout(dragChangeParentTimeout)

        for (const block of blocks.values()) {
            block.classList.remove('drop-target', 'drop-source')
        }

        for (const block of groups.values()) {
            block.classList.remove('drop-target', 'drop-source')
        }

        return
    }

    const movesFromCenter = last === 'center' && (curr === 'left' || curr === 'right')
    const movesAcrossArea = curr !== secondlast
    const staysInCenter = last === curr && curr === 'center'
    const idAtCurrentArea = ids[initids.indexOf(id)]

    if (staysInCenter) {
        applyDragChangeParent(type === 'mini' ? id : idAtCurrentArea, type)
    }

    if (movesFromCenter && movesAcrossArea) {
        applyDragMoveBlocks(id)
    }

    if (last !== curr) {
        lastdropAreas.push(curr)
    }
}

function applyDragMoveBlocks(id: string): void {
    moveDraggedToIndex(initids.indexOf(id))
}

function moveOverEmptySpace({ x, y }: { x: number; y: number }): boolean {
    if (!desktopBounds) return false

    const hover = isDraggingOver({ x, y })
    if (hover && (hover[2] !== 'group' || hover[1] !== draggedGroup)) return false

    const slots = [...domlinkgroup.querySelectorAll<HTMLLIElement>('.link-list > .link')]
        .map((item) => ({ id: item.id, zone: dropzones.link.get(item.id)! }))
        .filter((slot) => slot.zone)
    const rowHeight = Math.min(...slots.map(({ zone }) => zone.h))
    const rowGap = Number.parseFloat(getComputedStyle(domlinkgroup.querySelector('.link-list')!).rowGap) || 0

    // Include the next empty row, which has no icon to act as a drop target yet.
    if (
        x < desktopBounds.left || x > desktopBounds.right || y < desktopBounds.top ||
        y > desktopBounds.bottom + rowHeight + rowGap
    ) return false

    const remaining = initids.filter((id) => id !== draggedId)
    const next = slots.find(({ id, zone }) =>
        id !== draggedId && (y < zone.y || (y < zone.y + rowHeight && x < zone.x + zone.w / 2))
    )
    const last = slots.findLast(({ id }) => id !== draggedId)
    const index = next ? remaining.indexOf(next.id) : last ? remaining.indexOf(last.id) + 1 : 0

    targetGroup = draggedGroup
    targetId = ''
    lastdropAreas = ['']
    clearTimeout(dragChangeParentTimeout)
    for (const block of [...blocks.values(), ...groups.values()]) {
        block.classList.remove('drop-target', 'drop-source')
    }
    moveDraggedToIndex(index)
    return true
}

function moveDraggedToIndex(targetIndex: number): void {
    targetId = ''
    clearTimeout(dragChangeParentTimeout)
    for (const block of [...blocks.values(), ...groups.values()]) {
        block.classList.remove('drop-target', 'drop-source')
    }
    if (dropPreview) dropPreview.hidden = false

    if (lastIndex === targetIndex) {
        return
    }

    clearTimeout(dragChangeParentTimeout)

    lastIndex = targetIndex

    // move dragged element to target position in array
    ids.splice(ids.indexOf(draggedId), 1)
    ids.splice(targetIndex, 0, draggedId)

    updateDragLayout()

    // move all clones to new position
    for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== draggedId) {
            deplaceElem(blocks.get(ids[i]), coords[i].x, coords[i].y)
        }
    }
}

function applyDragChangeParent(id: string, type: DropType): void {
    const propertyValue = getComputedStyle(domlinkblocks).getPropertyValue('--drop-delay')
    const dropDelay = type === 'group' ? 0 : Number.parseInt(propertyValue || '120')

    clearTimeout(dragChangeParentTimeout)

    dragChangeParentTimeout = setTimeout(() => {
        const isDraggedId = id === draggedId
        const inFolder = domlinkgroup?.classList.contains('in-folder')

        if (isDraggedId || inFolder) {
            return
        }

        if (type === 'mini') {
            const selectedGroup = document.querySelector<HTMLElement>('#link-mini .link-title.selected-group')
            const selection = selectedGroup?.dataset.group ?? id

            if (selection === id) {
                return
            }
        }

        targetId = id
        if (dropPreview) dropPreview.hidden = true

        for (const block of blocks.values()) {
            block.classList.remove('drop-target', 'drop-source')
        }
        for (const block of groups.values()) {
            block.classList.remove('drop-target', 'drop-source')
        }
        blocks.get(draggedId)?.classList.toggle('drop-source', true)

        if (type === 'group') {
            groups.get(id)?.classList.toggle('drop-target', true)
        } else {
            blocks.get(id)?.classList.toggle('drop-target', true)
        }
    }, dropDelay)
}

function endDrag(event: PointerEvent): void {
    if (event.pointerId !== dragPointerId) return
    event.preventDefault()
    preventClickAfterDrag()

    document.documentElement.removeEventListener('pointermove', moveDrag)
    document.documentElement.removeEventListener('pointerup', endDrag)
    document.documentElement.removeEventListener('pointerleave', endDrag)
    document.documentElement.removeEventListener('pointercancel', endDrag)

    if (event.type === 'pointerup') {
        moveOverEmptySpace(getPosFromEvent(event))
    }

    const type = findTypeFromElement(blocks.get(draggedId))
    const group = domlinkgroup?.dataset.group ?? ''
    const newIndex = ids.indexOf(draggedId)
    const block = blocks.get(draggedId)
    const coord = coords[newIndex]

    const cancelled = event.type === 'pointercancel'
    const isDroppable = !cancelled && !!document.querySelector('.drop-source')
    const position = getPosFromEvent(event)
    const outOfFolder = !cancelled && folderBounds !== undefined && isOutsideFolder(folderBounds, position)
    const targetIdIsLink = targetId.startsWith('links') && targetId.length === 11
    const toFolder = isDroppable && targetIdIsLink
    const toTab = isDroppable && !targetIdIsLink
    const landedId = toFolder ? targetId : draggedId

    dragLayout?.remove()
    dragLayout = undefined
    layoutItems.clear()
    if (dropPreview) {
        dropPreview.hidden = cancelled || outOfFolder || toFolder || toTab || dropPreview.hidden
        dropPreview.classList.add('settling')
    }

    globalThis.cancelAnimationFrame(dragAnimationFrame)
    clearTimeout(dragChangeParentTimeout)
    blocks.get(draggedId)?.classList.remove('on')

    for (const container of dragContainers) {
        container?.classList.replace('dragging', 'dropping')
    }

    if (outOfFolder || toFolder || toTab) {
        blocks.get(draggedId)?.classList.add('removed')
    } else {
        deplaceElem(block, coord.x, coord.y)
    }

    for (const block of groups.values()) {
        block.classList.remove('drop-target', 'drop-source')
    }

    setTimeout(() => {
        dropPreview?.remove()
        dropPreview = undefined
        const targetIsFolder = blocks.get(targetId)?.classList.contains('link-folder')
        const draggedIsFolder = blocks.get(draggedId)?.classList.contains('link-folder')
        const createFolder = toFolder && !targetIsFolder && !draggedIsFolder
        const moveToFolder = toFolder && targetIsFolder && !draggedIsFolder
        const concatFolders = toFolder && targetIsFolder && draggedIsFolder

        if (type === 'mini') {
            linksUpdate({ moveGroups: ids })
        } //
        else if (createFolder) {
            linksUpdate({ addFolder: { ids: [targetId, draggedId], group } })
        } //
        else if (moveToFolder) {
            linksUpdate({ moveToFolder: { source: draggedId, target: targetId } })
        } //
        else if (concatFolders) {
            linksUpdate({ concatFolders: { source: draggedId, target: targetId } })
        } //
        else if (toTab) {
            linksUpdate({ moveToGroup: { ids: [draggedId], target: targetId } })
        } //
        else if (outOfFolder) {
            domlinkgroup.dataset.folder = ''
            domlinkgroup.classList.remove('in-folder')
            linksUpdate({ moveOutFolder: { ids: [draggedId], group } })
        } //
        else {
            linksUpdate({ moveLinks: ids })
        }

        // Yield to functions above to avoid flickering
        // Do not remove this setTimeout (or else)
        setTimeout(() => {
            for (const container of dragContainers) {
                const elements = container.querySelectorAll('li, button')

                for (const element of elements) {
                    element.removeAttribute('style')
                }

                container?.removeAttribute('style')
                container?.classList.remove('in-drag', 'dropping')
            }
            if (!cancelled && type === 'link') {
                const landed = document.getElementById(landedId)
                landed?.classList.add('drop-landed')
                setTimeout(() => landed?.classList.remove('drop-landed'), 280)
            }
        }, 1)
    }, 200)
}

//	Small stuff

function createDragLayout(): void {
    dragLayout?.remove()
    layoutItems.clear()
    dragLayout = domlinkgroup.cloneNode(true) as HTMLDivElement
    dragLayout.classList.add('drag-layout')
    dragLayout.setAttribute('aria-hidden', 'true')
    dragLayout.inert = true
    dragLayout.style.width = `${domlinkgroup.getBoundingClientRect().width}px`
    dragLayout.removeAttribute('data-group')
    for (const item of dragLayout.querySelectorAll<HTMLElement>('.link-list > .link')) {
        layoutItems.set(item.id, item)
    }
    for (const element of dragLayout.querySelectorAll('[id]')) element.removeAttribute('id')
    domlinkblocks.append(dragLayout)
}

function updateDragLayout(): void {
    const list = dragLayout?.querySelector('.link-list')
    if (list) {
        for (const id of ids) {
            const item = layoutItems.get(id)
            if (item) list.append(item)
        }
        const origin = list.getBoundingClientRect()
        for (const [id, item] of layoutItems) {
            const rect = item.getBoundingClientRect()
            // Keep the starting measurements if the layout is temporarily unmeasurable.
            if (!rect.width || !rect.height) continue
            coords[ids.indexOf(id)] = { x: rect.x - origin.x, y: rect.y - origin.y, w: rect.width, h: rect.height }
        }
    }
    const coord = coords[ids.indexOf(draggedId)]
    if (dropPreview && coord) {
        dropPreview.style.width = `${coord.w}px`
        dropPreview.style.height = `${coord.h}px`
        deplaceElem(dropPreview, coord.x, coord.y)
    }
}

function deplaceElem(dom?: HTMLElement, x = 0, y = 0): void {
    if (dom) {
        dom.style.transform = `translate(${Math.floor(x)}px, ${Math.floor(y)}px)`
    }
}

function deplaceDraggedElem(): void {
    const block = blocks.get(draggedId)

    if (block) {
        block.style.transform = `translate(${dx}px, ${dy}px)`
        dragAnimationFrame = globalThis.requestAnimationFrame(deplaceDraggedElem)
    }
}

function isDraggingOver({ x, y }: { x: number; y: number }): [DropArea, string, DropType] | undefined {
    const findArea = (zones: Dropzones) => {
        for (const [id, zone] of zones) {
            // Detect 20% left edge of dropzones ( left + corner )
            const ll = zone.x
            const lr = zone.x + zone.w * 0.2
            const lt = zone.y
            const lb = zone.y + zone.h
            const isInLeftEdge = x > ll && x < lr && y > lt && y < lb

            // Detect 20% right edge of dropzones ( right + corner )
            const rl = zone.x + zone.w * 0.8
            const rr = zone.x + zone.w
            const rt = zone.y + 0
            const rb = zone.y + zone.h
            const isInRightEdge = x > rl && x < rr && y > rt && y < rb

            // Detect 80% center of dropzones ( center + corner )
            const cl = zone.x + zone.w * 0.2
            const cr = zone.x + zone.w * 0.8
            const ct = zone.y
            const cb = zone.y + zone.h
            const isInCenter = x > cl && x < cr && y > ct && y < cb

            let area: DropArea = ''

            if (isInLeftEdge) {
                area = 'left'
            }
            if (isInRightEdge) {
                area = 'right'
            }
            if (isInCenter) {
                area = 'center'
            }

            if (area) {
                return { area, id }
            }
        }
    }

    // moche pcq cerveau qui brûle
    // <!> doit etre dans l'ordre "link", "mini", "group"

    const linkarea = findArea(dropzones.link)
    if (linkarea) {
        return [linkarea.area, linkarea.id, 'link']
    }

    const miniarea = findArea(dropzones.mini)
    if (miniarea) {
        return [miniarea.area, miniarea.id, 'mini']
    }

    const grouparea = findArea(dropzones.group)
    if (grouparea) {
        return [grouparea.area, grouparea.id, 'group']
    }
}

function getPosFromEvent(event: PointerEvent): { x: number; y: number } {
    return { x: event.clientX, y: event.clientY }
}

function findTypeFromElement(element?: HTMLElement): 'link' | 'mini' | 'group' {
    if (element?.classList.contains('link')) {
        return 'link'
    }
    if (element?.classList.contains('link-title')) {
        return 'mini'
    }
    if (element?.classList.contains('link-group')) {
        return 'group'
    }

    throw new Error('No valid type found for specified element')
}

function findIdFromElement(element?: HTMLElement, type?: 'link' | 'mini' | 'group'): string {
    const elementType = type ?? findTypeFromElement(element)

    if (elementType === 'link') {
        return element?.id ?? ''
    }
    if (elementType === 'mini') {
        return element?.dataset.group ?? ''
    }
    if (elementType === 'group') {
        return element?.dataset.group ?? ''
    }

    throw new Error('No valid type found for specified element')
}
