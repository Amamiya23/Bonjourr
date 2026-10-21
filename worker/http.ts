import { CLOUD_MAX_BODY } from '../src/scripts/shared/cloud.ts'

export class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message)
    }
}

export async function boundedBody(
    request: Request | Response,
    maximum = CLOUD_MAX_BODY,
): Promise<Uint8Array<ArrayBuffer>> {
    if (Number(request.headers.get('Content-Length')) > maximum) throw new HttpError(413, '内容超过大小限制。')
    const reader = request.body?.getReader()
    if (!reader) return new Uint8Array()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maximum) throw new HttpError(413, '内容超过大小限制。')
            chunks.push(value)
        }
    } catch (error) {
        await reader.cancel()
        throw error
    } finally {
        reader.releaseLock()
    }
    const result = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
    }
    return result
}

export async function bodyJson(request: Request, maximum = CLOUD_MAX_BODY): Promise<Record<string, unknown>> {
    try {
        const result: unknown = JSON.parse(new TextDecoder().decode(await boundedBody(request, maximum)))
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error()
        return result as Record<string, unknown>
    } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(400, '请求格式无效。')
    }
}

export function randomToken(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
