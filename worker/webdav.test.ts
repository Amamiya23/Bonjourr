/// <reference lib="deno.ns" />
import { assertEquals, assertRejects } from '@std/assert'
import { backupCloud, backupSettings } from './webdav.ts'
import { canonical, sha256 } from '../src/scripts/shared/cloud.ts'
import type { AccountEnv } from './scope.ts'

interface TestStatement {
    bind: (...args: unknown[]) => TestStatement
    first: () => Promise<{ encrypted: string } | null>
    run: () => Promise<{ success: boolean; meta: { changes: number } }>
}

async function fixture(
    run: (
        state: {
            env: AccountEnv
            writes: string[]
            manifests: string[]
            stored: () => string
            failed: () => boolean
            failMedia: () => void
        },
    ) => Promise<void>,
): Promise<void> {
    let encrypted = ''
    let failed = false
    let rejectMedia = false
    const writes: string[] = []
    const manifests: string[] = []
    const bytes = new TextEncoder().encode('image')
    const hash = await sha256(bytes)
    const records = [{
        key: 'icon/x-icon-test',
        json: canonical({ type: 'image/png', bytes: bytes.length, parts: [{ hash, bytes: bytes.length }] }),
        revision: 1,
        deleted: 0,
    }]
    const env = {
        accountId: 'legacy',
        BACKUP_KEY: '0'.repeat(64),
        DB: {
            prepare(sql: string): TestStatement {
                let values: unknown[] = []
                return {
                    bind(...args: unknown[]): TestStatement {
                        values = args
                        return this
                    },
                    first(): Promise<{ encrypted: string } | null> {
                        return Promise.resolve(sql.includes('backup_config') && encrypted ? { encrypted } : null)
                    },
                    run(): Promise<{ success: boolean; meta: { changes: number } }> {
                        if (sql.startsWith('INSERT OR REPLACE INTO account_backup_config')) {
                            encrypted = String(values[1])
                        }
                        if (sql.includes("status = 'failed'")) failed = true
                        return Promise.resolve({ success: true, meta: { changes: 1 } })
                    },
                }
            },
            batch(): Promise<{ results: unknown[] }[]> {
                return Promise.resolve([{ results: [{ initialized: 1 }] }, { results: records }])
            },
        },
        MEDIA: { get: () => Promise.resolve({ body: new Response(bytes).body }) },
    } as unknown as AccountEnv
    const original = globalThis.fetch
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
        const url = String(_url)
        if (init?.method === 'MKCOL') return Promise.resolve(new Response(null, { status: 201 }))
        if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 404 }))
        if (init?.method === 'PUT') {
            writes.push(url)
            if (url.endsWith('.json')) manifests.push(String(init.body))
            if (rejectMedia && !url.endsWith('.json')) return Promise.resolve(new Response(null, { status: 507 }))
            return Promise.resolve(new Response(null, { status: 201 }))
        }
        throw new Error('Unexpected request')
    }) as typeof fetch
    try {
        await run({
            env,
            writes,
            manifests,
            stored: () => encrypted,
            failed: () => failed,
            failMedia: () => {
                rejectMedia = true
            },
        })
    } finally {
        globalThis.fetch = original
    }
}

const config = { url: 'https://dav.example/root/', directory: 'Cloud', username: 'owner', password: 'private-password' }
const settingsRequest = (value: unknown) =>
    new Request('https://service.example/api/backup/config', { method: 'PUT', body: JSON.stringify(value) })

Deno.test('Server backup encrypts credentials and never returns the stored password', () =>
    fixture(async ({ env, stored }) => {
        assertEquals((await backupSettings(settingsRequest(config), env)).status, 200)
        assertEquals(stored().includes('private-password'), false)
        assertEquals(stored().includes('dav.example'), false)
        const response = await backupSettings(new Request('https://service.example/api/backup/config'), env)
        const body = await response.json() as { configured: boolean; username: string; password?: string }
        assertEquals(body.configured, true)
        assertEquals(body.username, 'owner')
        assertEquals(body.password, undefined)
        await assertRejects(
            () => backupSettings(settingsRequest({ ...config, url: 'http://127.0.0.1/private' }), env),
            Error,
            'HTTPS',
        )
    }))

Deno.test('Server backup writes immutable media before dated snapshots and excludes authentication secrets', () =>
    fixture(async ({ env, writes, manifests }) => {
        await backupSettings(settingsRequest(config), env)
        await backupCloud(env, 'first')
        await backupCloud(env, 'second')
        assertEquals(writes.length, 4)
        assertEquals(writes[0].includes('/assets/'), true)
        assertEquals(writes[1].endsWith('-first.json'), true)
        assertEquals(writes[3].endsWith('-second.json'), true)
        assertEquals(writes[1] === writes[3], false)
        assertEquals(JSON.parse(manifests[0]).state.initialized, true)
        assertEquals(manifests.some((body) => body.includes('private-password') || body.includes('token_hash')), false)
    }))

Deno.test('A failed media backup does not publish a complete snapshot', () =>
    fixture(async ({ env, failMedia, manifests, failed }) => {
        await backupSettings(settingsRequest(config), env)
        failMedia()
        await backupCloud(env, 'failed')
        assertEquals(failed(), true)
        assertEquals(manifests.length, 0)
    }))
