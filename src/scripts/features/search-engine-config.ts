import type { CustomSearchEngine, Searchbar } from '../../types/sync.ts'

export const BUILTIN_ENGINES = [
    { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s' },
    { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
    { id: 'baidu', name: 'Baidu', url: 'https://www.baidu.com/s?wd=%s' },
] as const

export function validSearchTemplate(value: string): boolean {
    try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && value.includes('%s')
    } catch (_) {
        return false
    }
}

export function configuredEngines(config: Searchbar): CustomSearchEngine[] {
    const engines: CustomSearchEngine[] = BUILTIN_ENGINES.map((engine) => ({ ...engine }))
    for (const engine of config.customEngines ?? []) {
        if (
            !engine || typeof engine.id !== 'string' || !/^user-[\w-]+$/.test(engine.id) ||
            typeof engine.name !== 'string' || !engine.name.trim() || !validSearchTemplate(engine.url) ||
            engines.some((item) => item.id === engine.id)
        ) continue
        engines.push({ id: engine.id, name: engine.name.trim().slice(0, 32), url: engine.url })
    }
    // Preserve an existing custom search without exposing an unconfigured "Custom" entry.
    if (validSearchTemplate(config.request)) {
        engines.push({ id: 'custom', name: new URL(config.request).hostname, url: config.request })
    }
    return engines
}
