import { fetchWithTimeout, httpUrl } from '../../shared/network.ts'
import { getLang } from '../../utils/translations.ts'
import { storage } from '../../storage.ts'
import type { LastWeather } from '../../../types/local.ts'
import type { Weather } from '../../../types/sync.ts'

export const UAPI_WEATHER_URL = 'https://uapis.cn/api/v1/misc/weather'

export function weatherSourceKey(data: Weather): string {
    return JSON.stringify([
        data.source ?? 'bonjourr',
        data.apiUrl,
        data.adcode,
        data.city,
        data.geolocation,
        data.unit,
        getLang(),
    ])
}

export function buildWeatherUrl(data: Weather, lang: string): URL {
    const url = httpUrl(data.source === 'custom' ? data.apiUrl ?? '' : UAPI_WEATHER_URL)
    if (data.adcode && !/^\d{6}$/.test(data.adcode)) throw new Error('行政区编码必须是 6 位数字。')
    url.searchParams.set('lang', lang.startsWith('zh') ? 'zh' : 'en')
    url.searchParams.set('extended', 'true')
    url.searchParams.set('forecast', 'true')
    if (data.adcode) url.searchParams.set('adcode', data.adcode)
    else if (data.geolocation === 'off' && data.city?.trim()) url.searchParams.set('city', data.city.trim())
    return url
}

function condition(description: string): string {
    // The supplied documentation does not include its referenced icon-code table.
    // Keep the original description; use a conservative visual fallback for unknown conditions.
    if (/雷|thunder/i.test(description)) return 'thunderstorm'
    if (/雪|snow|sleet/i.test(description)) return 'snow'
    if (/小雨|light rain|drizzle/i.test(description)) return 'lightrain'
    if (/雨|rain|shower/i.test(description)) return 'rain'
    if (/雾|霾|沙|fog|mist|haze|dust/i.test(description)) return 'mist'
    if (/阴|overcast/i.test(description)) return 'overcastclouds'
    if (/云|cloud/i.test(description)) return 'brokenclouds'
    if (/晴|clear|sunny/i.test(description)) return 'clearsky'
    return 'fewclouds'
}

export function normalizeApiWeather(raw: unknown, data: Weather, now = new Date()): LastWeather {
    if (!raw || typeof raw !== 'object') throw new Error('天气接口返回的数据不是 JSON 对象。')
    const value = raw as Record<string, unknown>
    if (
        typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) ||
        typeof value.weather !== 'string' || !value.weather.trim()
    ) {
        throw new Error('天气数据缺少有效的 temperature 或 weather 字段。自定义 API 需返回 UAPI 兼容 JSON。')
    }
    const convert = (c: number) => data.unit === 'imperial' ? c * 9 / 5 + 32 : c
    const days = Array.isArray(value.forecast) ? value.forecast as Record<string, unknown>[] : []
    const today = days.find((day) => day.date === localDate(now)) ?? days[0]
    const tomorrowDate = new Date(now)
    tomorrowDate.setDate(now.getDate() + 1)
    const tomorrow = days.find((day) => day.date === localDate(tomorrowDate))
    const solar = (time: unknown): number => {
        if (typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)) return 0
        const [h, m] = time.split(':').map(Number)
        if (h > 23 || m > 59) return 0
        const date = new Date(now)
        date.setHours(h, m, 0, 0)
        return date.getTime()
    }
    const sunrise = solar(today?.sunrise)
    const sunset = solar(today?.sunset)
    const isTomorrow = Boolean(sunset && now.getTime() > sunset)
    const forecast = isTomorrow ? tomorrow : today
    const high = forecast?.temp_max ?? (!isTomorrow ? value.temp_max : undefined)
    const hasForecast = typeof high === 'number' && Number.isFinite(high)
    return {
        temp: convert(value.temperature),
        feels_like: convert(
            typeof value.feels_like === 'number' && Number.isFinite(value.feels_like)
                ? value.feels_like
                : value.temperature,
        ),
        description: value.weather.trim(),
        icon_id: condition(value.weather),
        timestamp: now.getTime(),
        forecasted_high: hasForecast ? convert(high as number) : convert(value.temperature),
        forecasted_timestamp: isTomorrow ? tomorrowDate.getTime() : now.getTime(),
        hasForecast,
        sunrise,
        sunset,
        link: '',
        sourceKey: weatherSourceKey(data),
        approximation: { city: typeof value.city === 'string' ? value.city : data.city, lat: 0, lon: 0 },
    }
}

function localDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${
        String(date.getDate()).padStart(2, '0')
    }`
}

export async function requestApiWeather(data: Weather): Promise<LastWeather> {
    const url = buildWeatherUrl(data, getLang())
    const { weatherApiKey = '', weatherApiOrigin = '', weatherRetryAt = 0 } = await storage.local.get([
        'weatherApiKey',
        'weatherApiOrigin',
        'weatherRetryAt',
    ])
    if (Date.now() < weatherRetryAt) throw new Error('天气接口正在限流，请稍后重试。')
    if (data.source === 'uapi' && weatherApiKey && !/^uapi-\S+$/.test(weatherApiKey)) {
        throw new Error('UAPI 密钥应以 uapi- 开头。')
    }
    const headers: Record<string, string> = { Accept: 'application/json' }
    const keyOrigin = weatherApiOrigin || new URL(UAPI_WEATHER_URL).origin
    if (weatherApiKey && keyOrigin !== url.origin) throw new Error('天气接口地址已变更，请重新保存该接口的密钥。')
    if (weatherApiKey) headers.Authorization = `Bearer ${weatherApiKey}`
    const response = await fetchWithTimeout(url, { headers }, 1024 * 1024)
    if (response.status === 429) {
        const retry = response.headers.get('Retry-After') ?? '60'
        const seconds = Number(retry)
        const until = Number.isFinite(seconds) ? Date.now() + Math.max(60, seconds) * 1000 : Date.parse(retry)
        await storage.local.set({ weatherRetryAt: Number.isFinite(until) ? until : Date.now() + 60000 })
        throw new Error('天气接口请求过于频繁，请稍后重试。')
    }
    if (!response.ok) {
        const errors: Record<number, string> = {
            400: '天气参数无效，请检查城市、行政区编码和接口地址。',
            401: '天气密钥无效或未填写。',
            403: '天气密钥没有访问权限。',
            404: '未找到该城市的天气数据。',
            500: '天气服务器内部错误。',
            503: '天气服务暂时不可用。',
        }
        throw new Error(errors[response.status] ?? `天气请求失败（HTTP ${response.status}）。`)
    }
    const result = normalizeApiWeather(await response.json(), data)
    await storage.local.set({ weatherRetryAt: 0 })
    return result
}
