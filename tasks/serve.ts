if (import.meta.main) httpServer(parseInt(Deno.args[0]))

const CONTENT_TYPES: Record<string, string> = {
    webmanifest: 'application/manifest+json',
    js: 'text/javascript',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    mp3: 'audio/mpeg',
    html: 'text/html',
    png: 'image/png',
    css: 'text/css',
    json: 'application/json',
}

export async function previewResponse(request: Request, baseUrl = 'release/online'): Promise<Response> {
    const url = new URL(request.url)
    const filePath = baseUrl + (url.pathname === '/' ? '/index.html' : url.pathname)
    const headers = new Headers({ 'cache-control': 'no-cache' })
    const type = CONTENT_TYPES[filePath.split('.').at(-1)?.toLowerCase() ?? '']
    if (type) headers.set('content-type', type)
    try {
        const data = await Deno.readFile(filePath)
        return new Response(data, { headers })
    } catch (error) {
        const missing = error instanceof Deno.errors.NotFound
        return new Response(missing ? 'Not Found' : 'Internal Server Error', { status: missing ? 404 : 500 })
    }
}

export function httpServer(port: number, baseUrl = 'release/online'): Deno.HttpServer<Deno.NetAddr> {
    return Deno.serve({ port }, (request) => previewResponse(request, baseUrl))
}
