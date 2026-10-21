export type MediaCandidateSource = 'builtIn' | 'appStore' | 'favicon'
export type AppStoreStorefront = 'us' | 'cn'

export interface AppStoreIconSource {
    enabled: boolean
    storefronts: AppStoreStorefront[]
}

export interface OnlineIconSources {
    appStore: AppStoreIconSource
}

export interface MediaCandidate {
    id: string
    source: MediaCandidateSource
    name: string
    url: string
    subtitle?: string
    storefront?: Uppercase<AppStoreStorefront>
    autoAssignable: boolean
}

export interface MediaCandidateRequestItem {
    id: string
    name?: string
    website: string
}

export interface MediaCandidatesRequest {
    kind: 'logo' | 'icon'
    mode: 'search' | 'auto'
    items: MediaCandidateRequestItem[]
    limit?: number
    onlineIconSources?: Partial<OnlineIconSources>
}

export interface MediaCandidateResult {
    id: string
    query: string
    builtIn: MediaCandidate[]
    appStore: MediaCandidate[]
    appStoreStatus?: {
        state: 'ok' | 'empty' | 'partial' | 'rateLimited' | 'unavailable'
        retryAfter?: number
    }
    favicon: MediaCandidate[]
    best: MediaCandidate | null
}

export interface MediaCandidatesResponse {
    items: MediaCandidateResult[]
}
