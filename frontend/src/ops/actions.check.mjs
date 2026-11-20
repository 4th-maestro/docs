import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeDraft } from './actions.ts'

test('bulk operations keep building scope, deduplicate IDs and count partial failures', async () => {
  const calls = []
  const result = await executeDraft({ buildingId: 'main', action: 'accept', rooms: [], decisionIds: ['ok', 'stale', 'denied', 'offline', 'ok'] }, async (...args) => {
    calls.push(args)
    if (args[1] === 'stale') throw Object.assign(new Error('이미 처리됨'), { status: 409 })
    if (args[1] === 'denied') throw Object.assign(new Error('권한 없음'), { status: 403 })
    if (args[1] === 'offline') throw new Error('연결 실패')
  })
  assert.deepEqual(result, { success: 1, conflict: 1, failed: 2, errors: ['권한 없음', '연결 실패'] })
  assert.equal(calls.length, 4)
  assert.ok(calls.every(([building, , action]) => building === 'main' && action === 'accept'))
})

test('undo and reject preserve requested action', async () => {
  for (const action of ['undo', 'reject']) {
    const result = await executeDraft({ buildingId: 'office', action, rooms: ['A'], decisionIds: ['one'] }, async (building, id, got) => {
      assert.equal(building, 'office'); assert.equal(id, 'one'); assert.equal(got, action)
    })
    assert.equal(result.success, 1)
  }
})
