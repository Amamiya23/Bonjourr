import { bodyJson, HttpError } from './http.ts'
import type {
    AppStoreStorefront,
    MediaCandidate,
    MediaCandidateRequestItem,
    MediaCandidateResult,
    MediaCandidatesResponse,
} from '../src/types/media.ts'

const APPLE_SEARCH_URL = 'https://itunes.apple.com/search'
const APPLE_TIMEOUT_MS = 5000
const APPLE_BODY_BYTES = 256 * 1024
const REQUEST_BODY_BYTES = 32 * 1024
const FRESH_CACHE_MS = 24 * 60 * 60 * 1000
const STALE_CACHE_MS = 7 * 24 * 60 * 60 * 1000
const SUPPORTED_STOREFRONTS: AppStoreStorefront[] = ['us', 'cn']
const DEFAULT_STOREFRONTS: AppStoreStorefront[] = ['us', 'cn']
const FAVICON_BASE = 'https://services.bonjourr.fr/favicon/blob/'
const CACHE_BASE = 'https://media-cache.bonjourr.invalid/app-store/v2'
const THESVG_BASE = 'https://cdn.jsdelivr.net/gh/glincker/thesvg@main'
const THESVG_CACHE_URL = 'https://media-cache.bonjourr.invalid/thesvg/v1/registry'
const THESVG_BODY_BYTES = 8 * 1024 * 1024

interface ParsedCandidateRequest {
    kind: 'logo' | 'icon'
    mode: 'search' | 'auto'
    items: MediaCandidateRequestItem[]
    limit: number
    theSvg: { enabled: boolean }
    appStore: {
        enabled: boolean
        storefronts: AppStoreStorefront[]
    }
}

interface AppleResult {
    trackName?: unknown
    sellerName?: unknown
    bundleId?: unknown
    trackId?: unknown
    artworkUrl512?: unknown
    artworkUrl100?: unknown
    artworkUrl60?: unknown
}

interface RankedAppleResult {
    candidate: MediaCandidate
    score: number
    order: number
    storefront: AppStoreStorefront
    trackId?: string
    bundleId?: string
}

interface CachedAppStoreResults {
    fetchedAt: number
    entries: RankedAppleResult[]
}

interface WaitUntil {
    waitUntil(promise: Promise<unknown>): void
}

interface TheSvgIcon {
    slug: string
    title: string
    aliases?: string[]
    variants: Partial<Record<string, string>>
}

interface CachedTheSvgRegistry {
    fetchedAt: number
    icons: TheSvgIcon[]
}

let theSvgRegistry: CachedTheSvgRegistry | undefined
let theSvgRequest: Promise<TheSvgIcon[]> | undefined

const appStoreRequests = new Map<string, Promise<RankedAppleResult[]>>()
let appStoreRetryAt = 0

class AppStoreRateLimitError extends Error {
    constructor(readonly retryAfter: number) {
        super('Apple search is rate limited')
    }
}

export async function mediaCandidates(request: Request, ctx?: WaitUntil): Promise<Response> {
    const parsed = parseCandidateRequest(await bodyJson(request, REQUEST_BODY_BYTES))
    const results: MediaCandidateResult[] = []

    for (const item of parsed.items) {
        const builtIn = builtInCandidates(item)
        const query = builtIn.matchedQuery ?? brandQuery(item)
        const search = parsed.kind === 'logo' && parsed.mode === 'search' && parsed.items.length === 1 && !!query
        const [apple, svg] = await Promise.all([
            search && parsed.appStore.enabled
                ? appStoreCandidates(query, parsed.appStore.storefronts, ctx).catch(() => ({
                    candidates: [],
                    status: { state: 'unavailable' as const },
                }))
                : undefined,
            search && parsed.theSvg.enabled ? theSvgCandidates(query, ctx) : undefined,
        ])
        const appStore = apple?.candidates ?? []
        const theSvg = svg?.candidates ?? []
        const favicon = faviconCandidates(item)
        const best = builtIn.candidates[0] ?? theSvg[0] ?? appStore[0] ?? favicon[0] ?? null

        results.push({
            id: item.id,
            query,
            builtIn: builtIn.candidates.slice(0, parsed.limit),
            appStore: appStore.slice(0, parsed.limit),
            appStoreStatus: apple?.status,
            theSvg: theSvg.slice(0, parsed.limit),
            theSvgStatus: svg?.status,
            favicon: favicon.slice(0, parsed.limit),
            best,
        })
    }

    const response: MediaCandidatesResponse = { items: results }
    return Response.json(response, { headers: { 'Cache-Control': 'no-store' } })
}

