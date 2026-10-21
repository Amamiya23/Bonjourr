import { darkmode, design, favicon, pageControl, tabTitle, textShadow } from './features/others.ts'
import { initSupportersSettingsNotif, supportersNotifications } from './features/supporters.ts'
import { customFont, systemfont } from './features/fonts.ts'
import { backgroundUpdate, initBackgroundOptions, toggleMuteStatus } from './features/backgrounds/index.ts'
import { changeGroupTitle, initGroups } from './features/links/groups.ts'
import { synchronization } from './features/synchronization/index.ts'
import { interfacePopup } from './features/popup.ts'
import { moveElements } from './features/move/index.ts'
import { hideElements } from './features/hide.ts'
import { linksImport } from './features/links/bookmarks.ts'
import { quickLinks } from './features/links/index.ts'
import { setOpenInNewTab } from './features/link-navigation.ts'
import { searchbar } from './features/searchbar.ts'
import { weather } from './features/weather/index.ts'
import { quotes } from './features/quotes.ts'
import { clock } from './features/clock/index.ts'
import { openSettingsButtonEvent } from './features/contextmenu.ts'

import { colorInput, fadeOut, inputThrottle, turnRefreshButton, webkitRangeTrackColor } from './shared/dom.ts'
import { BROWSER, IS_MOBILE, PLATFORM } from './defaults.ts'
import { toggleTraduction, tradThis, traduction } from './utils/translations.ts'
import { settingsNotifications } from './utils/notifications.ts'
import { getPermissions } from './utils/permissions.ts'
import { opacityFromHex } from './shared/generic.ts'
import { loadCallbacks } from './utils/onsettingsload.ts'
import { getLangForSite } from './utils/translations.ts'
import { onclickdown } from 'clickdown/mod'
import { debounce } from './utils/debounce.ts'
import { langList } from './langs.ts'
import { systemLanguage } from './utils/language.ts'
import { storage } from './storage.ts'

import type { Sync } from '../types/sync.ts'
import type { Local } from '../types/local.ts'

// Initialization

let settingsInitSync: Sync
let settingsInitLocal: Local
let settingsOpenTrigger: HTMLElement | null = null
let settingsKeyboardEventsReady = false

export function settingsInit(sync: Sync, local: Local): void {
    const showsettings = document.getElementById('show-settings')

    settingsInitSync = sync
    settingsInitLocal = local

    document.addEventListener('updateSettingsBeforeInit', (e) => {
        settingsInitSync = (e as CustomEvent).detail
    })

    document.body?.addEventListener('keydown', settingsInitEvent)
    showsettings?.addEventListener('pointerdown', settingsInitEvent)

    const openSettingsButtonsFromContextMenu = document.body.querySelectorAll<HTMLButtonElement>(
        `[data-action="openTheseSettings"]`,
    )

    openSettingsButtonsFromContextMenu.forEach((btn) => {
        btn?.addEventListener('pointerdown', settingsInitEvent)
    })
}

function settingsInitEvent(event: Event): void {
    const showsettings = document.getElementById('show-settings')
    const settings = document.getElementById('settings')

    // 1. When to load settings

    const settingsAreHidden = settings?.classList.contains('hidden')
    const isLeftClick = (event as PointerEvent)?.button === 0
    const canOpenSettings = settingsAreHidden && isLeftClick

    if (!canOpenSettings) {
        return
    }

    // 2. To apply now

    const local = settingsInitLocal
    const sync = settingsInitSync
    const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>('button, [tabindex]')
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null

    settingsOpenTrigger = trigger ?? showsettings?.querySelector<HTMLElement>('button') ?? activeElement

    if (!settingsKeyboardEventsReady) {
        document.addEventListener('keydown', settingsKeyboardNavigation)
        settingsKeyboardEventsReady = true
    }

    settings?.removeAttribute('style')
    settings?.classList.remove('hidden')
    document.dispatchEvent(new Event('settings'))

    document.addEventListener(
        'toggle-settings',
        ((e: CustomEvent) => {
            settingsToggle(e)
        }) as EventListener,
    )
    document.getElementById('settings-close')?.addEventListener('click', () => {
        document.dispatchEvent(new Event('toggle-settings'))
    })
    document.getElementById('settings-scrim')?.addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault()
        document.querySelector<HTMLElement>('#show-settings button')?.focus({ preventScroll: true })
        document.dispatchEvent(new Event('toggle-settings'))
    })

    // if init by touch, opens settings right away
    if ((event as PointerEvent).pointerType === 'touch') {
        // tricks the browser into thinking it's not the same event that inits and opens
        setTimeout(() => {
            // when requesting specific settings section
            if ((event.target as HTMLElement).getAttribute('data-attribute')) {
                openSettingsButtonEvent(event)
            } else {
                document.dispatchEvent(new CustomEvent('toggle-settings'))
            }
        }, 0)
    }

    document.body?.removeEventListener('keydown', settingsInitEvent)
    showsettings?.removeEventListener('pointerdown', settingsInitEvent)

    showall(sync.showall, false)
    traduction(settings, sync.lang)
    translatePlaceholders()
    localiseSiteLinks()
    initBackgroundOptions(sync, local)
    initSupportersSettingsNotif(sync)
    initOptionsValues(sync, local)
    initOptionsEvents()

    // 3. Can be deferred

    setTimeout(() => {
        initWorldClocksAndTimezone(sync)
        translateAriaLabels()
        settingsDrawerBar()
        loadCallbacks()

        settings?.classList.remove('init')
    }, 500)
}

