import { canonical, CLOUD_MAX_BODY, sha256, validCloudKey, validCloudMedia } from '../src/scripts/shared/cloud.ts'
import type { CloudChange, CloudRecord, CloudState } from '../src/scripts/shared/cloud.ts'
import { HttpError } from './http.ts'
import type { AccountEnv } from './scope.ts'

export interface RecordRow {
    key: string
    json: string | null
    revision: number
    deleted: number
}

export async function readState(env: AccountEnv): Promise<CloudState> {
    const [meta, records] = await env.DB.batch([
        env.DB.prepare('SELECT initialized FROM account_state WHERE account_id = ?').bind(env.accountId),
        env.DB.prepare('SELECT key, json, revision, deleted FROM account_records WHERE account_id = ? ORDER BY key')
            .bind(env.accountId),
    ])
    return {
        initialized: !!(meta.results[0] as { initialized: number } | undefined)?.initialized,
        records: (records.results as RecordRow[]).map(toRecord),
    }
}

export function toRecord(row: RecordRow): CloudRecord {
    return { key: row.key, json: row.json, revision: row.revision, deleted: !!row.deleted }
}

export function parseChanges(value: unknown): CloudChange[] {
    if (!Array.isArray(value) || value.length > 4000) throw new HttpError(400, '修改列表无效。')
    const keys = new Set<string>()
    return value.map((entry: CloudChange) => {
        if (
            !entry || typeof entry.key !== 'string' || !validCloudKey(entry.key) || keys.has(entry.key) ||
            !Number.isSafeInteger(entry.baseRevision) || entry.baseRevision < 0 ||
            typeof entry.deleted !== 'boolean' ||
            (entry.deleted ? entry.json !== null : typeof entry.json !== 'string')
        ) throw new HttpError(400, '修改条目无效。')
        keys.add(entry.key)
        let json = entry.json
        if (!entry.deleted && json !== null) {
            let parsed: unknown
            try {
                parsed = JSON.parse(json)
            } catch {
                throw new HttpError(400, '设置数据无效。')
            }
            if ((entry.key.startsWith('asset/') || entry.key.startsWith('icon/')) && !validCloudMedia(parsed)) {
                throw new HttpError(400, '媒体资源描述无效。')
            }
            json = canonical(parsed)
        }
        return { key: entry.key, json, deleted: entry.deleted, baseRevision: entry.baseRevision }
    })
}

function parentFailure(state: CloudState, changes: CloudChange[]): string {
    const records = new Map(
        state.records.filter((record) => !record.deleted).map((record) => [record.key, record.json!]),
    )
    for (const change of changes) {
        if (change.deleted) records.delete(change.key)
        else records.set(change.key, change.json!)
    }
    const groups: unknown = JSON.parse(records.get('sync/linkgroups/groups') ?? '[]')
    const parents = new Set<unknown>(['', 'default', ...(Array.isArray(groups) ? groups : [])])
    const links = [...records].filter(([key]) => key.startsWith('sync/')).map(([key, json]) => ({
        key,
        value: JSON.parse(json),
    })).filter(({ value }) => value && typeof value._id === 'string')
    for (const { value } of links) if (value.folder === true || value.folder === 1) parents.add(value._id)
    const orphan = links.find(({ value }) => !parents.has(value.parent ?? ''))
    if (!orphan) return '快捷链接的父级关系校验失败，本次修改尚未写入。'
    const title = typeof orphan.value.title === 'string' ? orphan.value.title.slice(0, 80) : orphan.key
    const parent = String(orphan.value.parent).slice(0, 80)
    return `快捷链接“${title}”所属的文件夹或分组“${parent}”不存在，本次修改尚未写入。`
}

