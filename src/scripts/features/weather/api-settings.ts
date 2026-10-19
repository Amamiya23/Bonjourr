import { storage } from '../../storage.ts'
import { onSettingsLoad } from '../../utils/onsettingsload.ts'
import { httpUrl, requestOrigin } from '../../shared/network.ts'
import { UAPI_WEATHER_URL } from './api.ts'
import { requestNewWeather } from './request.ts'
import { displayWeather } from './display.ts'
import type { Sync } from '../../../types/sync.ts'
import type { Local } from '../../../types/local.ts'

export function weatherApiSettings(sync: Sync, local: Local): void {
    onSettingsLoad(() => {
        const form = document.querySelector<HTMLFormElement>('#weather-api-form')
        const source = document.querySelector<HTMLSelectElement>('#weather-api-source')
        const url = document.querySelector<HTMLInputElement>('#weather-api-url')
        const city = document.querySelector<HTMLInputElement>('#weather-api-city')
        const adcode = document.querySelector<HTMLInputElement>('#weather-api-adcode')
        const key = document.querySelector<HTMLInputElement>('#weather-api-key')
        const status = document.getElementById('weather-api-status')
        if (!form || !source || !url || !city || !adcode || !key || !status) return
        source.value = sync.weather.source ?? 'bonjourr'
        url.value = sync.weather.apiUrl ?? UAPI_WEATHER_URL
        city.value = sync.weather.geolocation === 'off' ? sync.weather.city ?? '' : ''
        adcode.value = sync.weather.adcode ?? ''
        key.value = local.weatherApiKey ?? ''
        const toggle = () => {
            form.dataset.source = source.value
            document.getElementById('main_options')?.setAttribute('data-weather-source', source.value)
            url.disabled = source.value !== 'custom'
        }
        toggle()
        source.addEventListener('change', () => {
            key.value = ''
            toggle()
        })
        form.addEventListener('submit', async (event) => {
            event.preventDefault()
            const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')
            if (button) button.disabled = true
            status.textContent = '正在保存并测试天气连接…'
            try {
                const endpoint = source.value === 'custom' ? httpUrl(url.value.trim()).href : UAPI_WEATHER_URL
                if (adcode.value.trim() && !/^\d{6}$/.test(adcode.value.trim())) {
                    throw new Error('行政区编码必须是 6 位数字。')
                }
                if (source.value === 'uapi' && key.value.trim() && !/^uapi-\S+$/.test(key.value.trim())) {
                    throw new Error('UAPI 密钥应以 uapi- 开头。')
                }
                // Request permission while still inside the user's submit gesture.
                if (source.value !== 'bonjourr') await requestOrigin(endpoint)
                const data = await storage.sync.get()
                data.weather = {
                    ...data.weather,
                    source: source.value as Sync['weather']['source'],
                    apiUrl: endpoint,
                    adcode: adcode.value.trim(),
                    city: city.value.trim(),
                    geolocation: city.value.trim() || adcode.value.trim() ? 'off' : 'approximate',
                }
                await storage.local.set({ weatherApiKey: key.value.trim(), weatherApiOrigin: new URL(endpoint).origin })
                await storage.sync.set({ weather: data.weather })
                const result = await requestNewWeather(data.weather)
                if (!result) throw new Error('天气未返回数据，请检查网络。')
                await storage.local.set({ lastWeather: result })
                displayWeather(data.weather, result)
                document.getElementById('weather-status')?.replaceChildren()
                status.textContent = `连接成功：${result.approximation?.city ?? ''} ${result.description} ${
                    Math.round(result.temp)
                }°`
            } catch (error) {
                status.textContent = error instanceof Error ? error.message : '天气连接失败。'
            } finally {
                if (button) button.disabled = false
            }
        })
    })
}