export function parseCandidateRequest(input: Record<string, unknown>): ParsedCandidateRequest {
    const kind = input.kind
    const mode = input.mode
    if (kind !== 'logo' && kind !== 'icon') throw new HttpError(400, '不支持的候选类型。')
    if (mode !== 'search' && mode !== 'auto') throw new HttpError(400, '不支持的候选模式。')
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 32) {
        throw new HttpError(400, '候选项目数量无效。')
    }

    const limit = Number.isFinite(Number(input.limit)) ? Math.min(Math.max(Math.trunc(Number(input.limit)), 1), 32) : 32
    const items = input.items.map(parseCandidateItem)
    const sources = input.onlineIconSources && typeof input.onlineIconSources === 'object'
        ? input.onlineIconSources as Record<string, unknown>
        : {}
    const source = sources.appStore
    const appStoreInput = source && typeof source === 'object' ? source as Record<string, unknown> : {}
    const enabled = appStoreInput.enabled === true
    const storefronts = parseStorefronts(appStoreInput.storefronts)

    const theSvgInput = sources.theSvg && typeof sources.theSvg === 'object'
        ? sources.theSvg as Record<string, unknown>
        : {}
    return {
        kind,
        mode,
        items,
        limit,
        appStore: { enabled, storefronts },
        theSvg: { enabled: theSvgInput.enabled === true },
    }
}

export function normalizeBrandName(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLocaleLowerCase('en')
        .replace(/&/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .slice(0, 96)
}

export function scoreBrandMatch(query: string, ...values: unknown[]): number {
    const normalizedQuery = normalizeBrandName(query)
    if (!normalizedQuery) return 0

    let score = 0
    for (const value of values) {
        if (typeof value !== 'string') continue
        score = Math.max(score, scoreNormalized(normalizedQuery, normalizeBrandName(value)))
    }
    return score
}

export function rankAppleResults(
    entries: Array<{ result: AppleResult; storefront: AppStoreStorefront; order: number }>,
    query: string,
): MediaCandidate[] {
    return deduplicateRankedAppleResults(rankAppleEntries(entries, query))
}

function rankAppleEntries(
    entries: Array<{ result: AppleResult; storefront: AppStoreStorefront; order: number }>,
    query: string,
): RankedAppleResult[] {
    const ranked: RankedAppleResult[] = []

    for (const { result, storefront, order } of entries) {
        const score = scoreBrandMatch(query, result.trackName, result.sellerName, result.bundleId)
        const url = artworkUrl(result)
        if (score < 0.7 || !url || typeof result.trackName !== 'string') continue

        const trackId = result.trackId === undefined || result.trackId === null ? undefined : String(result.trackId)
        const bundleId = typeof result.bundleId === 'string' ? result.bundleId : undefined
        ranked.push({
            score,
            order,
            storefront,
            trackId,
            bundleId,
            candidate: {
                id: `appStore:${trackId ?? bundleId ?? url}`,
                source: 'appStore',
                name: result.trackName,
                subtitle: typeof result.sellerName === 'string' ? result.sellerName : undefined,
                url,
                storefront: storefront.toUpperCase() as Uppercase<AppStoreStorefront>,
                autoAssignable: false,
            },
        })
    }

    ranked.sort((left, right) =>
        right.score - left.score ||
        storefrontOrder(left.storefront) - storefrontOrder(right.storefront) ||
        left.order - right.order
    )

    return ranked
}

function deduplicateRankedAppleResults(ranked: RankedAppleResult[]): MediaCandidate[] {
    const trackIds = new Set<string>()
    const bundleIds = new Set<string>()
    const artworkUrls = new Set<string>()
    const candidates: MediaCandidate[] = []

    for (const item of ranked) {
        if (
            (item.trackId && trackIds.has(item.trackId)) ||
            (item.bundleId && bundleIds.has(item.bundleId)) ||
            artworkUrls.has(item.candidate.url)
        ) continue

        if (item.trackId) trackIds.add(item.trackId)
        if (item.bundleId) bundleIds.add(item.bundleId)
        artworkUrls.add(item.candidate.url)
        candidates.push(item.candidate)
    }

    return candidates
}

function parseCandidateItem(value: unknown): MediaCandidateRequestItem {
    if (!value || typeof value !== 'object') throw new HttpError(400, '候选项目无效。')
    const item = value as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128) throw new HttpError(400, '候选 ID 无效。')
    if (typeof item.website !== 'string') throw new HttpError(400, '候选网站无效。')

    let website: URL
    try {
        website = new URL(item.website)
    } catch {
        throw new HttpError(400, '候选网站无效。')
    }
    if (!['http:', 'https:'].includes(website.protocol) || website.username || website.password) {
        throw new HttpError(400, '候选网站必须是 HTTP(S) 地址。')
    }

    return {
        id: item.id,
        name: typeof item.name === 'string' ? item.name.slice(0, 128) : undefined,
        website: website.href,
    }
}

