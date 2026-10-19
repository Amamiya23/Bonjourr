import { EXTENSION, SYNC_DEFAULT } from '../defaults.ts'
import { opacityFromHex, stringMaxSize } from '../shared/generic.ts'
import { hexColorFromSplitRange } from '../shared/dom.ts'
import { getLang, tradThis } from '../utils/translations.ts'
import { eventDebounce } from '../utils/debounce.ts'
import { apiWebSocket } from '../shared/api.ts'
import { storage } from '../storage.ts'
import { parse } from '../utils/parse.ts'
import { searchLinks } from './search-index.ts'
import type { SearchResult } from './search-index.ts'
import { getPermissions } from '../utils/permissions.ts'
import { initEnginePicker, updateEnginePicker } from './search-engines.ts'

import type { Searchbar } from '../../types/sync.ts'
import { networkForm } from '../shared/form.ts'
import { configuredEngines, validSearchTemplate } from './search-engine-config.ts'
import { onSettingsLoad } from '../utils/onsettingsload.ts'

type SearchbarUpdate = {
    removeEngine?: string
    engine?: string
    width?: string
    suggestions?: boolean
    placeholder?: string
    request?: true
    background?: true
}

type Suggestions = SearchResult[]

type UndefinedElement = Element | undefined | null

const customEngineForm = networkForm('f_sbrequest')

let socket: WebSocket | undefined
let localResults: Suggestions = []
let remoteResults: Suggestions = []
let inputRevision = 0
let sentQuery = ''
let waitingForRemote = false
let remoteTimer: ReturnType<typeof setTimeout>
let socketPromise: Promise<void> | undefined
let suggestionsReady = false
let bookmarkIndex: { title: string; url: string }[] = []
let searchConfig: Searchbar = structuredClone(SYNC_DEFAULT.searchbar)
const domainPattern = /^(?!.*\s)(?:https?:\/\/)?([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z0-9-]{2,})/i

const domsuggestions = document.getElementById('sb-suggestions') as HTMLUListElement | undefined
const domcontainer = document.getElementById('sb_container') as HTMLDivElement | undefined
const domsearchbar = document.getElementById('searchbar') as HTMLInputElement | undefined
const dombuttons = document.getElementById('sb-buttons') as HTMLDivElement | undefined
const emptyButton = document.getElementById('sb_empty')

const display = (shown = false) => domcontainer?.classList.toggle('hidden', !shown)
const setEngine = (value = 'google') => {
    domcontainer?.setAttribute('data-engine', value)
    for (const id of ['sb-engine', 'i_sbengine']) {
        const select = document.getElementById(id) as HTMLSelectElement | null
        if (select) select.value = value
        if (select?.id === 'sb-engine') updateEnginePicker(select)
    }
}
const setRequest = (value = '') => domcontainer?.setAttribute('data-request', stringMaxSize(value, 512))
const setNewtab = (value = false) => domcontainer?.setAttribute('data-newtab', value.toString())
const setSuggestions = (value = true) => domcontainer?.setAttribute('data-suggestions', value.toString())
const setPlaceholder = (value = '') =>
    domsearchbar?.setAttribute('placeholder', value || tradThis('Search apps, bookmarks or the web'))
const setWidth = (value = 44) =>
    document.documentElement.style.setProperty('--searchbar-width', `${value.toString()}em`)
const setBackground = (value = '#fff2') => {
    document.documentElement.style.setProperty('--searchbar-background', value)
    document
        .getElementById('sb_container')
        ?.classList.toggle('opaque', value.includes('#fff') && opacityFromHex(value) > 7)
}

