import { assertEquals } from '@std/assert'
import { previewResponse } from '../../tasks/serve.ts'

Deno.test({
    name: 'Preview serves image, script, JSON and stylesheet content types correctly',
    fn: async () => {
        for (
            const [path, type] of [
                ['/assets/favicons/favicon.ico', 'image/x-icon'],
                ['/assets/favicons/favicon-128x128.png', 'image/png'],
                ['/assets/interface/gear.svg', 'image/svg+xml'],
                ['/scripts/services/help-mode.js', 'text/javascript'],
                ['/styles/style.css', 'text/css'],
                ['/manifests/chrome.json', 'application/json'],
            ]
        ) {
            const response = await previewResponse(new Request(`http://localhost:8000${path}`), 'src')
            assertEquals(response.status, 200)
            assertEquals(response.headers.get('content-type'), type)
            await response.arrayBuffer()
        }
    },
})
