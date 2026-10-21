/// <reference lib="deno.ns" />
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { assertEquals, assertRejects } from '@std/assert'
import { canonical } from '../src/scripts/shared/cloud.ts'
import type { CloudChange } from '../src/scripts/shared/cloud.ts'
import { commitChanges, readState } from './database.ts'
import { HttpError } from './http.ts'
import { renameDevice } from './devices.ts'
import type { AccountEnv } from './scope.ts'

class TestStatement {
    values: SQLInputValue[] = []

    constructor(public sql: string, private database: DatabaseSync) {}

    bind(...values: SQLInputValue[]): TestStatement {
        this.values = values
        return this
    }

    first(): Promise<unknown> {
        return Promise.resolve(this.database.prepare(this.sql).get(...this.values) ?? null)
    }

    run(): Promise<{ success: boolean; meta: { changes: number } }> {
        const result = this.database.prepare(this.sql).run(...this.values)
        return Promise.resolve({ success: true, meta: { changes: Number(result.changes) } })
    }
}

async function fixture(run: (env: AccountEnv, database: DatabaseSync) => Promise<void>): Promise<void> {
    const database = new DatabaseSync(':memory:')
    try {
        for (const name of ['0001_cloud.sql', '0002_deletion_guard.sql', '0003_accounts.sql']) {
            database.exec(await Deno.readTextFile(new URL(`./migrations/${name}`, import.meta.url)))
        }
        const env = {
            accountId: 'legacy',
            DB: {
                prepare: (sql: string) => new TestStatement(sql, database),
                batch(statements: TestStatement[]): Promise<{ results: unknown[] }[]> {
                    database.exec('BEGIN')
                    try {
                        const results = statements.map((statement) => ({
                            results: database.prepare(statement.sql).all(...statement.values),
                        }))
                        database.exec('COMMIT')
                        return Promise.resolve(results)
                    } catch (error) {
                        database.exec('ROLLBACK')
                        throw error
                    }
                },
            },
        } as unknown as AccountEnv
        await run(env, database)
    } finally {
        database.close()
    }
}

function change(key: string, value: unknown, baseRevision = 0): CloudChange {
    return { key, json: canonical(value), deleted: false, baseRevision }
}

const folder = { _id: 'linksFolder', folder: true, title: 'Folder', parent: '', order: 0 }
const child = { _id: 'linksChild', title: 'Child', url: 'https://example.com', parent: folder._id, order: 0 }

Deno.test('First upload accepts root folders and links with an empty parent', () =>
    fixture(async (env) => {
        const initial = [
            change('sync/linkgroups/groups', ['default', 'Work']),
            change('sync/linksFolder', folder),
            change('sync/linksChild', child),
            change('sync/linksRoot', { ...child, _id: 'linksRoot', parent: '' }),
            change('sync/linksDefault', { ...child, _id: 'linksDefault', parent: 'default' }),
            change('sync/linksWork', { ...child, _id: 'linksWork', parent: 'Work' }),
            change('sync/linksLegacy', { _id: 'linksLegacy', title: 'Legacy', url: child.url, order: 0 }),
        ]
        const id = crypto.randomUUID()
        const state = await commitChanges(env, 'test', id, initial, true)
        assertEquals(state.initialized, true)
        assertEquals(state.records.length, initial.length)
        assertEquals(state.records.find((record) => record.key === 'sync/linksFolder')?.json, canonical(folder))
        assertEquals(await commitChanges(env, 'test', id, initial, true), state)
    }))

Deno.test('First upload still rejects missing parents and rolls back the entire transaction', () =>
    fixture(async (env, database) => {
        await assertRejects(
            () =>
                commitChanges(env, 'test', crypto.randomUUID(), [
                    change('sync/tabtitle', 'Must not commit'),
                    change('sync/linksChild', { ...child, parent: 'missing-folder' }),
                ], true),
            HttpError,
            'missing-folder',
        )
        assertEquals(await readState(env), { initialized: false, records: [] })
        assertEquals(database.prepare('SELECT COUNT(*) AS count FROM account_mutations').get()?.count, 0)
        assertEquals(database.prepare('SELECT COUNT(*) AS count FROM account_history').get()?.count, 0)
    }))

Deno.test('Root folder support preserves stale revision and parent deletion guards', () =>
    fixture(async (env) => {
        const before = await commitChanges(env, 'test', crypto.randomUUID(), [
            change('sync/linksFolder', folder),
            change('sync/linksChild', child),
        ], true)
        const stale = await assertRejects(
            () =>
                commitChanges(env, 'test', crypto.randomUUID(), [
                    change('sync/linksChild', { ...child, title: 'Stale' }),
                ]),
            HttpError,
        )
        assertEquals(stale.status, 409)
        assertEquals(await readState(env), before)
        const orphan = await assertRejects(
            () =>
                commitChanges(env, 'test', crypto.randomUUID(), [{
                    key: 'sync/linksFolder',
                    json: null,
                    deleted: true,
                    baseRevision: 1,
                }]),
            HttpError,
        )
        assertEquals(orphan.status, 409)
        assertEquals(await readState(env), before)
        const moved = await commitChanges(env, 'test', crypto.randomUUID(), [
            { key: 'sync/linksFolder', json: null, deleted: true, baseRevision: 1 },
            change('sync/linksChild', { ...child, parent: '' }, 1),
        ])
        assertEquals(moved.records.find((record) => record.key === 'sync/linksFolder')?.deleted, true)
        assertEquals(moved.records.find((record) => record.key === 'sync/linksChild')?.revision, 2)
    }))

Deno.test('Device names can change only for active sessions within the same account', () =>
    fixture(async (env, database) => {
        const now = Date.now()
        for (
            const [id, account, expires, revoked] of [
                ['own', 'legacy', now + 86400000, null],
                ['other', 'legacy', now + 86400000, null],
                ['foreign', 'another-account', now + 86400000, null],
                ['expired', 'legacy', now - 1, null],
                ['revoked', 'legacy', now + 86400000, 'revoked'],
            ] as const
        ) {
            database.prepare(`INSERT INTO devices
                (id, name, token_hash, owner, created_at, account_id, expires_at, revoked_at)
                VALUES (?, 'Original', ?, 1, ?, ?, ?, ?)`).run(
                id,
                id,
                new Date().toISOString(),
                account,
                expires,
                revoked,
            )
        }
        const request = (name: unknown) =>
            new Request('https://cloud.example/api/devices/own', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            })
        assertEquals(await (await renameDevice(request('  我的电脑  '), env, 'own')).json(), {
            id: 'own',
            name: '我的电脑',
        })
        assertEquals(await (await renameDevice(request('手机'), env, 'other')).json(), { id: 'other', name: '手机' })
        for (const id of ['foreign', 'expired', 'revoked', 'missing']) {
            const error = await assertRejects(() => renameDevice(request('Changed'), env, id), HttpError)
            assertEquals(error.status, 404)
        }
        for (const name of ['', '   ', 123, 'x'.repeat(81)]) {
            const error = await assertRejects(() => renameDevice(request(name), env, 'own'), HttpError)
            assertEquals(error.status, 400)
        }
        assertEquals(database.prepare("SELECT name FROM devices WHERE id = 'own'").get()?.name, '我的电脑')
        assertEquals(database.prepare("SELECT name FROM devices WHERE id = 'foreign'").get()?.name, 'Original')
        assertEquals(database.prepare("SELECT name FROM devices WHERE id = 'expired'").get()?.name, 'Original')
        assertEquals(database.prepare("SELECT name FROM devices WHERE id = 'revoked'").get()?.name, 'Original')
    }))