export async function commitChanges(
    env: AccountEnv,
    deviceId: string,
    id: string,
    changes: CloudChange[],
    initialize = false,
    confirmClear = false,
): Promise<CloudState> {
    if (!/^[\w-]{16,100}$/.test(id)) throw new HttpError(400, '请求编号无效。')
    const payload = JSON.stringify(changes)
    if (new TextEncoder().encode(payload).length > CLOUD_MAX_BODY) throw new HttpError(413, '修改内容过大。')
    const hash = await sha256(canonical({ changes, initialize, confirmClear }))
    const previous = await env.DB.prepare(
        'SELECT device_id, hash FROM account_mutations WHERE account_id = ? AND id = ?',
    ).bind(env.accountId, id).first<{
        device_id: string
        hash: string
    }>()
    if (previous) {
        if (previous.hash !== hash) throw new HttpError(409, '请求编号已被使用。')
        return await readState(env)
    }
    const now = new Date().toISOString()
    const statements = [
        env.DB.prepare('INSERT INTO account_mutations VALUES (?, ?, ?, ?, ?)').bind(
            env.accountId,
            id,
            deviceId,
            hash,
            now,
        ),
        env.DB.prepare(
            'INSERT OR REPLACE INTO account_write_guard VALUES (?, (SELECT initialized = ? FROM account_state WHERE account_id = ?))',
        ).bind(env.accountId, initialize ? 0 : 1, env.accountId),
        env.DB.prepare(`INSERT OR REPLACE INTO account_write_guard VALUES (?, NOT EXISTS (
            SELECT 1 FROM json_each(?) op LEFT JOIN account_records r ON r.account_id = ? AND r.key = json_extract(op.value, '$.key')
            WHERE COALESCE(r.revision, 0) != json_extract(op.value, '$.baseRevision')
        ))`).bind(env.accountId, payload, env.accountId),
        env.DB.prepare(`INSERT OR REPLACE INTO account_deletion_guard VALUES (?, EXISTS (
            SELECT 1 FROM account_records WHERE account_id = ? AND deleted = 0 AND key LIKE 'sync/%' AND json_type(json, '$._id') = 'text'
        ), 1)`).bind(env.accountId, env.accountId),
        env.DB.prepare(`INSERT INTO account_records (account_id, key, json, revision, deleted, device_id, updated_at)
            SELECT ?, json_extract(value, '$.key'), json_extract(value, '$.json'),
                json_extract(value, '$.baseRevision') + 1, json_extract(value, '$.deleted'), ?, ?
            FROM json_each(?) WHERE true
            ON CONFLICT (account_id, key) DO UPDATE SET json = excluded.json, revision = excluded.revision,
                deleted = excluded.deleted, device_id = excluded.device_id, updated_at = excluded.updated_at`)
            .bind(env.accountId, deviceId, now, payload),
        env.DB.prepare(`UPDATE account_deletion_guard SET allowed = (? OR had_links = 0 OR EXISTS (
            SELECT 1 FROM account_records WHERE account_id = ? AND deleted = 0 AND key LIKE 'sync/%' AND json_type(json, '$._id') = 'text'
        )) WHERE account_id = ?`).bind(confirmClear ? 1 : 0, env.accountId, env.accountId),
        env.DB.prepare(`INSERT OR REPLACE INTO account_write_guard VALUES (?, NOT EXISTS (
            SELECT 1 FROM account_records child WHERE child.account_id = ? AND child.deleted = 0 AND child.key LIKE 'sync/%'
            AND json_type(child.json, '$._id') = 'text'
            AND COALESCE(json_extract(child.json, '$.parent'), '') NOT IN ('', 'default')
            AND NOT EXISTS (SELECT 1 FROM account_records folder WHERE folder.account_id = child.account_id AND folder.deleted = 0
                AND json_extract(folder.json, '$._id') = json_extract(child.json, '$.parent')
                AND json_extract(folder.json, '$.folder') = 1)
            AND NOT EXISTS (SELECT 1 FROM account_records groups, json_each(groups.json) g
                WHERE groups.account_id = child.account_id AND groups.key = 'sync/linkgroups/groups' AND groups.deleted = 0
                AND g.value = json_extract(child.json, '$.parent'))
        ))`).bind(env.accountId, env.accountId),
        env.DB.prepare('UPDATE account_state SET initialized = 1 WHERE account_id = ?').bind(env.accountId),
    ]
    try {
        await env.DB.batch(statements)
    } catch (error) {
        const replay = await env.DB.prepare(
            'SELECT device_id, hash FROM account_mutations WHERE account_id = ? AND id = ?',
        ).bind(env.accountId, id).first<{
            device_id: string
            hash: string
        }>()
        if (replay?.hash === hash) return await readState(env)
        if (String(error).includes('prevent_empty_cloud')) {
            throw new HttpError(409, '清空全部快捷链接需要在界面中明确确认。')
        }
        if (String(error).includes('CHECK constraint failed')) {
            const state = await readState(env)
            if (initialize && state.initialized) throw new HttpError(409, '云端已完成初始化，请采用云端内容后再修改。')
            if (!initialize && !state.initialized) throw new HttpError(409, '云端尚未初始化，请先上传完整的本机内容。')
            const revisions = new Map(state.records.map((record) => [record.key, record.revision]))
            if (changes.every((change) => (revisions.get(change.key) ?? 0) === change.baseRevision)) {
                throw new HttpError(409, parentFailure(state, changes))
            }
            throw new HttpError(409, '云端内容已变化，请重新同步；本次修改尚未写入。')
        }
        throw error
    }
    return await readState(env)
}