function settingsToggle(event?: CustomEvent): void {
    const domshowsettings = document.getElementById('show-settings')
    const dominterface = document.getElementById('interface')
    const domsettings = document.getElementById('settings')
    const domedit = document.getElementById('editlink')
    const isClosing = domsettings?.classList.contains('shown')
    const isClosed = isClosing === false

    const scrollTo = event?.detail?.scrollTo ?? false
    const target = domsettings?.querySelector(scrollTo)

    // scrolls requested section into view
    if (target && domsettings) {
        // starts scrolling only once the settings have been rendered (otherwise starts full animation again even if unnecessary)
        requestAnimationFrame(() => {
            setTimeout(() => {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 0)
        })
    }

    // prevents closing if a scrollTo has been requested
    if (!isClosed && scrollTo) return

    domsettings?.classList.toggle('shown', isClosed)
    domedit?.classList.toggle('pushed', isClosed)
    dominterface?.classList.toggle('pushed', isClosed)
    domshowsettings?.classList.toggle('shown', isClosed)
    domsettings?.setAttribute('aria-hidden', String(!isClosed))
    document.body.classList.toggle('settings-open', isClosed)

    if (domsettings instanceof HTMLElement) {
        domsettings.inert = !isClosed
    }

    domsettings?.style.removeProperty('transform')
    domsettings?.style.removeProperty('transition')
    document.dispatchEvent(new Event('close-edit'))

    if (isClosed) {
        requestAnimationFrame(() => domsettings?.focus({ preventScroll: true }))
    } else {
        const focusTarget = settingsOpenTrigger?.isConnected && settingsOpenTrigger !== document.body
            ? settingsOpenTrigger
            : domshowsettings?.querySelector<HTMLElement>('button')
        const restoreFocus = (): void => focusTarget?.focus({ preventScroll: true })

        requestAnimationFrame(restoreFocus)
        setTimeout(restoreFocus, 200)
    }
}

function settingsKeyboardNavigation(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return

    const settings = document.getElementById('settings')

    if (!settings?.classList.contains('shown')) return

    const focusable = Array.from(
        settings.querySelectorAll<HTMLElement>(
            'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
        ),
    ).filter((element) => {
        const hidden = element.hasAttribute('disabled') || element.getAttribute('aria-hidden') === 'true'
        return !hidden && element.tabIndex >= 0 && element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden'
    })

    const active = document.activeElement

    if (focusable.length === 0) {
        event.preventDefault()
        settings.focus()
        return
    }

    const first = focusable[0]
    const last = focusable.at(-1)

    if (!first || !last) {
        event.preventDefault()
        settings.focus()
        return
    }

    if (event.shiftKey && (active === first || active === settings || !settings.contains(active))) {
        event.preventDefault()
        last.focus()
    } else if (!event.shiftKey && (active === last || active === settings || !settings.contains(active))) {
        event.preventDefault()
        first.focus()
    }
}

function initSettingsSwitches(root: HTMLElement): void {
    const switches = [
        ...(root.matches('input.switch') ? [root as HTMLInputElement] : []),
        ...root.querySelectorAll<HTMLInputElement>('input.switch'),
    ]

    for (const input of switches) {
        if (input.dataset.settingsSwitch === 'true') continue

        const syncSwitchState = (): void => input.setAttribute('aria-checked', String(input.checked))
        const row = input.closest<HTMLElement>('.wrapper')

        input.dataset.settingsSwitch = 'true'
        input.setAttribute('role', 'switch')
        row?.classList.add('switch-row')
        row?.addEventListener('click', (event) => {
            const target = event.target as HTMLElement

            if (!input.disabled && !target.closest('button, a, input, select, textarea, label, summary')) {
                input.click()
            }
        })
        input.addEventListener('change', syncSwitchState)
        syncSwitchState()
    }
}

function initOptionsValues(data: Sync, local: Local): void {
    const domsettings = document.getElementById('settings') as HTMLElement
    const userQuotes = data.quotes?.userlist?.[0] ? data.quotes?.userlist : undefined

    setInput('i_blur', data.backgrounds.blur ?? 15)
    setInput('i_bright', data.backgrounds.bright ?? 0.8)
    setInput('i_fadein', data.backgrounds.fadein ?? 400)
    setInput('i_row', data.linksrow || 8)
    setInput('i_icon_radius', data.linkiconradius || 1.1)
    setInput('i_linkstyle', data.linkstyle || 'default')
    setInput('i_type', data.backgrounds.type || 'images')
    setInput('i_freq', data.backgrounds?.frequency || 'hour')
    setInput('i_dark', data.dark || 'system')
    setInput('i_design', data.design === 'liquid-glass' ? 'liquid-glass' : 'classic')
    setInput('i_favicon', data.favicon ?? '')
    setInput('i_tabtitle', data.tabtitle ?? '')
    setInput('i_solid-background', data.backgrounds.color ?? '#185A63')
    setInput('i_texture', data.backgrounds.texture.type ?? 'none')
    setInput('i_texture-size', data.backgrounds.texture.size ?? '220')
    setInput('i_texture-opacity', data.backgrounds.texture.opacity ?? '0.1')
    setInput('i_texture-color', data.backgrounds.texture.color ?? '#ffffff')
    setInput('i_pagewidth', data.pagewidth || 1600)
    setInput('i_pagegap', data.pagegap ?? 1)
    setInput('i_dateformat', data.dateformat || 'eu')
    setInput('i_textshadow', data.textShadow ?? 0.2)
    setInput('i_sbengine', data.searchbar?.engine || 'google')
    setInput('i_sbplaceholder', data.searchbar?.placeholder || '')
    setInput('i_sb-opacity', opacityFromHex(data.searchbar?.background ?? '#fff2'))
    setInput('i_sbwidth', data.searchbar?.width ?? 44)
    setInput('i_sbrequest', data.searchbar?.request || '')
    setInput('i_qtfreq', data.quotes?.frequency || 'day')
    setInput('i_qttype', data.quotes?.type || 'classic')
    setInput('i_qtlist', userQuotes ?? '')
    setInput('i_qturl', data.quotes?.url ?? '')
    setInput('i_clockface', data.analogstyle?.face || 'none')
    setInput('i_clockhands', data.analogstyle?.hands || 'none')
    setInput('i_clockshape', data.analogstyle?.shape || 'round')
    setInput('i_analog-border-opacity', opacityFromHex(data.analogstyle?.border ?? '#ffff'))
    setInput('i_analog-background-opacity', opacityFromHex(data.analogstyle?.background ?? '#fff2'))
    setInput('i_ampm_position', data.clock.ampmposition || 'top-left')
    setInput('i_clocksize', data.clock?.size ?? 5)
    setInput('i_timezone', data.clock?.timezone || 'auto')
    setInput('i_geol', data.weather?.geolocation || 'approximate')
    setInput('i_units', data.weather?.unit ?? 'metric')
    setInput('i_forecast', data.weather?.forecast || 'auto')
    setInput('i_temp', data.weather?.temperature || 'actual')
    setInput('i_moreinfo', data.weather?.moreinfo || 'none')
    setInput('i_provider', data.weather?.provider ?? '')
    setInput('i_weight', data.font?.weight || '300')
    setInput('i_font-color', data.font.color ?? '#ffffff')
    setInput('i_size', data.font?.size || (IS_MOBILE ? '11' : '14'))

    setInput('i_synctype', local.syncType ?? (PLATFORM === 'online' ? 'off' : 'browser'))

    setFormInput('i_city', local.lastWeather?.approximation?.city ?? 'Paris', data.weather.city)
    setFormInput('i_customfont', systemfont.placeholder, data.font?.family)
    setFormInput('i_gistsync', 'github_pat_XX000X00X', local?.gistToken)
    setFormInput('i_urlsync', 'https://pastebin.com/raw/y7XhhiDs', local?.distantUrl)

    setCheckbox('i_showall', data.showall)
    setCheckbox('i_settingshide', data.hide?.settingsicon ?? false)
    setCheckbox('i_appstore_icons', data.onlineIconSources.appStore.enabled)
    setCheckbox('i_thesvg_icons', data.onlineIconSources.theSvg.enabled)
    setCheckbox('i_appstore_us', data.onlineIconSources.appStore.storefronts.includes('us'))
    setCheckbox('i_appstore_cn', data.onlineIconSources.appStore.storefronts.includes('cn'))
    setCheckbox('i_background-mute-videos', data.backgrounds.mute ?? true)
    setCheckbox('i_quicklinks', data.quicklinks)
    setCheckbox('i_linkgroups', data?.linkgroups?.on)
    setCheckbox('i_opennewtab', Boolean(data.linknewtab || data.searchbar?.newtab))
    setCheckbox('i_time', data.time)
    setCheckbox('i_analog', data.clock?.analog ?? false)
    setCheckbox('i_seconds', data.clock?.seconds ?? false)
    setCheckbox('i_worldclocks', data.clock?.worldclocks ?? false)
    setCheckbox('i_main', data.main)
    setCheckbox('i_show_unit', data.weather.show_unit ?? false)
    setCheckbox('i_sb', data.searchbar?.on ?? false)
    setCheckbox('i_quotes', data.quotes?.on ?? false)
    setCheckbox('i_ampm', data.clock?.ampm ?? false)
    setCheckbox('i_ampm-label', data.clock?.ampmlabel ?? false)
    setCheckbox('i_sbsuggestions', data.searchbar?.suggestions ?? true)
    setCheckbox('i_qtauthor', data.quotes?.author ?? false)

    // this one's weird because it was a select made into a checkbox
    setCheckbox('i_announce', data.announcements === 'off' ? false : true)
    setCheckbox('i_supporters_notif', data.supporters?.enabled ?? true)

    colorInput('solid-background', data.backgrounds.color)
    colorInput('texture-color', data.backgrounds.texture.color ?? '#ffffff')
    colorInput('font-color', data.font.color)

    paramId('i_sb-shade')?.classList.toggle('on', (data.searchbar?.background ?? '#fff').includes('#000'))
    paramId('i_analog-border-shade')?.classList.toggle('on', (data.analogstyle?.border ?? '#fff').includes('#000'))
    paramId('i_analog-background-shade')?.classList.toggle(
        'on',
        (data.analogstyle?.background ?? '#fff').includes('#000'),
    )

    // Change edit tips on mobile
    if (IS_MOBILE) {
        const tooltiptext = domsettings.querySelector('.tooltiptext .instructions')
        const text = tradThis('Edit your Quick Links by long-pressing the icon.')

        if (tooltiptext) {
            tooltiptext.textContent = text
        }
    }

    // inserts languages in select
    const langInput = paramId('i_lang')
    const systemOption = document.createElement('option')
    systemOption.value = 'system'
    systemOption.className = 'trn'
    systemOption.textContent = tradThis('Follow system language')
    langInput.appendChild(systemOption)

    for (const [code, title] of Object.entries(langList)) {
        const option = document.createElement('option')
        option.value = code
        option.text = title
        langInput.appendChild(option)
    }

    // must be init after children appening
    setInput('i_lang', data.languageMode === 'manual' ? data.lang : 'system')

    // Activate feature options
    toggleSettingsDropdown('analog_options', data.clock.analog && data.showall)
    toggleSettingsDropdown('digital_options', !data.clock.analog)
    toggleSettingsDropdown('ampm_label', data.clock.ampm)
    toggleSettingsDropdown('ampm_position', data.clock.ampmlabel && data.clock.ampm)
    toggleSettingsDropdown('worldclocks_options', data.clock.worldclocks)
    toggleSettingsDropdown('weather_provider', data.weather?.moreinfo === 'custom')

    // the events for these are in toggleWidgetInSettings()
    toggleSettingsDropdown('quicklinks_options', data.quicklinks)
    toggleSettingsDropdown('appstore_options', data.onlineIconSources.appStore.enabled)
    toggleSettingsDropdown('time_options', data.time)
    toggleSettingsDropdown('main_options', data.main)
    toggleSettingsDropdown('searchbar_options', data.searchbar?.on)
    toggleSettingsDropdown('quotes_options', data.quotes?.on)

    // Page layout
    const gridLayoutButtons = domsettings.querySelectorAll<HTMLButtonElement>('#grid-layout button')
    const selectedLayout = data.move?.selection || 'single'

    for (const button of gridLayoutButtons) {
        button?.classList.toggle('selected', button.dataset.layout === selectedLayout)
    }

    // Link show title
    paramId('b_showtitles').classList.toggle('on', data?.linktitles ?? true)
    paramId('b_showbackgrounds').classList.toggle('on', data?.linkbackgrounds ?? true)

    // Time & main hide elems
    const disableWeather = data.hide?.weatherdesc && data.hide?.weathericon
    const descOnly = data.hide?.weatherdesc
    const iconOnly = data.hide?.weathericon
    const dateOnly = data.hide?.clock
    const clockOnly = data.hide?.date
    let hideTime = 'all'
    let hideWeather = 'all'

    if (dateOnly) {
        hideTime = 'date'
    } else if (clockOnly) {
        hideTime = 'clock'
    }

    if (disableWeather) {
        hideWeather = 'disabled'
    } else if (descOnly) {
        hideWeather = 'desc'
    } else if (iconOnly) {
        hideWeather = 'icon'
    }

    setInput('i_timehide', hideTime)
    setInput('i_weatherhide', hideWeather)

    // Quotes option display
    paramId('quotes_userlist')?.classList.toggle('shown', data.quotes?.type === 'user')
    paramId('quotes_url')?.classList.toggle('shown', data.quotes?.type === 'url')

    const settingsForms = document.querySelectorAll<HTMLFormElement>('#settings form')

    for (const form of settingsForms) {
        const inputs = form.querySelectorAll<HTMLInputElement>('input')

        for (const input of inputs) {
            input.addEventListener('input', () => {
                form.classList.toggle('valid', form.checkValidity())
            })
        }
    }

    // Change Sync name based on browser
    const browserSyncOption = document.querySelector<HTMLElement>("#i_synctype option[value='browser']")

    if (browserSyncOption) {
        if (PLATFORM === 'firefox') {
            browserSyncOption.textContent = 'Firefox Sync'
        } else if (PLATFORM === 'chrome' && BROWSER === 'edge') {
            browserSyncOption.textContent = 'Edge Sync'
        } else if (PLATFORM === 'chrome') {
            browserSyncOption.textContent = 'Chrome Sync'
        } else if (PLATFORM === 'safari') {
            browserSyncOption.textContent = 'Safari'
        } else {
            browserSyncOption.textContent = tradThis('Automatic')
        }
    }

    // supportersNotifications(data?.supporters);

    initSettingsSwitches(domsettings)

    const switchObserver = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof HTMLElement) initSettingsSwitches(node)
            }
        }
    })

    switchObserver.observe(domsettings, { childList: true, subtree: true })

    // required for the range input's track color separation to work in webkit browsers
    // yes, it blows.
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
        webkitRangeTrackColor(input)

        input.addEventListener('input', () => {
            input.style.setProperty('--value', input.value)
        })
    }
}