export function searchbar(init?: Searchbar, update?: SearchbarUpdate): void {
    if (update) {
        updateSearchbar(update)
        return
    }

    try {
        searchConfig = { ...SYNC_DEFAULT.searchbar, ...init }
        if (!configuredEngines(searchConfig).some((engine) => engine.id === searchConfig.engine)) {
            searchConfig.engine = 'google'
        }
        display(init?.on)
        setWidth(init?.width)
        refreshEngineOptions()
        setEngine(searchConfig.engine)
        setRequest(init?.request)
        setNewtab(init?.newtab)
        setPlaceholder(init?.placeholder)
        setSuggestions(init?.suggestions)
        setBackground(init?.background)

        dombuttons?.addEventListener('click', focusSearchbar)
        emptyButton?.addEventListener('click', removeInputText)
        domcontainer?.addEventListener('submit', submitSearch)
        domsearchbar?.addEventListener('input', handleUserInput)

        // closes context menu when searchbar is focused
        domsearchbar?.addEventListener('focus', () => {
            document.dispatchEvent(new Event('close-edit'))
            domsearchbar.focus()
        })

        document.addEventListener('keydown', searchbarShortcut)
        const engine = document.querySelector<HTMLSelectElement>('#sb-engine')
        if (engine) {
            engine.value = searchConfig.engine
            initEnginePicker(engine)
            engine.addEventListener('change', async () => {
                setEngine(engine.value)
                searchbar(undefined, { engine: engine.value })
                remoteResults = []
                if (domsearchbar?.value) handleUserInput(new Event('input'))
                domsearchbar?.focus()
            })
        }
        domsearchbar?.addEventListener('focus', () => {
            void loadBookmarkIndex().catch(() => {
                bookmarkIndex = []
            })
        })
        onSettingsLoad(renderCustomEngines)
        document.addEventListener('language-updated', () => {
            setPlaceholder(searchConfig.placeholder)
            refreshEngineOptions()
            renderCustomEngines()
        })
        document.getElementById('search-bookmarks-enable')?.addEventListener('click', async () => {
            const status = document.getElementById('search-bookmarks-status')
            try {
                const allowed = await getPermissions('bookmarks')
                if (status) status.textContent = allowed ? '已启用' : '未授权'
                if (allowed) await loadBookmarkIndex()
            } catch (_) {
                if (status) status.textContent = '当前环境不可用'
            }
        })
    } catch (_) {
        //...
    }
}

async function updateSearchbar({
    removeEngine,
    engine,
    background,
    placeholder,
    request,
    suggestions,
    width,
}: SearchbarUpdate): Promise<void> {
    const { searchbar } = await storage.sync.get('searchbar')

    if (!searchbar) {
        return
    }

    if (engine && isValidEngine(engine)) {
        searchbar.engine = engine
        setEngine(engine)
    }

    if (suggestions !== undefined) {
        searchbar.suggestions = suggestions
        setSuggestions(suggestions)
    }

    if (width !== undefined) {
        searchbar.width = Number.parseInt(width)
        setWidth(searchbar.width)
    }

    if (placeholder !== undefined) {
        searchbar.placeholder = placeholder
        setPlaceholder(placeholder)
    }

    if (background) {
        searchbar.background = hexColorFromSplitRange('sb-background-range')
        setBackground(searchbar.background)
    }

    if (request) {
        const form = document.querySelector<HTMLFormElement>('#f_sbrequest')

        if (!form) {
            return
        }

        const formdata = new FormData(form)
        const value = formdata.get('sbrequest')?.toString() ?? ''
        const name = String(formdata.get('sbname') ?? '').trim().slice(0, 32)
        if (!name) {
            customEngineForm.warn(tradThis('Enter an engine name.'))
            return
        }
        if (!validSearchTemplate(value)) {
            customEngineForm.warn(tradThis('URL seems wrong'))
            return
        }
        const customEngines = searchbar.customEngines ?? []
        const existing = customEngines.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
        if (customEngines.length >= 20 && !existing) {
            customEngineForm.warn(tradThis('You can add up to 20 search engines.'))
            return
        }
        if (existing) existing.url = stringMaxSize(value, 512)
        else customEngines.push({ id: `user-${crypto.randomUUID()}`, name, url: stringMaxSize(value, 512) })
        searchbar.customEngines = customEngines
        searchbar.engine = existing?.id ?? customEngines.at(-1)!.id
        form.reset()
        customEngineForm.accept()
    }

    if (removeEngine) {
        searchbar.customEngines = searchbar.customEngines?.filter((item) => item.id !== removeEngine)
        if (removeEngine === 'custom') searchbar.request = ''
        if (searchbar.engine === removeEngine) searchbar.engine = 'google'
    }

    searchConfig = searchbar
    refreshEngineOptions()
    setEngine(searchbar.engine)
    renderCustomEngines()

    if (request || removeEngine || engine) {
        await storage.sync.set({ searchbar })
        return
    }

    eventDebounce({ searchbar })
}

