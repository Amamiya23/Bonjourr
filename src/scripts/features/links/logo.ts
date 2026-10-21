import { APP_API_DOMAIN } from '../../defaults.ts'
import { fetchWithTimeout, requestOrigin } from '../../shared/network.ts'
import { tradThis } from '../../utils/translations.ts'
import { storage } from '../../storage.ts'
import type {
    MediaCandidate,
    MediaCandidateResult,
    MediaCandidateSource,
    MediaCandidatesResponse,
} from '../../../types/media.ts'

type LogoGroups = Record<MediaCandidateSource, MediaCandidate[]>

const domquery = document.getElementById('e-logo-query') as HTMLInputElement
const domresults = document.getElementById('e-logo-results') as HTMLDivElement
const domstatus = document.getElementById('e-logo-status') as HTMLParagraphElement
const dompanel = document.getElementById('edit-logo') as HTMLDivElement
const domiconurl = document.getElementById('e-icon-url') as HTMLInputElement
const domicontype = document.getElementById('e-icon-type') as HTMLSelectElement

let groups: LogoGroups = { builtIn: [], appStore: [], favicon: [] }
let bestId = ''
let selectedId = ''
let generation = 0
let eventsReady = false

export function initLogoSearch(): void {
    if (eventsReady) return
    eventsReady = true

    document.getElementById('b_logo-search')?.addEventListener('click', () => {
        void searchLogos()
    })

    domquery?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        event.stopPropagation()
        void searchLogos()
    })
}

export function prepareLogoSearch(title: string, website: string): void {
    generation++
    groups = { builtIn: [], appStore: [], favicon: [] }
    bestId = ''
    selectedId = ''
    domquery.value = title.trim() || brandFromWebsite(website)
    domstatus.textContent = ''
    domresults.replaceChildren()
}

export function setLogoSearchVisible(visible: boolean): void {
    dompanel.classList.toggle('on', visible)
}

async function searchLogos(): Promise<void> {
    const query = domquery.value.trim()
    const website = (document.getElementById('e-url') as HTMLInputElement)?.value.trim()
    if (!query || !website) {
        domstatus.textContent = tradThis('Enter a logo name first')
        return
    }

    const current = ++generation
    domstatus.textContent = tradThis('Searching logos')
    domresults.replaceChildren()

    try {
        await requestOrigin(APP_API_DOMAIN)
        const sync = await storage.sync.get()
        const response = await fetchWithTimeout(
            `${APP_API_DOMAIN}/api/app/media/candidates`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: 'logo',
                    mode: 'search',
                    items: [{ id: 'search', name: query, website }],
                    limit: 32,
                    onlineIconSources: sync.onlineIconSources,
                }),
            },
            256 * 1024,
            8000,
        )

        if (!response.ok) throw new Error(`Logo search returned ${response.status}`)
        const data = await response.json() as MediaCandidatesResponse
        const result = data.items?.[0]
        if (!result || current !== generation) return

        setResults(result)
    } catch (error) {
        if (current !== generation) return
        domstatus.textContent = tradThis('Could not load logos')
        console.error('Logo search failed', error)
    }
}

function setResults(result: MediaCandidateResult): void {
    groups = {
        builtIn: [...result.builtIn],
        appStore: [...result.appStore],
        favicon: [...result.favicon],
    }
    bestId = result.best?.id ?? firstCandidate()?.id ?? ''
    selectedId = ''
    renderGroups()

    const count = Object.values(groups).flat().length
    domstatus.textContent = count ? '' : tradThis('No logos found')
}

function renderGroups(): void {
    domresults.replaceChildren()
    const round = generation

    for (const source of ['builtIn', 'appStore', 'favicon'] as const) {
        const candidates = groups[source]
        if (!candidates.length) continue
        domresults.append(createGroup(source, candidates, round))
    }
    updateBestHighlight()
}

function createGroup(source: MediaCandidateSource, candidates: MediaCandidate[], round: number): HTMLElement {
    const group = document.createElement('section')
    const title = document.createElement('h3')
    const grid = document.createElement('div')

    group.className = `logo-group logo-group-${source}`
    group.dataset.source = source
    title.textContent = sourceName(source)
    grid.className = 'logo-grid'

    for (const candidate of candidates) grid.append(createCandidate(source, candidate, round))
    group.append(title, grid)
    return group
}

function createCandidate(source: MediaCandidateSource, candidate: MediaCandidate, round: number): HTMLButtonElement {
    const button = document.createElement('button')
    const image = document.createElement('img')
    const name = document.createElement('span')

    button.type = 'button'
    button.className = 'logo-candidate'
    button.dataset.candidateId = candidate.id
    button.title = candidate.subtitle ? `${candidate.name} · ${candidate.subtitle}` : candidate.name
    button.setAttribute('aria-label', candidate.name)
    button.addEventListener('click', () => selectCandidate(candidate))

    image.src = candidate.url
    image.alt = ''
    image.loading = 'eager'
    image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
    image.addEventListener('error', () => {
        if (round === generation) removeBrokenCandidate(source, candidate)
    })

    name.className = 'logo-candidate-name'
    name.textContent = candidate.name
    button.append(image, name)
    return button
}

function selectCandidate(candidate: MediaCandidate): void {
    selectedId = candidate.id
    domiconurl.value = candidate.url
    domicontype.value = 'url'
    domicontype.dispatchEvent(new Event('change', { bubbles: true }))

    for (const button of domresults.querySelectorAll<HTMLButtonElement>('.logo-candidate')) {
        button.classList.toggle('selected', button.dataset.candidateId === selectedId)
    }
}

function removeBrokenCandidate(source: MediaCandidateSource, candidate: MediaCandidate): void {
    groups[source] = groups[source].filter((item) => item.id !== candidate.id)

    const button = domresults.querySelector<HTMLButtonElement>(
        `.logo-candidate[data-candidate-id="${CSS.escape(candidate.id)}"]`,
    )
    const group = button?.closest<HTMLElement>('.logo-group')
    button?.remove()
    if (group && !group.querySelector('.logo-candidate')) group.remove()

    if (selectedId === candidate.id) {
        selectedId = ''
        domiconurl.value = ''
        domicontype.value = 'auto'
        domicontype.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const best = firstCandidate()
    bestId = best?.id ?? ''
    updateBestHighlight()
    if (!bestId) domstatus.textContent = tradThis('No logos found')
}

function updateBestHighlight(): void {
    for (const button of domresults.querySelectorAll<HTMLButtonElement>('.logo-candidate')) {
        button.classList.toggle('best', button.dataset.candidateId === bestId)
        button.classList.toggle('selected', button.dataset.candidateId === selectedId)
    }
}

function firstCandidate(): MediaCandidate | undefined {
    return groups.builtIn[0] ?? groups.appStore[0] ?? groups.favicon[0]
}

function sourceName(source: MediaCandidateSource): string {
    if (source === 'builtIn') return tradThis('Built-in')
    if (source === 'appStore') return 'App Store'
    return tradThis('Website favicon')
}

function brandFromWebsite(website: string): string {
    try {
        return new URL(website).hostname.replace(/^www\./, '').split('.')[0]
    } catch {
        return ''
    }
}