function initOptionsEvents(): void {
    onclickdown(paramId('b_accept-permissions'), async () => {
        await getPermissions('topSites', 'bookmarks')

        const sync = await storage.sync.get()
        const local = await storage.local.get()
        quickLinks({ sync, local })
        setTimeout(() => initGroups(sync), 10)

        settingsNotifications({ 'accept-permissions': false })
    })

    // General

    onclickdown(paramId('i_showall'), (_, target) => {
        showall(target.checked, true)
    })

    paramId('i_lang').addEventListener('change', function (): void {
        switchLangs(this.value)
    })

    paramId('i_favicon').addEventListener('input', function (this: HTMLInputElement): void {
        favicon(this.value, true)
    })

    paramId('i_favicon').addEventListener('change', function (): void {
        this.blur()
    })

    paramId('i_tabtitle').addEventListener('input', function (): void {
        tabTitle(this.value, true)
    })

    paramId('i_tabtitle').addEventListener('change', function (): void {
        this.blur()
    })

    paramId('i_dark').addEventListener('change', function (): void {
        darkmode(this.value as 'auto' | 'system' | 'enable' | 'disable', true)
    })

    paramId('i_design').addEventListener('change', function (): void {
        design(this.value as 'classic' | 'liquid-glass', true)
    })

    onclickdown(paramId('i_settingshide'), (_, target) => {
        hideElements({ settingsicon: target.checked }, { isEvent: true })
    })

    // Quick links

    onclickdown(paramId('i_quicklinks'), (_, target) => {
        moveElements(undefined, { widget: ['quicklinks', target.checked] })
    })

    onclickdown(paramId('i_appstore_icons'), async (_, target) => {
        toggleSettingsDropdown('appstore_options', target.checked)
        await saveAppStoreSource(target.checked)
    })

    onclickdown(paramId('i_thesvg_icons'), async (_, target) => {
        const data = await storage.sync.get()
        data.onlineIconSources.theSvg = { enabled: target.checked }
        await storage.sync.set(data)
    })

    paramId('i_appstore_us').addEventListener('change', saveAppStoreStorefronts)
    paramId('i_appstore_cn').addEventListener('change', saveAppStoreStorefronts)

    paramId('f_addlink').addEventListener('submit', function (this, event: SubmitEvent): void {
        event.preventDefault()

        quickLinks(undefined, {
            addLinks: [
                {
                    title: paramId('i_addlink-title').value,
                    url: paramId('i_addlink-url').value,
                },
            ],
        })

        paramId('i_addlink-url').value = ''
        paramId('i_addlink-title').value = ''
        this.classList.remove('valid')
    })

    onclickdown(paramId('i_linkgroups'), (_, target) => {
        quickLinks(undefined, { groups: target.checked })
    })

    onclickdown(paramId('i_opennewtab'), (_, target) => {
        void setOpenInNewTab(target.checked)
    })

    paramId('i_linkstyle').addEventListener('change', function (this): void {
        quickLinks(undefined, { styles: { style: this.value } })
    })

    onclickdown(paramId('b_showtitles'), (_, target) => {
        quickLinks(undefined, {
            styles: { titles: !target.classList.contains('on') },
        })
    })

    onclickdown(paramId('b_showbackgrounds'), (_, target) => {
        quickLinks(undefined, {
            styles: { backgrounds: !target.classList.contains('on') },
        })
    })

    paramId('i_row').addEventListener('input', function (this): void {
        quickLinks(undefined, { row: this.value })
    })

    paramId('i_icon_radius').addEventListener('input', function (this): void {
        quickLinks(undefined, { iconradius: this.value })
    })

    onclickdown(paramId('b_importbookmarks'), async () => {
        await getPermissions('topSites', 'bookmarks')
        linksImport()
    })

    // Backgrounds

    paramId('i_type').addEventListener('change', function (this: HTMLInputElement): void {
        backgroundUpdate({ type: this.value })
    })

    paramId('b_solid-background').addEventListener('click', function (): void {
        paramId('i_solid-background').click()
    })

    paramId('i_solid-background').addEventListener('input', function (): void {
        backgroundUpdate({ color: this.value })
    })

    paramId('i_background-provider').addEventListener('input', function (): void {
        backgroundUpdate({ provider: this.value })
    })

    paramId('f_background-user-coll').addEventListener('submit', function (this, event: SubmitEvent): void {
        backgroundUpdate({ query: event })
        event.preventDefault()
    })

    paramId('f_background-user-search').addEventListener('submit', function (this, event: SubmitEvent): void {
        backgroundUpdate({ query: event })
        event.preventDefault()
    })

    paramId('i_freq').addEventListener('change', function (this: HTMLInputElement): void {
        backgroundUpdate({ freq: this.value })
    })

    onclickdown(paramId('i_refresh'), (event) => {
        backgroundUpdate({ refresh: event })
    })

    paramId('i_background-upload').addEventListener('change', function (this: HTMLInputElement): void {
        backgroundUpdate({ files: this.files })
    })

    onclickdown(paramId('b_background-urls'), () => {
        backgroundUpdate({ urlsapply: true })
    })

    onclickdown(paramId('i_background-mute-videos'), (_, target) => {
        toggleMuteStatus(target.checked)
        backgroundUpdate({ mute: target.checked })
    })

    // Background filters

    paramId('i_texture').addEventListener('change', function (this: HTMLInputElement): void {
        backgroundUpdate({ texture: this.value })
    })

    paramId('b_texture-color').addEventListener('click', function (): void {
        paramId('i_texture-color').click()
    })

    paramId('i_texture-color').addEventListener('input', function (): void {
        backgroundUpdate({ texturecolor: this.value })
    })

    paramId('i_texture-size').addEventListener('input', function (this: HTMLInputElement): void {
        backgroundUpdate({ texturesize: this.value })
    })

    paramId('i_texture-opacity').addEventListener('input', function (this: HTMLInputElement): void {
        backgroundUpdate({ textureopacity: this.value })
    })

    paramId('i_blur').addEventListener('pointerdown', function (this: HTMLInputElement): void {
        backgroundUpdate({ blurenter: true })
    })

    paramId('i_blur').addEventListener('input', function (this: HTMLInputElement): void {
        backgroundUpdate({ blur: this.value })
    })

    paramId('i_bright').addEventListener('input', function (this: HTMLInputElement): void {
        backgroundUpdate({ bright: this.value })
    })

    paramId('i_fadein').addEventListener('input', function (this: HTMLInputElement): void {
        backgroundUpdate({ fadein: this.value })
    })

    // Time and date

    onclickdown(paramId('i_time'), (_, target) => {
        moveElements(undefined, { widget: ['time', target.checked] })
    })

    onclickdown(paramId('i_analog'), (_, target) => {
        clock(undefined, { analog: target.checked })
    })

    onclickdown(paramId('i_seconds'), (_, target) => {
        clock(undefined, { seconds: target.checked })
    })

    onclickdown(paramId('i_worldclocks'), (_, target) => {
        toggleSettingsDropdown('worldclocks_options', target.checked)
        clock(undefined, { worldclocks: target.checked })
    })

    paramId('i_clockface').addEventListener('change', function (this: HTMLInputElement): void {
        clock(undefined, { face: this.value })
    })

    paramId('i_clockhands').addEventListener('change', function (this: HTMLInputElement): void {
        clock(undefined, { hands: this.value })
    })

    paramId('i_analog-border-opacity').addEventListener('input', function (this: HTMLInputElement): void {
        clock(undefined, { border: 'opacity' })
    })

    paramId('i_analog-background-opacity').addEventListener('input', function (this: HTMLInputElement): void {
        clock(undefined, { background: 'opacity' })
    })

    paramId('i_analog-border-shade').addEventListener('click', () => {
        clock(undefined, { border: 'shade' })
    })

    paramId('i_analog-background-shade').addEventListener('click', () => {
        clock(undefined, { background: 'shade' })
    })

    paramId('i_clockshape').addEventListener('change', function (this: HTMLInputElement): void {
        clock(undefined, { shape: this.value })
    })

    paramId('i_clocksize').addEventListener('input', function (this: HTMLInputElement): void {
        clock(undefined, { size: Number.parseFloat(this.value) })
    })

    onclickdown(paramId('i_ampm'), (_, target) => {
        clock(undefined, { ampm: target.checked })

        // shows/hides ampm_label option
        toggleSettingsDropdown('ampm_label', target.checked)

        // same for its position based on ampm_label AND 12h time toggle
        const ampm_toggle = document.querySelector('#i_ampm-label') as HTMLInputElement
        toggleSettingsDropdown('ampm_position', target.checked && ampm_toggle.checked)
    })

    onclickdown(paramId('i_ampm-label'), (_, target) => {
        clock(undefined, { ampmlabel: target.checked })

        // shows/hides ampm_position option
        toggleSettingsDropdown('ampm_position', target.checked)
    })

    paramId('i_ampm_position').addEventListener('change', function (this: HTMLInputElement): void {
        clock(undefined, { ampmposition: this.value })
    })

    paramId('i_timezone').addEventListener('change', function (this: HTMLInputElement): void {
        clock(undefined, { timezone: this.value })
    })

    paramId('i_dateformat').addEventListener('change', function (this): void {
        clock(undefined, { dateformat: this.value })
    })

    paramId('i_timehide').addEventListener('change', function (this: HTMLInputElement): void {
        hideElements({ clock: this.value === 'clock', date: this.value === 'date' }, { isEvent: true })
    })

    // Weather

    onclickdown(paramId('i_main'), (_, target) => {
        moveElements(undefined, { widget: ['main', target.checked] })
    })

    paramId('i_geol').addEventListener('change', function (this: HTMLInputElement): void {
        weather(undefined, { geol: this?.value })
    })

    paramId('i_city').addEventListener('input', function (this: HTMLInputElement, event: Event): void {
        weather(undefined, { suggestions: event })
    })

    paramId('f_location').addEventListener('submit', function (this, event: SubmitEvent): void {
        weather(undefined, { city: true })
        event.preventDefault()
    })

    paramId('i_units').addEventListener('change', function (this: HTMLInputElement): void {
        weather(undefined, { units: this.value })
    })

    paramId('i_forecast').addEventListener('change', function (this: HTMLInputElement): void {
        weather(undefined, { forecast: this.value })
    })

    paramId('i_temp').addEventListener('change', function (this: HTMLInputElement): void {
        weather(undefined, { temp: this.value })
    })

    paramId('i_moreinfo').addEventListener('change', function (this: HTMLInputElement): void {
        weather(undefined, { moreinfo: this.value })
    })

    paramId('i_provider').addEventListener('change', function (this: HTMLInputElement): void {
        weather(undefined, { provider: this.value })
        this.blur()
    })

    paramId('i_weatherhide').addEventListener('change', function (this: HTMLInputElement): void {
        const weatherdesc = this.value === 'disabled' || this.value === 'desc'
        const weathericon = this.value === 'disabled' || this.value === 'icon'
        hideElements({ weatherdesc, weathericon }, { isEvent: true })
        weather(undefined, { unhide: true })
    })

    onclickdown(paramId('i_show_unit'), (_, target) => {
        weather(undefined, { show_unit: target.checked })
    })

    // Searchbar

    onclickdown(paramId('i_sb'), (_, target) => {
        moveElements(undefined, { widget: ['searchbar', target.checked] })
    })

    paramId('i_sbengine').addEventListener('change', function (this: HTMLInputElement): void {
        searchbar(undefined, { engine: this.value })
    })

    paramId('i_sb-opacity').addEventListener('input', function (this: HTMLInputElement): void {
        searchbar(undefined, { background: true })
    })

    paramId('i_sb-shade').addEventListener('click', () => {
        searchbar(undefined, { background: true })
    })

    paramId('i_sbwidth').addEventListener('input', function (this: HTMLInputElement): void {
        searchbar(undefined, { width: this.value })
    })

    paramId('f_sbrequest').addEventListener('submit', function (this, event: SubmitEvent): void {
        searchbar(undefined, { request: true })
        event.preventDefault()
    })

    onclickdown(paramId('i_sbsuggestions'), (_, target) => {
        searchbar(undefined, { suggestions: target.checked })
    })

    paramId('i_sbplaceholder').addEventListener('keyup', function (): void {
        searchbar(undefined, { placeholder: this.value })
    })

    paramId('i_sbplaceholder').addEventListener('change', () => {
        paramId('i_sbplaceholder').blur()
    })

    // Quotes

    onclickdown(paramId('i_quotes'), (_, target) => {
        moveElements(undefined, { widget: ['quotes', target.checked] })
    })

    paramId('i_qtfreq').addEventListener('change', function (): void {
        quotes(undefined, { frequency: this.value })
    })

    paramId('i_qttype').addEventListener('change', function (): void {
        quotes(undefined, { type: this.value })
    })

    onclickdown(paramId('i_qtrefresh'), (event, target) => {
        inputThrottle(target)
        turnRefreshButton(event, true)
        quotes(undefined, { refresh: true })
    })

    onclickdown(paramId('i_qtauthor'), (_, target) => {
        quotes(undefined, { author: target.checked })
    })

    paramId('i_qtlist').addEventListener('change', function (): void {
        quotes(undefined, { userlist: this.value })
    })

    paramId('f_qturl').addEventListener('submit', function (this, event: SubmitEvent): void {
        event.preventDefault()

        quotes(undefined, { url: paramId('i_qturl').value })
    })

    // Custom fonts

    paramId('i_customfont').addEventListener('pointerenter', () => {
        customFont(undefined, { autocomplete: true })
    })

    paramId('f_customfont').addEventListener('submit', (event) => {
        customFont(undefined, { family: paramId('i_customfont').value })
        event.preventDefault()
    })

    paramId('i_weight').addEventListener('input', function (): void {
        customFont(undefined, { weight: this.value })
    })

    paramId('b_font-color').addEventListener('click', function (): void {
        paramId('i_font-color').click()
    })

    paramId('i_font-color').addEventListener('input', function (): void {
        customFont(undefined, { color: this.value })
    })

    paramId('i_size').addEventListener('input', function (): void {
        customFont(undefined, { size: this.value })
    })

    paramId('i_textshadow').addEventListener('input', function (): void {
        textShadow(undefined, Number.parseFloat(this.value))
    })

    // Page layout

    onclickdown(paramId('b_editmove'), () => {
        moveElements(undefined, {
            toggle: !document.getElementById('interface')?.classList.contains('move-edit'),
        })
    })

    paramId('i_pagecolumns').addEventListener('change', function (): void {
        moveElements(undefined, { layout: this.value, toggle: true })
    })

    paramId('i_pagewidth').addEventListener('input', function (): void {
        pageControl({ width: Number.parseInt(this.value) }, true)
    })

    paramId('i_pagegap').addEventListener('input', function (): void {
        pageControl({ gap: Number.parseFloat(this.value) }, true)
    })

    paramId('i_pagewidth').addEventListener('touchstart', () => moveElements(undefined, { overlay: true }), {
        passive: true,
    })
    paramId('i_pagewidth').addEventListener('mousedown', () => moveElements(undefined, { overlay: true }))
    paramId('i_pagewidth').addEventListener('touchend', () => moveElements(undefined, { overlay: false }))
    paramId('i_pagewidth').addEventListener('mouseup', () => moveElements(undefined, { overlay: false }))

    // Updates

    paramId('i_announce').addEventListener('change', function (this): void {
        interfacePopup(undefined, { announcements: this.checked })
    })

    onclickdown(paramId('i_supporters_notif'), (_, target) => {
        supportersNotifications(undefined, { enabled: target.checked })
    })

    // Sync

    paramId('i_synctype').addEventListener('change', function (this): void {
        synchronization(undefined, { type: this.value })
    })

    paramId('f_gistsync').addEventListener('submit', function (this, event): void {
        event.preventDefault()
        synchronization(undefined, { gistToken: paramId('i_gistsync').value })
    })

    paramId('f_urlsync').addEventListener('submit', function (this, event): void {
        event.preventDefault()
        synchronization(undefined, { url: paramId('i_urlsync').value })
    })

    onclickdown(paramId('b_storage-persist'), async () => {
        const persists = await navigator.storage.persist()
        synchronization(undefined, { firefoxPersist: persists })
    })

    onclickdown(paramId('b_gistup'), () => {
        synchronization(undefined, { up: true })
    })

    onclickdown(paramId('b_gistdown'), () => {
        synchronization(undefined, { down: true })
    })

    onclickdown(paramId('b_urldown'), () => {
        synchronization(undefined, { down: true })
    })

    onclickdown(paramId('b_reset-first'), () => {
        resetSettings('first')
    })

    onclickdown(paramId('b_reset-apply'), () => {
        resetSettings('yes')
    })

    onclickdown(paramId('b_reset-cancel'), () => {
        resetSettings('no')
    })

    // Other

    if (IS_MOBILE) {
        const rangeInputs = document.querySelectorAll<HTMLInputElement>("input[type='range']")

        const reduceSettingsOpacity = (event: TouchEvent) => {
            document.getElementById('settings')?.classList.toggle('see-through', event.type === 'touchstart')
        }

        for (const input of rangeInputs) {
            input.addEventListener('touchstart', reduceSettingsOpacity, { passive: true })
            input.addEventListener('touchend', reduceSettingsOpacity, { passive: true })
        }
    }

    // TODO: drag event not working ?
    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]')

    for (const input of fileInputs) {
        const toggleDrag = (_: DragEvent) => {
            input.classList.toggle('dragover')
        }

        input?.addEventListener('dragenter', toggleDrag)
        input?.addEventListener('dragleave', toggleDrag)
        input?.addEventListener('drop', toggleDrag)
    }

    const tooltips = document.querySelectorAll<HTMLElement>('.tooltip')

    for (const tooltip of tooltips) {
        tooltip.setAttribute('aria-expanded', 'false')

        onclickdown(tooltip, () => {
            const classes = [...tooltip.classList]
            const ttclass = classes.filter((cl) => cl.startsWith('tt'))[0]
            const tttext = document.querySelector(`.tooltiptext.${ttclass}`)

            if (tttext) {
                tttext.id ||= `tooltip-${ttclass}`
                tooltip.setAttribute('aria-controls', tttext.id)
            }

            tttext?.classList.toggle('shown')
            tooltip.setAttribute('aria-expanded', String(Boolean(tttext?.classList.contains('shown'))))
        })
    }

    const splitRangeButtons = document.querySelectorAll<HTMLButtonElement>('.split-range button')

    for (const button of splitRangeButtons) {
        onclickdown(button, () => {
            button.classList.toggle('on')
        })
    }
}