function parseStorefronts(value: unknown): AppStoreStorefront[] {
    if (!Array.isArray(value)) return [...DEFAULT_STOREFRONTS]
    const requested = new Set(value.map((item) => String(item).toLocaleLowerCase('en')))
    const storefronts = SUPPORTED_STOREFRONTS.filter((storefront) => requested.has(storefront))
    return storefronts.length ? storefronts : [...DEFAULT_STOREFRONTS]
}

function builtInCandidates(item: MediaCandidateRequestItem): { candidates: MediaCandidate[]; matchedQuery?: string } {
    const query = brandQuery(item)
    return { candidates: [], matchedQuery: query || undefined }
}

function brandQuery(item: MediaCandidateRequestItem): string {
    const name = item.name?.trim() ?? ''
    const shortName = name.split(/\s+(?:[-|–—:·])\s+/)[0]?.trim() || name
    const query = normalizeBrandName(shortName || websiteBrand(item.website))
    return query.slice(0, 64)
}

function websiteBrand(value: string): string {
    const hostname = new URL(value).hostname.replace(/^www\./, '')
    return hostname.split('.')[0] ?? hostname
}

function faviconCandidates(item: MediaCandidateRequestItem): MediaCandidate[] {
    const website = new URL(item.website)
    const target = website.origin + website.pathname
    return [{
        id: `favicon:${target}`,
        source: 'favicon',
        name: item.name?.trim() || website.hostname,
        url: FAVICON_BASE + target,
        autoAssignable: true,
    }]
}

function scoreNormalized(query: string, candidate: string): number {
    if (!candidate) return 0
    if (candidate === query) return 1
    if (candidate.startsWith(query)) return 0.9
    if (candidate.includes(query)) return 0.7

    const queryParts = query.split(' ')
    const candidateParts = new Set(candidate.split(' '))
    if (queryParts.every((part) => candidateParts.has(part))) return 0.55
    if (isSubsequence(query.replaceAll(' ', ''), candidate.replaceAll(' ', ''))) return 0.35
    return 0
}

function isSubsequence(query: string, candidate: string): boolean {
    let cursor = 0
    for (const character of candidate) {
        if (character === query[cursor]) cursor++
        if (cursor === query.length) return true
    }
    return false
}

function storefrontOrder(storefront: AppStoreStorefront): number {
    return storefront === 'us' ? 0 : 1
}

