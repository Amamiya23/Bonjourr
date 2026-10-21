import { CLOUD_MAX_BODY, DEFAULT_CLOUD_SERVER } from '../../shared/cloud.ts'
import { fetchWithTimeout } from '../../shared/network.ts'
import type { CloudConnection } from '../../shared/cloud.ts'

export class CloudRequestError extends Error {
    constructor(public status: number, message: string) {
        super(message)
    }
}

export function cloudServer(value: string): string {
    const url = new URL(value)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
        throw new Error('云端服务必须使用 HTTPS。')
    }
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
        throw new Error('请输入服务端根地址，不要填写路径或登录信息。')
    }
    // Keep existing installations on the custom domain, including saved Worker URLs.
    return url.origin === 'https://bonjourr-cloud.zjc020118.workers.dev' ? DEFAULT_CLOUD_SERVER : url.origin
}

export async function cloudFetch(
    connection: Pick<CloudConnection, 'url' | 'token'>,
    path: string,
    options: RequestInit = {},
): Promise<Response> {
    const headers = new Headers(options.headers)
    if (connection.token) headers.set('Authorization', `Bearer ${connection.token}`)
    const response = await fetchWithTimeout(
        new URL(`/api/${path}`, cloudServer(connection.url)),
        {
            ...options,
            headers,
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
        },
        CLOUD_MAX_BODY,
        120000,
    )
    if (!response.ok) {
        let message = `云端请求失败（HTTP ${response.status}）。`
        try {
            const error = await response.json()
            if (typeof error.error === 'string') message = error.error
        } catch { /* HEAD responses have no JSON body. */ }
        if (response.status === 401 && connection.token) {
            globalThis.document?.dispatchEvent(
                new CustomEvent('bonjourr-cloud-session-expired', { detail: { token: connection.token } }),
            )
        }
        throw new CloudRequestError(response.status, message)
    }
    return response
}

export async function cloudJson<T>(
    connection: Pick<CloudConnection, 'url' | 'token'>,
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
    const response = await cloudFetch(connection, path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    return await response.json() as T
}