function initWorldClocksAndTimezone(data: Sync): void {
    const template = document.getElementById('timezones-select-template') as HTMLTemplateElement
    const citiesSelector = 'input[name="worldclock-city"]'
    const timezonesSelector = '.worldclocks-item select'
    const cities = document.querySelectorAll<HTMLSelectElement>(citiesSelector)
    const timezone = document.querySelector<HTMLSelectElement>('#i_timezone')
    const timezones = document.querySelectorAll<HTMLSelectElement>(timezonesSelector)
    const zones = ['Europe/Paris', 'America/Sao_Paulo', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Kolkata']

    // 1. Add options to selects

    for (const select of timezones) {
        select.appendChild(template.content.cloneNode(true))
    }

    if (timezone) {
        timezone.appendChild(template.content.cloneNode(true))
    }

    // 2. Add events & values

    cities?.forEach((input, i) => {
        input.addEventListener('input', () => {
            clock(undefined, { world: { index: i, region: input.value } })
        })

        if (data.worldclocks[i]) {
            input.value = data.worldclocks[i].region
        }
    })

    timezones?.forEach((select, i) => {
        select.addEventListener('change', (event: Event) => {
            const select = event.target as HTMLSelectElement
            const timezone = select.value
            clock(undefined, { world: { index: i, timezone: timezone } })
        })

        select.value = data.worldclocks[i]?.timezone ?? zones[i]
    })

    if (timezone) {
        timezone.value = data.clock.timezone
    }
}

function translatePlaceholders(): void {
    const cases = [
        ['i_title', 'Name'],
        ['i_tabtitle', 'New tab'],
        ['i_sbrequest', 'Search query: %s'],
        ['i_sbplaceholder', 'Search'],
        ['css-editor-textarea', 'Type in your custom CSS'],
        ['i_importtext', 'or paste as text'],
        ['i_addlink-title', 'Title'],
        ['i_addlink-url', 'example.com'],
        ['i_qtlist', 'Author, Your quote.\nAuthor, Your second quote.'],
    ]

    for (const [id, text] of cases) {
        document.getElementById(id)?.setAttribute('placeholder', tradThis(text))
    }
}

function translateAriaLabels(): void {
    for (const element of document.querySelectorAll('[title]')) {
        const title = element.getAttribute('title') ?? ''

        element.setAttribute('title', tradThis(title))
        element.setAttribute('aria-label', tradThis(title))
    }
}

function localiseSiteLinks(): void {
    const siteLang = getLangForSite()

    if (siteLang === 'en') return

    for (const link of document.querySelectorAll<HTMLLinkElement>('a.site-link')) {
        const url = new URL(link.href)

        url.pathname = `/${siteLang}${url.pathname}`
        link.href = url.toString()
    }
}

async function switchLangs(language: string): Promise<void> {
    const nextLang = language === 'system' ? systemLanguage() : language
    await toggleTraduction(nextLang)

    await storage.sync.set({ lang: nextLang, languageMode: language === 'system' ? 'system' : 'manual' })
    storage.local.remove('quotesCache')

    document.documentElement.setAttribute('lang', nextLang)

    const data = await storage.sync.get()
    const local = await storage.local.get(['quotesCache', 'userQuoteSelection', 'lastWeather'])

    if (local?.lastWeather) {
        local.lastWeather.timestamp = 0
        local.lastWeather.forecasted_timestamp = 0
    }

    data.lang = nextLang
    clock(data)
    changeGroupTitle({ old: '', new: '' }, data)
    weather({ sync: data, lastWeather: local.lastWeather })
    quotes({ sync: data, local })
    tabTitle(data.tabtitle)
    customFont(undefined, { lang: true })
    translatePlaceholders()
    translateAriaLabels()
    supportersNotifications(undefined, { translate: true })
    document.dispatchEvent(new Event('language-updated'))
}

function showall(val: boolean, event: boolean): void {
    document.getElementById('settings')?.classList.toggle('all', val)

    if (event) {
        storage.sync.set({ showall: val })
    }
}

// 	Mobile settings drawer bar

function settingsDrawerBar(): void {
    const drawerDragDebounce = debounce(() => {
        ;(document.getElementById('settings-footer') as HTMLDivElement).style.removeProperty('padding')
        drawerDragEvents()
    }, 600)

    globalThis.addEventListener('resize', () => {
        drawerDragDebounce()

        // removes transition to prevent weird movement when changing to mobile styling
        // /!\ this is dependent on settingsToggle() to remove inline styling /!\
        if (!document.getElementById('settings')?.style.transition) {
            document.getElementById('settings')?.setAttribute('style', 'transition: none')
        }
    })

    drawerDragEvents()
}

function drawerDragEvents(): void {
    const mobileDragZone = document.getElementById('mobile-drag-zone') as HTMLElement
    const settingsDom = document.getElementById('settings') as HTMLElement
    let settingsVh = -75
    let firstPos = 0
    let startTouchY = 0

    mobileDragZone?.addEventListener('touchstart', dragStart, {
        passive: false,
    })
    mobileDragZone?.addEventListener('pointerdown', dragStart, {
        passive: false,
    })

    function dragStart(e: Event): void {
        e.preventDefault()

        // prevents touchEvent and pointerEvent from firing at the same time
        if (settingsDom.classList.contains('dragging-mobile-settings')) {
            return
        }

        // Get mouse / touch y position
        if (e.type === 'pointerdown') {
            startTouchY = (e as MouseEvent).clientY
        }
        if (e.type === 'touchstart') {
            startTouchY = (e as TouchEvent).touches[0].clientY
        }

        // First time dragging, sets maximum y pos at which to block
        if (firstPos === 0) {
            firstPos = startTouchY
        }

        // Add mouse / touch moves events
        globalThis.addEventListener('touchmove', dragMove)
        globalThis.addEventListener('pointermove', dragMove)
        document.body.addEventListener('touchend', dragEnd)
        document.body.addEventListener('pointerup', dragEnd)

        document.body.classList.add('dragging-mobile-settings')
    }

    function dragMove(e: Event): void {
        let clientY = 0

        // Get mouse / touch y position
        if (e.type === 'pointermove') {
            clientY = (e as MouseEvent).clientY
        }
        if (e.type === 'touchmove') {
            clientY = (e as TouchEvent).touches[0].clientY
        }

        // element is below max height: move
        if (clientY > 60) {
            const touchPosition = clientY - 25
            const inverseHeight = 100 - (touchPosition / globalThis.innerHeight) * 100

            settingsVh = +inverseHeight.toFixed(2)
            settingsDom.style.transform = `translateY(-${settingsVh}dvh)`
            settingsDom.style.transition = 'transform .0s'
        }
    }

    function dragEnd(e: Event): void {
        let clientY = 0

        // Get mouse / touch y position
        if (e.type === 'pointerup') {
            clientY = (e as MouseEvent).clientY
        }
        if (e.type === 'touchend') {
            clientY = (e as TouchEvent).changedTouches[0].clientY
        }

        globalThis.removeEventListener('touchmove', dragMove)
        globalThis.removeEventListener('pointermove', dragMove)
        document.body.removeEventListener('touchend', dragEnd)
        document.body.removeEventListener('pointerup', dragEnd)

        startTouchY = 0

        const footer = document.getElementById('settings-footer') as HTMLDivElement
        footer.style.paddingBottom = `${100 - Math.abs(settingsVh)}dvh`

        settingsDom.style.removeProperty('padding')
        settingsDom.style.removeProperty('width')
        settingsDom.style.removeProperty('overflow')
        settingsDom.classList.remove('dragging')

        // small enough ? close settings
        if (clientY > globalThis.innerHeight - 100) {
            settingsToggle()
        }
    }
}

function resetSettings(action: 'yes' | 'no' | 'first'): void {
    if (action === 'yes') {
        storage.clearall().then(fadeOut)
        return
    }

    document.getElementById('reset-first')?.classList.toggle('shown', action === 'no')
    document.getElementById('reset-conf')?.classList.toggle('shown', action === 'first')
}

// this needs to be implemented little by little to replace the billion "paramId('smth')?.classList.toggle('shown', true)" stuff
// doing it all at once is way too scary
export function toggleSettingsDropdown(dropdownId: string, shown: boolean): void {
    const dropdown = document.getElementById(dropdownId)

    if (!dropdown) {
        console.error(`Couldn't find settings dropdown to toggle: #${dropdownId}`)
        return
    }

    dropdown.classList.toggle('shown', shown)

    // makes inputs and selects non focusable when tabbing
    dropdown.querySelectorAll('input, select').forEach((el) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
            const owner = el.closest<HTMLElement>('.dropdown')
            el.disabled = !shown || (owner !== dropdown && !owner?.classList.contains('shown'))
        }
    })
}