function artworkUrl(result: AppleResult): string | undefined {
    for (const value of [result.artworkUrl512, result.artworkUrl100, result.artworkUrl60]) {
        if (typeof value !== 'string') continue
        try {
            const url = new URL(value)
            if (
                url.protocol === 'https:' && (url.hostname === 'mzstatic.com' || url.hostname.endsWith('.mzstatic.com'))
            ) {
                return url.href
            }
        } catch {
            // Try the next artwork size.
        }
    }
}

export function rankTheSvgResults(icons: TheSvgIcon[], query: string): MediaCandidate[] {
    const ranked = icons.map((icon, order) => ({
        icon,
        order,
        score: scoreBrandMatch(query, icon.title, icon.slug, ...(icon.aliases ?? [])),
    })).filter((entry) => entry.score >= 0.7)
    ranked.sort((left, right) => right.score - left.score || left.order - right.order)

    const candidates: MediaCandidate[] = []
    const urls = new Set<string>()
    for (const { icon } of ranked) {
        if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(icon.slug)) continue
        for (const variant of ['default', 'color', 'dark', 'light', 'mono']) {
            const path = icon.variants[variant]
            // Use the manifest path: default can point to color.svg or mono.svg.
            if (typeof path !== 'string' || !path.startsWith(`/icons/${icon.slug}/`)) continue
            if (!/^\/icons\/[a-z0-9-]+\/[a-zA-Z0-9-]+\.svg$/.test(path)) continue
            const url = `${THESVG_BASE}/public${path}`
            if (urls.has(url)) continue
            urls.add(url)
            candidates.push({
                id: `theSvg:${icon.slug}:${variant}`,
                source: 'theSvg',
                name: icon.title,
                subtitle: variant,
                url,
                autoAssignable: false,
            })
        }
    }
    return candidates
}

async function theSvgCandidates(
    query: string,
    ctx?: WaitUntil,
): Promise<{ candidates: MediaCandidate[]; status: NonNullable<MediaCandidateResult['theSvgStatus']> }> {
    try {
        const candidates = rankTheSvgResults(await cachedTheSvgRegistry(ctx), query)
        return { candidates, status: { state: candidates.length ? 'ok' : 'empty' } }
    } catch (error) {
        console.warn('the_svg_source_failed', {
            kind: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
        })
        return { candidates: [], status: { state: 'unavailable' } }
    }
}

async function cachedTheSvgRegistry(ctx?: WaitUntil): Promise<TheSvgIcon[]> {
    let cached = theSvgRegistry
    if (!cached) {
        try {
            const cache = await mediaCache()
            const response = await cache?.match(new Request(THESVG_CACHE_URL))
            if (response) cached = await response.json() as CachedTheSvgRegistry
        } catch {
            // A cache failure must not prevent fetching the registry.
        }
    }
    const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY
    if (cached && age <= FRESH_CACHE_MS) {
        theSvgRegistry = cached
        return cached.icons
    }
    if (cached && age <= STALE_CACHE_MS) {
        theSvgRegistry = cached
        const refresh = refreshTheSvgRegistry().catch(() => {})
        if (ctx) ctx.waitUntil(refresh)
        else await refresh
        return cached.icons
    }
    return await refreshTheSvgRegistry()
}

async function refreshTheSvgRegistry(): Promise<TheSvgIcon[]> {
    if (theSvgRequest) return theSvgRequest
    theSvgRequest = fetchTheSvgRegistry().finally(() => {
        theSvgRequest = undefined
    })
    return await theSvgRequest
}

