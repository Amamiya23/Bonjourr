import { assertEquals } from '@std/assert'
import { canonical, sha256 } from '../../src/scripts/shared/cloud.ts'

const endpoint = Deno.env.get('BONJOURR_CLOUD_TEST_URL')

Deno.test({
    name: 'Worker accounts isolate data, control registration, preserve sync history and revoke sessions',
    ignore: !endpoint,
    fn: async () => {
        const server = new URL(endpoint!)
        if (!['localhost', '127.0.0.1'].includes(server.hostname)) {
            throw new Error('Integration tests only run against localhost.')
        }
        const request = async (
            path: string,
            token?: string,
            body?: unknown,
            method = body === undefined ? 'GET' : 'POST',
        ) => {
            const response = await fetch(new URL(`/api/${path}`, server), {
                method,
                headers: {
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            })
            const text = await response.text()
            return { status: response.status, data: text ? JSON.parse(text) : undefined }
        }
        assertEquals((await request('state')).status, 401)
        assertEquals((await request('pair', '', {})).status, 410)
        assertEquals((await request('auth/config')).data.setupRequired, true)
        assertEquals(
            (await request('auth/register', '', { username: 'UntrustedFirst', password: 'Test-password-2026' })).status,
            403,
        )
        const candidates = await Promise.all(
            ['AdminTest', 'AdminCandidate'].map((username) =>
                request('auth/register', 'bonjourr-local-development-owner-only', {
                    username,
                    password: 'Test-password-2026',
                    name: 'Owner test',
                })
            ),
        )
        assertEquals(candidates.filter((result) => result.status === 200).length, 1)
        const registered = candidates.find((result) => result.status === 200)!
        const credentials = { username: registered.data.username as string, password: 'Test-password-2026' }
        assertEquals(registered.status, 200)
        assertEquals(registered.data.admin, true)
        const owner: string = registered.data.token
        assertEquals((await request('auth/config')).data.registrationOpen, false)
        assertEquals(
            (await request('auth/register', '', { username: 'BlockedTest', password: credentials.password })).status,
            403,
        )
        assertEquals((await request('auth/login', '', { ...credentials, password: 'wrong-password' })).status, 401)
        const state = await request('state', owner)
        assertEquals(state.data.initialized, false)
        assertEquals(state.data.records.find((item: { key: string }) => item.key === 'sync/favicon').json, '"legacy"')
        assertEquals((await request('sync', owner, { id: crypto.randomUUID(), changes: [] })).status, 409)
        const link = (id: string) => canonical({ _id: id, title: id, url: 'https://example.com', order: 1 })
        const initial = ['A', 'B'].map((id) => ({
            key: `sync/links${id}`,
            json: link(`links${id}`),
            deleted: false,
            baseRevision: 0,
        }))
        initial.push({ key: 'sync/tabtitle', json: '"initial"', deleted: false, baseRevision: 0 })
        const initId = crypto.randomUUID()
        const init = await request('initialize', owner, { id: initId, changes: initial })
        assertEquals(init.status, 200)
        assertEquals((await request('initialize', owner, { id: crypto.randomUUID(), changes: [] })).status, 409)
        assertEquals((await request('initialize', owner, { id: initId, changes: initial })).status, 200)
        const other = await request('auth/login', '', { ...credentials, name: 'Phone test' })
        assertEquals(other.status, 200)
        const phone: string = other.data.token
        assertEquals(other.data.accountId, registered.data.accountId)
        const edit = (key: string, value: unknown, baseRevision: number) => ({
            key,
            json: canonical(value),
            deleted: false,
            baseRevision,
        })
        const mutation = { id: crypto.randomUUID(), changes: [edit('sync/tabtitle', 'owner', 1)] }
        assertEquals((await request('sync', owner, mutation)).status, 200)
        assertEquals((await request('sync', owner, mutation)).status, 200)
        assertEquals(
            (await request('sync', phone, { id: crypto.randomUUID(), changes: [edit('sync/greeting', 'phone', 0)] }))
                .status,
            200,
        )
        const conflict = await request('sync', phone, {
            id: crypto.randomUUID(),
            changes: [edit('sync/tabtitle', 'stale', 1), edit('sync/css', 'must not commit', 0)],
        })
        assertEquals(conflict.status, 409)
        const afterConflict = (await request('state', owner)).data.records
        assertEquals(afterConflict.find((item: { key: string }) => item.key === 'sync/css'), undefined)
        assertEquals(afterConflict.find((item: { key: string }) => item.key === 'sync/tabtitle').revision, 2)
        const race = await Promise.all(
            ['one', 'two'].map((value) =>
                request('sync', phone, { id: crypto.randomUUID(), changes: [edit('sync/tabtitle', value, 2)] })
            ),
        )
        assertEquals(race.map((item) => item.status).sort(), [200, 409])
        const group = edit('sync/linkgroups/groups', ['default', 'work'], 0)
        const groupLink = edit('sync/linksC', {
            _id: 'linksC',
            parent: 'work',
            title: 'work',
            url: 'https://example.com',
            order: 1,
        }, 0)
        assertEquals(
            (await request('sync', owner, { id: crypto.randomUUID(), changes: [group, groupLink] })).status,
            200,
        )
        assertEquals(
            (await request('sync', owner, {
                id: crypto.randomUUID(),
                changes: [edit('sync/linkgroups/groups', ['default'], 1)],
            })).status,
            409,
        )
        const bytes = new TextEncoder().encode('image content')
        const hash = await sha256(bytes)
        const uploaded = await fetch(new URL(`/api/assets/${hash}`, server), {
            method: 'PUT',
            headers: { Authorization: `Bearer ${owner}` },
            body: bytes,
        })
        assertEquals(uploaded.status, 204)
        await uploaded.body?.cancel()
        const unauthorized = await fetch(new URL(`/api/assets/${hash}`, server))
        assertEquals(unauthorized.status, 401)
        await unauthorized.body?.cancel()
        const media = { type: 'image/png', bytes: bytes.length, parts: [{ hash, bytes: bytes.length }] }
        assertEquals(
            (await request('sync', owner, { id: crypto.randomUUID(), changes: [edit('icon/x-icon-test', media, 0)] }))
                .status,
            200,
        )
        const absent = { ...media, parts: [{ hash: 'f'.repeat(64), bytes: bytes.length }] }
        assertEquals(
            (await request('sync', owner, {
                id: crypto.randomUUID(),
                changes: [edit('icon/x-icon-missing', absent, 0)],
            })).status,
            409,
        )
        const remove = ['linksA', 'linksB', 'linksC'].map((id) => ({
            key: `sync/${id}`,
            json: null,
            deleted: true,
            baseRevision: 1,
        }))
        assertEquals((await request('sync', owner, { id: crypto.randomUUID(), changes: remove })).status, 409)
        assertEquals(
            (await request('sync', owner, { id: crypto.randomUUID(), changes: remove, confirmClear: true })).status,
            200,
        )
        const history = (await request('history', owner)).data
        const originalLink = history.find((item: { key: string; revision: number }) =>
            item.key === 'sync/linksA' && item.revision === 1
        )
        assertEquals((await request('history/restore', owner, { id: originalLink.id, baseRevision: 1 })).status, 409)
        assertEquals((await request('history/restore', owner, { id: originalLink.id, baseRevision: 2 })).status, 200)
        const originalB = history.find((item: { key: string; revision: number }) =>
            item.key === 'sync/linksB' && item.revision === 1
        )
        assertEquals((await request('history/restore', owner, { id: originalB.id, baseRevision: 2 })).status, 200)
        const deleteRace = await Promise.all(['linksA', 'linksB'].map((id) =>
            request('sync', owner, {
                id: crypto.randomUUID(),
                changes: [{ key: `sync/${id}`, json: null, deleted: true, baseRevision: 3 }],
            })
        ))
        assertEquals(deleteRace.map((item) => item.status).sort(), [200, 409])
        const remaining = (await request('state', owner)).data.records.filter((
            item: { key: string; deleted: boolean },
        ) => ['sync/linksA', 'sync/linksB'].includes(item.key) && !item.deleted)
        assertEquals(remaining.length, 1)
        assertEquals((await request('admin/registration', owner, { registrationOpen: true }, 'PUT')).status, 200)
        const userCredentials = { username: 'OtherUser', password: 'Another-password-2026' }
        const user = await request('auth/register', '', userCredentials)
        assertEquals(user.status, 200)
        assertEquals(user.data.admin, false)
        assertEquals((await request('auth/register', '', { ...userCredentials, username: 'OTHERUSER' })).status, 409)
        assertEquals((await request('admin/registration', user.data.token)).status, 403)
        assertEquals((await request('state', user.data.token)).data, { initialized: false, records: [] })
        assertEquals((await request('history', user.data.token)).data, [])
        assertEquals(
            (await request('history/restore', user.data.token, { id: originalLink.id, baseRevision: 0 })).status,
            404,
        )
        assertEquals((await request('backups', user.data.token)).data, [])
        const otherAsset = await fetch(new URL(`/api/assets/${hash}`, server), {
            headers: { Authorization: `Bearer ${user.data.token}` },
        })
        assertEquals(otherAsset.status, 404)
        await otherAsset.body?.cancel()
        assertEquals(
            (await request('initialize', user.data.token, {
                id: mutation.id,
                changes: [edit('sync/tabtitle', 'Private user title', 0)],
            })).status,
            200,
        )
        assertEquals(
            (await request('state', owner)).data.records.some((item: { json: string }) =>
                item.json === '"Private user title"'
            ),
            false,
        )
        const userDevices = (await request('devices', user.data.token)).data
        assertEquals(userDevices.length, 1)
        assertEquals(userDevices[0].id, user.data.deviceId)
        assertEquals(
            (await request(`devices/${registered.data.deviceId}`, user.data.token, undefined, 'DELETE')).status,
            204,
        )
        assertEquals((await request('state', owner)).status, 200)
        assertEquals((await request('admin/registration', owner, { registrationOpen: false }, 'PUT')).status, 200)
        assertEquals(
            (await request('auth/register', '', { username: 'BlockedAgain', password: credentials.password })).status,
            403,
        )
        const revoke = await request(`devices/${other.data.deviceId}`, owner, undefined, 'DELETE')
        assertEquals(revoke.status, 204)
        assertEquals((await request('state', phone)).status, 401)
        const cors = await fetch(new URL('/api/state', server), {
            headers: { Authorization: `Bearer ${owner}`, Origin: 'https://unrelated.example' },
        })
        assertEquals(cors.status, 403)
        await cors.body?.cancel()
        const third = await request('auth/login', '', { ...credentials, name: 'Third browser' })
        const newPassword = 'Changed-password-2026'
        const changed = await request('auth/password', owner, {
            currentPassword: credentials.password,
            password: newPassword,
        })
        assertEquals(changed.status, 200)
        assertEquals((await request('state', owner)).status, 401)
        assertEquals((await request('state', third.data.token)).status, 401)
        assertEquals((await request('state', changed.data.token)).status, 200)
        assertEquals((await request('auth/login', '', credentials)).status, 401)
        assertEquals((await request('auth/login', '', { ...credentials, password: newPassword })).status, 200)
        assertEquals((await request('auth/logout', changed.data.token, {})).status, 204)
        assertEquals((await request('state', changed.data.token)).status, 401)
        for (let attempt = 0; attempt < 11; attempt++) {
            const response = await request('auth/login', '', {
                username: 'MissingUser',
                password: 'incorrect-password',
            })
            assertEquals(response.status, attempt < 10 ? 401 : 429)
        }
        assertEquals(
            (await request('auth/login', '', { username: 'LargeBody', password: 'x'.repeat(5000) })).status,
            413,
        )
    },
})