function refreshEngineOptions(): void {
    const engines = configuredEngines(searchConfig)
    for (const id of ['sb-engine', 'i_sbengine']) {
        const select = document.getElementById(id) as HTMLSelectElement | null
        if (!select) continue
        select.replaceChildren(...engines.map((engine) => {
            const option = document.createElement('option')
            option.value = engine.id
            option.textContent = engine.id === 'baidu' ? tradThis('Baidu') : engine.name
            return option
        }))
        select.value = engines.some((item) => item.id === searchConfig.engine) ? searchConfig.engine : 'google'
        if (id === 'sb-engine') initEnginePicker(select)
    }
}

function renderCustomEngines(): void {
    const list = document.getElementById('custom-search-engines')
    if (!list) return
    list.replaceChildren()
    for (const engine of configuredEngines(searchConfig).slice(3)) {
        const row = document.createElement('div')
        row.className = 'wrapper'
        const name = document.createElement('span')
        name.textContent = engine.name
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'param-btn input-btn btn-red'
        remove.textContent = tradThis('Remove')
        remove.setAttribute('aria-label', `${tradThis('Remove')} ${engine.name}`)
        remove.addEventListener('click', () => searchbar(undefined, { removeEngine: engine.id }))
        row.append(name, remove)
        list.appendChild(row)
    }
}

function isValidUrl(string: string): boolean {
    try {
        const basicURL = !!new URL(string)
        const regexMatch = domainPattern.test(string)
        return basicURL && regexMatch
    } catch (_) {
        return false
    }
}

function createSearchUrl(val: string, engine: string): string {
    const selected = configuredEngines(searchConfig).find((item) => item.id === engine)
    return (selected?.url ?? 'https://www.google.com/search?q=%s').replaceAll('%s', encodeURIComponent(val))
}

async function submitSearch(e: Event): Promise<void> {
    e.preventDefault()

    const newtab = domcontainer?.dataset.newtab === 'true'
    const val = domsearchbar?.value
    const engine = domcontainer?.dataset.engine ?? 'google'

    if (!val) {
        return
    }

    const selected = domsuggestions?.querySelector<HTMLElement>('li[aria-selected="true"]')
    if (selected?.dataset.url) {
        openLocalResult(selected.dataset.url)
        return
    }

    if (socket) {
        socket.close()
    }

    const hasProtocol = val.startsWith('http://') || val.startsWith('https://')
    const domainUrl = hasProtocol ? val : `https://${val}`
    const searchUrl = createSearchUrl(val, engine)
    const url = isValidUrl(domainUrl) ? domainUrl : searchUrl
    if (newtab) {
        globalThis.open(url, '_blank', 'noopener')
        return
    }

    globalThis.open(url, '_self')
    return
}

//
//	Suggestions
//

