import { assertEquals, assertRejects, assertThrows } from '@std/assert'
import '../init.ts'
import { SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import { storage } from '../../src/scripts/storage.ts'
import { buildWeatherUrl, normalizeApiWeather, requestApiWeather } from '../../src/scripts/features/weather/api.ts'

localStorage.bonjourr = JSON.stringify(SYNC_DEFAULT)
await storage.init()
const weather = {
    ...SYNC_DEFAULT.weather,
    unit: 'metric' as const,
    source: 'uapi' as const,
    geolocation: 'off' as const,
    city: '北京',
}

Deno.test('UAPI keeps its documented full endpoint and prioritizes adcode', () => {
    const url = buildWeatherUrl({ ...weather, adcode: '110000' }, 'zh_CN')
    assertEquals(url.origin + url.pathname, 'https://uapis.cn/api/v1/misc/weather')
    assertEquals(url.searchParams.get('adcode'), '110000')
    assertEquals(url.searchParams.has('city'), false)
    assertEquals(url.searchParams.get('lang'), 'zh')
    assertEquals(url.searchParams.get('forecast'), 'true')
    assertEquals(url.searchParams.has('lat'), false)
})

Deno.test('UAPI supports automatic IP location without inventing coordinates', () => {
    const url = buildWeatherUrl({ ...weather, geolocation: 'approximate' }, 'ja')
    assertEquals(url.searchParams.has('city'), false)
    assertEquals(url.searchParams.has('adcode'), false)
    assertEquals(url.searchParams.get('lang'), 'en')
    assertThrows(() => buildWeatherUrl({ ...weather, adcode: 'abc' }, 'zh'), Error, '6 位')
})

Deno.test('Custom weather rejects credentials in URL and non-HTTP protocols', () => {
    assertThrows(() => buildWeatherUrl({ ...weather, source: 'custom', apiUrl: 'file:///weather' }, 'zh'))
    assertThrows(() =>
        buildWeatherUrl({ ...weather, source: 'custom', apiUrl: 'https://user:secret@example.com/' }, 'zh')
    )
})

Deno.test('Weather preserves zero temperatures and converts both temperatures to Fahrenheit', () => {
    const result = normalizeApiWeather({ temperature: 0, feels_like: -5, weather: '小雪', city: '北京' }, {
        ...weather,
        unit: 'imperial',
    })
    assertEquals(result.temp, 32)
    assertEquals(result.feels_like, 23)
    assertEquals(result.icon_id, 'snow')
    assertEquals(result.hasForecast, false)
    assertEquals(result.approximation?.city, '北京')
})

Deno.test('Weather does not label today’s high as tomorrow when forecast is missing', () => {
    const now = new Date(2026, 9, 19, 20)
    const result = normalizeApiWeather(
        {
            temperature: 12,
            weather: '多云',
            temp_max: 20,
            forecast: [{ date: '2026-10-19', temp_max: 20, sunrise: '06:30', sunset: '18:00' }],
        },
        weather,
        now,
    )
    assertEquals(result.hasForecast, false)
    assertEquals(new Date(result.forecasted_timestamp).getDate(), 20)
})

Deno.test('Weather selects tomorrow’s forecast after sunset', () => {
    const result = normalizeApiWeather(
        {
            temperature: 12,
            weather: '晴',
            forecast: [
                { date: '2026-10-19', temp_max: 20, sunrise: '06:30', sunset: '18:00' },
                { date: '2026-10-20', temp_max: 23 },
            ],
        },
        weather,
        new Date(2026, 9, 19, 20),
    )
    assertEquals(result.forecasted_high, 23)
    assertEquals(result.hasForecast, true)
})

Deno.test('Weather rejects empty, nonnumeric and malformed success responses', () => {
    for (
        const data of [null, {}, { temperature: '18', weather: '晴' }, { temperature: NaN, weather: '晴' }, {
            temperature: 18,
            weather: '',
        }]
    ) {
        assertThrows(() => normalizeApiWeather(data, weather))
    }
})

Deno.test('Weather sends the API key only in the Authorization header', async () => {
    const original = globalThis.fetch
    await storage.local.set({ weatherApiKey: 'uapi-test-key', weatherRetryAt: 0 })
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        assertEquals(String(input).includes('uapi-test-key'), false)
        assertEquals(new Headers(init?.headers).get('Authorization'), 'Bearer uapi-test-key')
        return Promise.resolve(Response.json({ temperature: 18, weather: '晴' }))
    }) as typeof fetch
    try {
        assertEquals((await requestApiWeather(weather)).temp, 18)
    } finally {
        globalThis.fetch = original
    }
})

Deno.test('Weather reports documented HTTP failures and rate limits further requests', async () => {
    const original = globalThis.fetch
    try {
        for (
            const [status, message] of [[400, '参数无效'], [401, '密钥无效'], [404, '未找到'], [500, '内部错误'], [
                503,
                '暂时不可用',
            ]] as const
        ) {
            globalThis.fetch = (() => Promise.resolve(new Response('{}', { status }))) as typeof fetch
            await assertRejects(() => requestApiWeather(weather), Error, message)
        }
        let requests = 0
        globalThis.fetch = (() => {
            requests++
            return Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }))
        }) as typeof fetch
        await assertRejects(() => requestApiWeather(weather), Error, '过于频繁')
        await assertRejects(() => requestApiWeather(weather), Error, '限流')
        assertEquals(requests, 1)
    } finally {
        globalThis.fetch = original
        await storage.local.set({ weatherRetryAt: 0 })
    }
})

Deno.test('A synced custom endpoint cannot receive a key saved for another origin', async () => {
    await storage.local.set({ weatherApiKey: 'uapi-private', weatherApiOrigin: 'https://uapis.cn', weatherRetryAt: 0 })
    await assertRejects(
        () => requestApiWeather({ ...weather, source: 'custom', apiUrl: 'https://other.example/weather' }),
        Error,
        '重新保存',
    )
})
