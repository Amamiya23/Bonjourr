import type { Background, Quote, SimpleWeather } from './shared.ts'
import type { Sync } from './sync.ts'

export type BackgroundUrlState = 'NONE' | 'LOADING' | 'OK' | 'NOT_URL' | 'CANT_REACH' | 'NOT_MEDIA'
export type SyncType = 'browser' | 'gist' | 'url' | 'webdav' | 'off'

export interface Local {
    weatherApiKey?: string
    weatherApiOrigin?: string
    weatherRetryAt?: number
    webdav?: WebdavConfig
    fonts?: FontListItem[]
    fontface?: string
    userQuoteSelection: number
    quotesCache: Quote[]
    translations?: Translations
    lastWeather?: LastWeather
    operaExplained?: true

    // Sync
    gistId?: string
    gistToken?: string
    distantUrl?: string
    pastebinToken?: string
    syncType?: SyncType

    // Backgrounds
    backgroundCollections: Record<string, Background[]>
    backgroundUrls: Record<string, BackgroundUrl>
    backgroundFiles: Record<string, BackgroundFile>
    backgroundLastChange?: string
    backgroundCompressFiles?: boolean

    // Online
    syncStorage?: Sync

    // Links
    [key: `x-icon-${string}`]: string
}

export interface LastWeather {
    sourceKey?: string
    hasForecast?: boolean
    temp: number
    forecasted_timestamp: number
    forecasted_high: number
    feels_like: number
    sunrise: number
    sunset: number
    icon_id: string
    description: string
    timestamp: number
    link: string
    approximation?: {
        ccode?: SimpleWeather['geo']['country']
        city?: SimpleWeather['geo']['city']
        lat: SimpleWeather['geo']['lat']
        lon: SimpleWeather['geo']['lon']
    }
}

export interface BackgroundUrl {
    lastUsed: string
    format: 'image' | 'video'
    state: BackgroundUrlState
    duration?: number
}

export interface WebdavConfig {
    url: string
    directory?: string
    username: string
    password: string
    etag?: string
    lastSync?: string
}

/**
 * Bad planning in version 21: interface structure is image only.
 *
 * Video options "zoom, fade, playbackRate" have been added separately
 * "position" remains image only...
 */
export interface BackgroundFile {
    format: 'image' | 'video'
    lastUsed: string
    selected?: boolean
    video?: {
        playbackRate: number
        fade: number
        zoom: number
    }
    position?: {
        size: string
        x: string
        y: string
    }
}

export interface FontListItem {
    family: string
    weights: string[]
    variable: boolean
}

export type Translations = {
    lang: string
    [key: string]: string
}