function initSuggestions(): void {
    if (suggestionsReady || !domsuggestions) return
    suggestionsReady = true
    domsearchbar?.setAttribute('role', 'combobox')
    domsearchbar?.setAttribute('aria-autocomplete', 'list')
    domsearchbar?.setAttribute('aria-controls', 'sb-suggestions')
    domsuggestions.setAttribute('role', 'listbox')
    function selectShownResult(next: UndefinedElement): UndefinedElement {
        return next?.classList.contains('shown') ? next : null
    }

    function applyResultContentToInput(elem: UndefinedElement): void {
        if (!(elem && domsearchbar)) {
            return
        }

        if (!(elem instanceof HTMLElement) || !elem.dataset.url) {
            domsearchbar.value = elem?.querySelector('.suggest-result')?.textContent ?? ''
        }
    }

    for (let ii = 0; ii < 10; ii++) {
        const li = document.createElement('li')
        const image = document.createElement('img')
        const wrapper = document.createElement('div')
        const result = document.createElement('p')
        const description = document.createElement('p')

        li.setAttribute('tabindex', '0')
        li.id = `sb-result-${ii}`
        li.setAttribute('role', 'option')
        image.setAttribute('draggable', 'false')
        image.setAttribute('width', '16')
        image.setAttribute('height', '16')

        result.classList.add('suggest-result')
        description.classList.add('suggest-desc')

        wrapper.appendChild(result)
        wrapper.appendChild(description)
        li.appendChild(image)
        li.appendChild(wrapper)

        li.addEventListener('mouseenter', () => {
            domcontainer?.querySelector('li[aria-selected="true"]')?.removeAttribute('aria-selected')
            li?.setAttribute('aria-selected', 'true')
        })

        li.addEventListener('mouseleave', () => {
            li?.removeAttribute('aria-selected')
        })

        li.addEventListener('click', (e) => {
            e.preventDefault()
            if (li.dataset.url) {
                openLocalResult(li.dataset.url)
                return
            }
            applyResultContentToInput(li)
            submitSearch(e)
        })

        domsuggestions?.appendChild(li)
    }

    function toggleSuggestions(e: FocusEvent): void {
        const relatedTarget = e?.relatedTarget as Element
        const targetIsResult = relatedTarget?.parentElement?.id === 'sb-suggestions'
        const hasResults = document.querySelectorAll('#sb-suggestions li.shown')?.length > 0
        const isFocus = e.type === 'focus'

        if (!targetIsResult) {
            domsuggestions?.classList.toggle('shown', isFocus && hasResults)
        }
    }

    function navigateSuggestions(e: KeyboardEvent): void {
        const isArrowDown = e.code === 'ArrowDown'
        const isArrowUp = e.code === 'ArrowUp'
        const isEnter = e.code === 'Enter'
        const isEscape = e.code === 'Escape'
        let lastSelected = domsuggestions?.querySelector('li[aria-selected="true"]')

        lastSelected?.removeAttribute('aria-selected')

        if (isEscape) {
            hideResultsAndSuggestions()
            return
        }

        if (isArrowDown) {
            e.preventDefault()
            lastSelected = selectShownResult(lastSelected?.nextElementSibling) ??
                domsuggestions?.querySelector('li.shown')
            applyResultContentToInput(lastSelected)
        }

        if (isArrowUp) {
            lastSelected = selectShownResult(lastSelected?.previousElementSibling)
            applyResultContentToInput(lastSelected)
            e.preventDefault()
        }

        if (isEnter && lastSelected) {
            e.preventDefault()
            if (lastSelected instanceof HTMLElement && lastSelected.dataset.url) {
                openLocalResult(lastSelected.dataset.url)
                return
            }
            applyResultContentToInput(lastSelected)
            submitSearch(e)
        }

        lastSelected?.setAttribute('aria-selected', 'true')
        if (lastSelected?.id) domsearchbar?.setAttribute('aria-activedescendant', lastSelected.id)
    }

    function hideResultsAndSuggestions(): void {
        const children = Object.values(domsuggestions?.children ?? [])
        for (const child of children) {
            child.classList.remove('shown')
        }
        domsuggestions?.classList.remove('shown')
    }

    domcontainer?.addEventListener('keydown', navigateSuggestions)
    domsearchbar?.addEventListener('focus', toggleSuggestions)
    domsearchbar?.addEventListener('blur', toggleSuggestions)
    emptyButton?.addEventListener('click', hideResultsAndSuggestions)
}