//	Helpers

function paramId(str: string): HTMLInputElement {
    return document.getElementById(str) as HTMLInputElement
}

function setCheckbox(id: string, cat: boolean): void {
    const checkbox = paramId(id) as HTMLInputElement
    checkbox.checked = cat
}

async function saveAppStoreSource(enabled: boolean): Promise<void> {
    const data = await storage.sync.get()
    data.onlineIconSources = {
        ...data.onlineIconSources,
        appStore: {
            ...data.onlineIconSources.appStore,
            enabled,
        },
    }
    await storage.sync.set(data)
}

async function saveAppStoreStorefronts(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement
    const us = paramId('i_appstore_us')
    const cn = paramId('i_appstore_cn')
    if (!us.checked && !cn.checked) {
        target.checked = true
        return
    }

    const storefronts: Sync['onlineIconSources']['appStore']['storefronts'] = []
    if (us.checked) storefronts.push('us')
    if (cn.checked) storefronts.push('cn')

    const data = await storage.sync.get()
    data.onlineIconSources = {
        ...data.onlineIconSources,
        appStore: {
            ...data.onlineIconSources.appStore,
            storefronts,
        },
    }
    await storage.sync.set(data)
}

function setInput(id: string, val: string | number): void {
    const input = paramId(id) as HTMLInputElement
    input.value = typeof val === 'string' ? val : val?.toString()
}

function setFormInput(id: string, defaults: string, value?: string): void {
    const input = paramId(id) as HTMLInputElement

    if (value) {
        input.value = value
        input.setAttribute('placeholder', value)
    } else {
        input.setAttribute('placeholder', defaults)
    }
}
