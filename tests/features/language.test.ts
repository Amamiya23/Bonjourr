import { assertEquals } from '@std/assert'
import '../init.ts'
import { systemLanguage } from '../../src/scripts/utils/language.ts'
import { getLang, setTranslationCache, tradThis, traduction } from '../../src/scripts/utils/translations.ts'
import { storage } from '../../src/scripts/storage.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'

Deno.test('System language matches regional and script tags without losing Chinese locales', () => {
    for (
        const [locale, expected] of [
            ['zh-CN', 'zh-CN'],
            ['zh_CN', 'zh-CN'],
            ['zh-Hans-CN', 'zh-CN'],
            ['zh-SG', 'zh-CN'],
            ['zh-TW', 'zh-TW'],
            ['zh-Hant', 'zh-TW'],
            ['zh-Hant-HK', 'zh-HK'],
            ['zh-MO', 'zh-HK'],
            ['en-GB', 'en'],
            ['de-DE', 'de'],
            ['pt-BR', 'pt-BR'],
            ['pt-AO', 'pt-PT'],
        ]
    ) assertEquals(systemLanguage([locale]), expected)
    assertEquals(systemLanguage(['unsupported', 'ja-JP', 'en']), 'ja')
    assertEquals(systemLanguage(['unsupported']), 'en')
})

Deno.test('System mode resolves on every storage read; manual language remains an explicit override', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'languages')
    try {
        Object.defineProperty(navigator, 'languages', { configurable: true, value: ['zh-CN'] })
        localStorage.bonjourr = JSON.stringify({ ...SYNC_DEFAULT, lang: 'en' })
        await storage.init()
        assertEquals((await storage.sync.get()).lang, 'zh-CN')
        Object.defineProperty(navigator, 'languages', { configurable: true, value: ['ja-JP'] })
        assertEquals((await storage.sync.get()).lang, 'ja')
        await storage.sync.set({ languageMode: 'manual', lang: 'fr' })
        assertEquals((await storage.sync.get()).lang, 'fr')
    } finally {
        if (original) Object.defineProperty(navigator, 'languages', original)
        else Reflect.deleteProperty(navigator, 'languages')
    }
})

Deno.test('Following Chinese loads translated UI and switching back to English resets active language', async () => {
    const original = globalThis.fetch
    const dictionary = JSON.parse(
        await Deno.readTextFile(new URL('../../_locales/zh-CN/translations.json', import.meta.url)),
    )
    globalThis.fetch = (() => Promise.resolve(Response.json(dictionary))) as typeof fetch
    try {
        document.body.innerHTML =
            '<span class="trn">Search engine</span><span class="trn">Follow system language</span>'
        await setTranslationCache(systemLanguage(['zh-CN']))
        traduction(null, 'zh-CN')
        assertEquals(getLang(), 'zh-CN')
        assertEquals(document.querySelector('span')?.textContent, '搜索引擎')
        assertEquals(tradThis('Search apps, bookmarks or the web'), '搜索应用、书签或网页')
        assertEquals(document.documentElement.lang, 'zh-CN')
        await setTranslationCache('en')
        traduction(null, 'en')
        assertEquals(getLang(), 'en')
        assertEquals(document.documentElement.lang, 'en')
        assertEquals(tradThis('Search apps, bookmarks or the web'), 'Search apps, bookmarks or the web')
    } finally {
        globalThis.fetch = original
    }
})
