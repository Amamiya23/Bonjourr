import { assertEquals } from '@std/assert'
import '../init.ts'
import { LOCAL_DEFAULT, SYNC_DEFAULT } from '../../src/scripts/defaults.ts'
import { storage } from '../../src/scripts/storage.ts'
import { synchronization } from '../../src/scripts/features/synchronization/index.ts'
import { loadCallbacks } from '../../src/scripts/utils/onsettingsload.ts'
import type { CloudConnection } from '../../src/scripts/shared/cloud.ts'

const settings = await Deno.readTextFile(new URL('../../src/settings.html', import.meta.url))
const flush = () => new Promise((resolve) => setTimeout(resolve, 40))

Deno.test({
    name: 'Backup settings preserve legacy credentials and operate independently of sync',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const originalFetch = globalThis.fetch
        const originalBody = document.body.innerHTML
        const saved = Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)!]))
        const cloud: CloudConnection = {
            url: 'https://cloud.example',
            token: 'a'.repeat(64),
            deviceId: 'owner',
            name: 'Test device',
            owner: true,
            accountId: 'legacy',
            username: 'admin',
            expiresAt: Date.now() + 86400000,
        }
        const webdav = { url: 'https://dav.example/', directory: 'Bonjourr', username: 'test', password: 'test' }
        try {
            localStorage.clear()
            localStorage.bonjourr = JSON.stringify(SYNC_DEFAULT)
            storage.type.init()
            document.body.innerHTML = settings
            const local = { ...structuredClone(LOCAL_DEFAULT), syncType: 'webdav' as const, cloud, webdav }
            await storage.local.set(local)
            globalThis.fetch = (() => Promise.resolve(Response.json({ configured: false }))) as typeof fetch
            synchronization(local)
            loadCallbacks()
            await flush()
            assertEquals((await storage.local.get('syncType')).syncType, 'off')
            assertEquals((await storage.local.get('webdav')).webdav, webdav)
            assertEquals(document.querySelector('#i_synctype option[value="webdav"]'), null)
            assertEquals(document.querySelector<HTMLInputElement>('#webdav-password')!.value, 'test')
            assertEquals(document.querySelector('#cloud-backup-form')!.closest('.param')!.id, 'backup-settings')
            assertEquals(document.getElementById('cloud-backup-access')!.hidden, true)
            assertEquals(document.querySelector<HTMLElement>('#cloud-backup [data-cloud-owner]')!.hidden, false)

            const form = document.querySelector<HTMLFormElement>('#cloud-backup-form')!
            const status = document.getElementById('cloud-backup-status')!
            const syncStatus = document.getElementById('cloud-status')!.textContent
            document.querySelector<HTMLInputElement>('#cloud-backup-url')!.value = webdav.url
            document.querySelector<HTMLInputElement>('#cloud-backup-password')!.value = 'test'
            let finish: (response: Response) => void = () => {}
            let sent: RequestInit | undefined
            globalThis.fetch = ((_url, init) => {
                sent = init
                return new Promise<Response>((resolve) => {
                    finish = resolve
                })
            }) as typeof fetch
            form.dispatchEvent(new Event('submit', { cancelable: true }))
            await flush()
            assertEquals(form.getAttribute('aria-busy'), 'true')
            assertEquals(document.querySelector<HTMLButtonElement>('#cloud-backup-now')!.disabled, true)
            assertEquals(sent?.method, 'PUT')
            finish(Response.json({ configured: true }))
            await flush()
            assertEquals(status.dataset.state, 'success')
            assertEquals(status.textContent?.includes('自动备份已开启'), true)
            assertEquals(document.getElementById('cloud-status')!.textContent, syncStatus)
            assertEquals((await storage.local.get('syncType')).syncType, 'off')
            assertEquals((await storage.local.get('cloud')).cloud?.token, cloud.token)
            assertEquals(document.querySelector<HTMLInputElement>('#cloud-backup-password')!.value, '')
            assertEquals(document.querySelector<HTMLButtonElement>('#cloud-backup-now')!.disabled, false)

            globalThis.fetch = (() =>
                Promise.resolve(Response.json({ error: '需要管理权限' }, { status: 403 }))) as typeof fetch
            form.dispatchEvent(new Event('submit', { cancelable: true }))
            await flush()
            assertEquals(status.dataset.state, 'error')
            assertEquals(status.textContent, '需要管理权限')
            assertEquals(document.getElementById('cloud-status')!.textContent, syncStatus)
            assertEquals(form.getAttribute('aria-busy'), 'false')

            globalThis.fetch = (() =>
                Promise.resolve(
                    new Response(
                        '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
                        { status: 207 },
                    ),
                )) as typeof fetch
            document.querySelector<HTMLFormElement>('#webdav-form')!.dispatchEvent(
                new Event('submit', { cancelable: true }),
            )
            await flush()
            assertEquals(document.getElementById('webdav-status')!.textContent, '已连接')
            assertEquals((await storage.local.get('syncType')).syncType, 'off')
            assertEquals((await storage.local.get('webdav')).webdav?.autoSync, false)
            assertEquals((await storage.local.get('cloud')).cloud?.token, cloud.token)
        } finally {
            globalThis.fetch = originalFetch
            document.body.innerHTML = originalBody
            localStorage.clear()
            for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value)
        }
    },
})