function openLocalResult(url: string): void {
    if (!/^https?:\/\//i.test(url)) return
    if (domcontainer?.dataset.newtab === 'true') globalThis.open(url, '_blank', 'noopener')
    else globalThis.open(url, '_self')
}

async function loadBookmarkIndex(): Promise<void> {
    if (!EXTENSION || !await EXTENSION.permissions.contains({ permissions: ['bookmarks'] })) return
    const tree = await EXTENSION.bookmarks.getTree()
    const entries: typeof bookmarkIndex = []
    type BookmarkNode = { title: string; url?: string; children?: BookmarkNode[] }
    const walk = (nodes: BookmarkNode[]): void => {
        for (const node of nodes) {
            if (node.url && /^https?:\/\//i.test(node.url)) entries.push({ title: node.title, url: node.url })
            if (node.children) walk(node.children)
        }
    }
    walk(tree)
    bookmarkIndex = entries
}

async function requestSuggestions(): Promise<void> {
    if (domcontainer?.dataset.suggestions !== 'true' || !domsearchbar?.value) return
    if (waitingForRemote) return
    if (!socket || socket.readyState > WebSocket.OPEN) {
        socketPromise ??= apiWebSocket('suggestions').then((connected) => {
            socket = connected
            socket?.addEventListener('message', (event: MessageEvent) => {
                const data = parse<Suggestions>(event.data)
                waitingForRemote = false
                if (sentQuery === domsearchbar?.value) {
                    remoteResults = Array.isArray(data)
                        ? data.filter((item) => item && typeof item.text === 'string')
                        : []
                    suggestions(remoteResults)
                } else {
                    void requestSuggestions()
                }
            })
            socket?.addEventListener('close', () => {
                waitingForRemote = false
            })
        }).finally(() => {
            socketPromise = undefined
        })
        await socketPromise
    }
    if (!socket || socket.readyState !== WebSocket.OPEN || !domsearchbar?.value) return
    sentQuery = domsearchbar.value
    waitingForRemote = true
    const selected = domcontainer.dataset.engine ?? 'google'
    const engine = ['google', 'bing', 'baidu'].includes(selected) ? selected : 'google'
    socket.send(JSON.stringify({ q: encodeURIComponent(sentQuery), with: engine, lang: getLang() }))
}

function suggestions(results: Suggestions): void {
    const seen = new Set(localResults.map((result) => result.url))
    results = [...localResults, ...results.filter((result) => !result.url || !seen.has(result.url))].slice(0, 10)
    const input = domsearchbar as HTMLInputElement
    const liList = domsuggestions?.querySelectorAll('li') ?? []

    const shown = results.length > 0 && document.getElementById('sb-engine-menu')?.hidden !== false
    domsuggestions?.classList.toggle('shown', shown)
    domsearchbar?.setAttribute('aria-expanded', String(shown))
    domsearchbar?.removeAttribute('aria-activedescendant')
    domsuggestions?.querySelector('li[aria-selected="true"]')?.removeAttribute('aria-selected')

    liList.forEach((li, i) => {
        const result = results[i]
        const resultdom = li.querySelector('.suggest-result')
        const descdom = li.querySelector('.suggest-desc')
        li.classList.toggle('shown', !!result)
        if (result?.url) li.dataset.url = result.url
        else delete li.dataset.url

        if (!(result && resultdom && descdom)) {
            return
        }

        // flaw: suggestions magnifying glass isn't colored by --font-on-blur-color
        const searchIcon = 'src/assets/interface/magnifying-glass.svg'
        const image = result.image ?? searchIcon
        const desc = result.desc ?? ''

        if (resultdom) {
            resultdom.textContent = result.text
        }

        if (result.text.includes(input.value)) {
            const queryIndex = result.text.indexOf(input.value)
            const startdom = document.createElement('span')
            const querydom = document.createElement('b')
            const enddom = document.createElement('span')

            startdom.textContent = result.text.slice(0, queryIndex)
            querydom.textContent = result.text.slice(queryIndex, queryIndex + input.value.length)
            enddom.textContent = result.text.slice(queryIndex + input.value.length)

            resultdom.textContent = ''
            resultdom.appendChild(startdom)
            resultdom.appendChild(querydom)
            resultdom.appendChild(enddom)
        }

        const imgdom = li.querySelector('img') as HTMLImageElement
        imgdom.classList.toggle('default-search-icon', image === searchIcon)
        imgdom.src = image

        descdom.textContent = desc
        li.classList.toggle('shown', !!result)

        // This cuts results short if it overflows the interface
        const rect = li.getBoundingClientRect()
        const yLimit = rect.y + rect.height + 40 // 40 is arbitrary padding in px
        const isOverflowing = yLimit > document.body.offsetHeight

        if (isOverflowing) {
            li.classList.remove('shown')
        }
    })

    if (domsuggestions?.querySelectorAll('li.shown')?.length === 0) {
        domsuggestions?.classList.remove('shown')
    }
}

//
//	Searchbar Events
//

async function handleUserInput(_e: Event): Promise<void> {
    const value = domsearchbar?.value ?? ''
    const revision = ++inputRevision
    clearTimeout(remoteTimer)
    remoteResults = []
    localResults = []
    initSuggestions()
    const hasProtocol = value.startsWith('http://') || value.startsWith('https://')
    const withProtocol = hasProtocol ? value : `https://${value}`
    const startsTypingProtocol = 'https://'.startsWith(value) || 'http://'.startsWith(value)

    // Button display toggle
    if (domsearchbar) {
        toggleInputButton(value.length > 0)
    }

    if (value === '') {
        for (const li of document.querySelectorAll('#sb-suggestions li.shown') ?? []) {
            li.classList.remove('shown')
        }
        domsuggestions?.classList.remove('shown')
        return
    }

    const data = await storage.sync.get()
    if (revision !== inputRevision) return
    const apps = searchLinks(data, value)
    const words = value.trim().toLocaleLowerCase().split(/\s+/)
    const seen = new Set(apps.map((result) => result.url))
    const bookmarks = bookmarkIndex.filter((item) =>
        !seen.has(item.url) &&
        words.every((word) => `${item.title} ${item.url}`.toLocaleLowerCase().includes(word))
    )
        .slice(0, 3).map((item) => ({ text: item.title, url: item.url, desc: '书签' }))
    localResults = [...apps, ...bookmarks].slice(0, 8)
    suggestions([])

    if (startsTypingProtocol || isValidUrl(withProtocol)) {
        return
    }

    remoteTimer = setTimeout(() => {
        void requestSuggestions()
    }, 250)
}

function toggleInputButton(enabled: boolean): void {
    document.getElementById('sb-buttons')?.classList.toggle('shown', enabled)
    document.getElementById('sb_empty')?.toggleAttribute('disabled', !enabled)
    document.getElementById('sb_submit')?.toggleAttribute('disabled', !enabled)
}

function removeInputText(): void {
    if (domsearchbar) {
        domsearchbar.focus()
        domsearchbar.value = ''
        inputRevision++
        clearTimeout(remoteTimer)
        localResults = []
        remoteResults = []
        domsearchbar.setAttribute('aria-expanded', 'false')
        domsuggestions?.classList.remove('shown')
        toggleInputButton(false)
    }
}

function focusSearchbar(): void {
    if (dombuttons?.classList.contains('shown') === false) {
        domsearchbar?.focus()
    }
}

function searchbarShortcut(event: KeyboardEvent): void {
    const target = event.target as Element
    const fromBody = target.tagName === 'BODY'

    if (fromBody && event.key === '/') {
        domsearchbar?.focus()
        domsearchbar?.select()
        event.preventDefault()
    }
}

function isValidEngine(str = ''): boolean {
    return configuredEngines(searchConfig).some((engine) => engine.id === str)
}