async function fetchTheSvgRegistry(): Promise<TheSvgIcon[]> {
    const response = await fetch(`${THESVG_BASE}/src/data/icons.json`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`TheSVG returned ${response.status}`)
    }
    const data: unknown = JSON.parse(await readLimitedText(response, THESVG_BODY_BYTES))
    if (!Array.isArray(data)) throw new Error('TheSVG returned an invalid registry')
    const icons: TheSvgIcon[] = []
    for (const entry of data) {
        if (!entry || typeof entry !== 'object') continue
        const icon = entry as Record<string, unknown>
        if (typeof icon.slug !== 'string' || typeof icon.title !== 'string') continue
        if (!icon.variants || typeof icon.variants !== 'object' || Array.isArray(icon.variants)) continue
        icons.push({
            slug: icon.slug,
            title: icon.title,
            aliases: Array.isArray(icon.aliases) ? icon.aliases.filter((alias) => typeof alias === 'string') : [],
            variants: icon.variants as Record<string, string>,
        })
    }
    if (!icons.length) throw new Error('TheSVG returned an invalid registry')
    theSvgRegistry = { fetchedAt: Date.now(), icons }
    try {
        const cache = await mediaCache()
        await cache?.put(
            new Request(THESVG_CACHE_URL),
            Response.json(theSvgRegistry, {
                headers: { 'Cache-Control': `public, max-age=${STALE_CACHE_MS / 1000}` },
            }),
        )
    } catch {
        // Keep the in-memory registry when the edge cache is unavailable.
    }
    return icons
}

async function appStoreCandidates(
    query: string,
    storefronts: AppStoreStorefront[],
    ctx?: WaitUntil,
): Promise<{ candidates: MediaCandidate[]; status: NonNullable<MediaCandidateResult['appStoreStatus']> }> {
    const all = await Promise.allSettled(
        storefronts.map((storefront) => cachedStorefrontCandidates(query, storefront, ctx)),
    )
    const ranked = all.flatMap((result) => result.status === 'fulfilled' ? result.value : []).sort((left, right) =>
        right.score - left.score ||
        storefrontOrder(left.storefront) - storefrontOrder(right.storefront) ||
        left.order - right.order
    )
    const candidates = deduplicateRankedAppleResults(ranked)
    const errors = all.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    const retryAfter = Math.max(
        0,
        ...errors.map((error) => error instanceof AppStoreRateLimitError ? error.retryAfter : 0),
    )
    let state: NonNullable<MediaCandidateResult['appStoreStatus']>['state'] = candidates.length ? 'ok' : 'empty'
    if (errors.length) {
        state = candidates.length ? 'partial' : 'unavailable'
        if (!candidates.length && retryAfter) state = 'rateLimited'
    }
    return { candidates, status: { state, ...(retryAfter ? { retryAfter } : {}) } }
}

async function cachedStorefrontCandidates(
    query: string,
    storefront: AppStoreStorefront,
    ctx?: WaitUntil,
): Promise<RankedAppleResult[]> {
    const key = `${storefront}:${query}`
    const cached = await readAppStoreCache(key)
    const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY

    if (cached && age <= FRESH_CACHE_MS) return cached.entries

    if (cached && age <= STALE_CACHE_MS) {
        const refresh = refreshStorefrontCandidates(query, storefront).catch(() => {})
        if (ctx) ctx.waitUntil(refresh)
        else await refresh
        return cached.entries
    }

    return await refreshStorefrontCandidates(query, storefront)
}

async function refreshStorefrontCandidates(
    query: string,
    storefront: AppStoreStorefront,
): Promise<RankedAppleResult[]> {
    const key = `${storefront}:${query}`
    const existing = appStoreRequests.get(key)
    if (existing) return existing

    const request = fetchStorefrontCandidates(query, storefront)
        .then(async (candidates) => {
            try {
                await writeAppStoreCache(key, candidates)
            } catch {
                // A cache failure must not discard valid App Store results.
            }
            return candidates
        })
        .catch((error) => {
            console.warn('app_store_source_failed', {
                storefront,
                query,
                kind: error instanceof Error ? error.name : 'Error',
                message: error instanceof Error ? error.message : String(error),
                ...(error instanceof AppStoreRateLimitError ? { status: 429, retryAfter: error.retryAfter } : {}),
            })
            throw error
        })
        .finally(() => appStoreRequests.delete(key))

    appStoreRequests.set(key, request)
    return await request
}

