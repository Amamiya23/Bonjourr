import { EXTENSION, PLATFORM } from '../defaults.ts'

export function httpUrl(value: string): URL {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('请输入 HTTP(S) 地址，用户名和密码请填在独立字段中。')
    }
    return url
}

export async function requestOrigin(value: string): Promise<void> {
    const url = httpUrl(value)
    if (PLATFORM === 'online') return
    const granted = await EXTENSION?.permissions.request({ origins: [`${url.origin}/*`] })
    if (!granted) throw new Error('未获得此服务器的访问权限。')
}

export async function fetchWithTimeout(
    url: string | URL,
    options: RequestInit = {},
    maxBytes = 50 * 1024 * 1024,
    timeoutMs = 12000,
): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            redirect: 'error',
            credentials: 'omit',
        })
        // Chrome can expose an empty stream for HEAD and null-body responses.
        // Rebuilding a 204/205/304 response with a Blob throws a TypeError.
        if (
            !response.body || options.method?.toUpperCase() === 'HEAD' ||
            [204, 205, 304].includes(response.status)
        ) return response
        if (Number(response.headers.get('Content-Length')) > maxBytes) {
            await response.body.cancel()
            throw new Error('服务器响应超过允许的大小。')
        }
        const reader = response.body.getReader()
        const parts: ArrayBuffer[] = []
        let size = 0
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                size += value.byteLength
                if (size > maxBytes) throw new Error('服务器响应超过允许的大小。')
                parts.push(new Uint8Array(value).buffer)
            }
        } finally {
            await reader.cancel()
        }
        return new Response(new Blob(parts), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        })
    } catch (error) {
        if (controller.signal.aborted) throw new Error('请求超时，请稍后重试。')
        if (error instanceof TypeError) {
            throw new Error('无法连接服务器。请检查地址、网络和访问权限；网页版还需要服务器允许跨域请求。')
        }
        throw error
    } finally {
        clearTimeout(timeout)
    }
}
