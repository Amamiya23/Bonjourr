import { assertEquals, assertThrows } from '@std/assert'
import {
    canonical,
    cloudChanges,
    cloudConflicts,
    cloudKey,
    flattenCloud,
    inflateCloud,
    validateCloudState,
    validCloudKey,
} from '../../src/scripts/shared/cloud.ts'
import type { CloudState } from '../../src/scripts/shared/cloud.ts'

Deno.test('Cloud records preserve nested preferences, atomic links and URL keys', () => {
    const source = {
        clock: { size: 2 },
        urls: { 'https://example.com/a/b': { format: 'image' } },
        linksA: { _id: 'linksA', title: 'A', url: 'https://example.com' },
    }
    const records: Record<string, string> = {}
    flattenCloud(source, ['sync'], records)
    assertEquals(Object.keys(records).length, 3)
    assertEquals(records['sync/linksA'], canonical(source.linksA))
    const state = {
        initialized: true,
        records: Object.entries(records).map(([key, json]) => ({ key, json, revision: 1, deleted: false })),
    }
    assertEquals(inflateCloud(state.records, 'sync'), source)
})

Deno.test('Cloud diffs distinguish explicit deletions from a fresh device', () => {
    const baseline: CloudState = {
        initialized: true,
        records: [{ key: 'sync/title', json: '"hello"', revision: 3, deleted: false }],
    }
    assertEquals(cloudChanges(baseline, {}), [{ key: 'sync/title', json: null, baseRevision: 3, deleted: true }])
    assertEquals(
        cloudChanges(
            { initialized: true, records: [{ key: 'sync/title', json: null, revision: 4, deleted: true }] },
            {},
        ),
        [],
    )
    const deleted = { ...baseline, records: [{ key: 'sync/title', json: null, revision: 4, deleted: true }] }
    assertEquals(cloudConflicts(cloudChanges(baseline, { 'sync/title': '"offline edit"' }), deleted), ['sync/title'])
})

Deno.test('Cloud conflicts only involve divergent edits to the same record', () => {
    const baseline: CloudState = {
        initialized: true,
        records: [{ key: 'sync/title', json: '"one"', revision: 1, deleted: false }],
    }
    const remote: CloudState = {
        initialized: true,
        records: [{ key: 'sync/title', json: '"remote"', revision: 2, deleted: false }],
    }
    assertEquals(cloudConflicts(cloudChanges(baseline, { 'sync/title': '"local"' }), remote), ['sync/title'])
    assertEquals(cloudConflicts(cloudChanges(baseline, { 'sync/title': '"remote"' }), remote), [])
    assertEquals(
        cloudConflicts([{ key: 'sync/greeting', json: '"hello"', deleted: false, baseRevision: 0 }], remote),
        [],
    )
})

Deno.test('Cloud keys and server responses reject unsafe or missing state instead of treating it as empty', () => {
    for (
        const key of [
            'local/cloud/token',
            'local/webdav/password',
            'sync/__proto__/polluted',
            'sync/a/constructor',
            'asset/test/other',
            'icon/unknown',
            'sync/%ZZ',
        ]
    ) assertEquals(validCloudKey(key), false)
    assertEquals(validCloudKey(cloudKey(['local', 'backgroundUrls', 'https://example.com/a/b', 'format'])), true)
    assertThrows(() => validateCloudState({ records: [] } as unknown as CloudState))
    assertThrows(() =>
        validateCloudState({
            initialized: true,
            records: [{ key: 'sync/name', json: 'invalid', revision: 1, deleted: false }],
        })
    )
})