async function fetchStorefrontCandidates(
    query: string,
    storefront: AppStoreStorefront,
): Promise<RankedAppleResult[]> {
    const retryAfter = await appStoreCooldown()
    if (retryAfter) throw new AppStoreRateLimitError(retryAfter)

    const url = new URL(APPLE_SEARCH_URL)
    url.search = new URLSearchParams({
        term: query,
        country: storefront,
        media: 'software',
        entity: 'software',
        limit: '3',
    }).toString()

    const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(APPLE_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
    })
    if (response.status === 429) {
        const retryAfter = await recordAppStoreCooldown(response.headers.get('Retry-After'))
        await response.body?.cancel()
        throw new AppStoreRateLimitError(retryAfter)
    }
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new Error(`Apple returned redirect ${response.status}`)
    }
    if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Apple returned ${response.status}`)
    }

    const data = JSON.parse(await readLimitedText(response, APPLE_BODY_BYTES)) as { results?: unknown }
    if (!Array.isArray(data.results)) throw new Error('Apple returned an invalid search response')
    return rankAppleEntries(
        data.results.slice(0, 3).map((result, order) => ({
            result: result as AppleResult,
            storefront,
            order,
        })),
        query,
    )
}

async function appStoreCooldown(): Promise<number> {
    if (appStoreRetryAt <= Date.now()) appStoreRetryAt = 0
    try {
        const cache = await mediaCache()
        const response = await cache?.match(cacheRequest('retry-after'))
        if (response) {
            const data = await response.json() as { retryAt: number }
            if (Number.isFinite(data.retryAt)) appStoreRetryAt = Math.max(appStoreRetryAt, data.retryAt)
        }
    } catch {
        // Keep the in-memory cooldown if the edge cache is unavailable.
    }
    return Math.max(0, Math.ceil((appStoreRetryAt - Date.now()) / 1000))
}

async function recordAppStoreCooldown(value: string | null): Promise<number> {
    const seconds = value === null ? 60 : /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000
    const requestedRetryAfter = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60
    appStoreRetryAt = Math.max(appStoreRetryAt, Date.now() + requestedRetryAfter * 1000)
    const retryAfter = Math.max(1, Math.ceil((appStoreRetryAt - Date.now()) / 1000))
    try {
        const cache = await mediaCache()
        await cache?.put(
            cacheRequest('retry-after'),
            Response.json({ retryAt: appStoreRetryAt }, {
                headers: { 'Cache-Control': `public, max-age=${retryAfter}` },
            }),
        )
    } catch {
        // Requests in this Worker still respect the in-memory cooldown.
    }
    return retryAfter
}

async function readLimitedText(response: Response, maximum: number): Promise<string> {
    if (Number(response.headers.get('Content-Length')) > maximum) {
        await response.body?.cancel()
        throw new Error('Media source response is too large')
    }
    if (!response.body) return ''

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maximum) throw new Error('Media source response is too large')
            chunks.push(value)
        }
    } finally {
        await reader.cancel()
    }

    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
}

async function readAppStoreCache(key: string): Promise<CachedAppStoreResults | undefined> {
    try {
        const cache = await mediaCache()
        if (!cache) return
        const response = await cache.match(cacheRequest(key))
        if (!response) return
        return await response.json() as CachedAppStoreResults
    } catch {
        return
    }
}

async function writeAppStoreCache(key: string, entries: RankedAppleResult[]): Promise<void> {
    const cache = await mediaCache()
    if (!cache) return
    const payload: CachedAppStoreResults = { fetchedAt: Date.now(), entries }
    await cache.put(
        cacheRequest(key),
        Response.json(payload, {
            headers: { 'Cache-Control': `public, max-age=${STALE_CACHE_MS / 1000}` },
        }),
    )
}

function cacheRequest(key: string): Request {
    return new Request(`${CACHE_BASE}/${encodeURIComponent(key)}`)
}

async function mediaCache(): Promise<Cache | undefined> {
    try {
        return (globalThis as typeof globalThis & { caches?: { default?: Cache } }).caches?.default
    } catch {
        return
    }
}
