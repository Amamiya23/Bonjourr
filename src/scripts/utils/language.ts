import { langList } from '../langs.ts'

export function systemLanguage(
    languages: readonly string[] = navigator.languages?.length ? navigator.languages : [navigator.language],
): string {
    const supported = Object.keys(langList)
    for (const language of languages) {
        const locale = language.replaceAll('_', '-').toLowerCase()
        const exact = supported.find((code) => code.toLowerCase() === locale)
        if (exact) return exact
        if (locale === 'zh' || locale.startsWith('zh-')) {
            if (locale.includes('hant') || /-(tw|hk|mo)(-|$)/.test(locale)) {
                return locale.includes('-hk') || locale.includes('-mo') ? 'zh-HK' : 'zh-TW'
            }
            return 'zh-CN'
        }
        if (locale === 'pt' || locale.startsWith('pt-')) return locale.includes('-br') ? 'pt-BR' : 'pt-PT'
        const base = locale.split('-')[0]
        const match = supported.find((code) => code.toLowerCase() === base)
        if (match) return match
    }
    return 'en'
}
