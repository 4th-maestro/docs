// 변환 자가 점검: node src/admin/convert.check.mjs (Node 22.18 이상, .ts 타입 제거 실행)
// - 접두어 중복 방지(재변환 결과 동일), twin·rooms·plan 호실 id 일치, 호실 참조 갱신, 층 문(doors) 보존
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { newBuildingId, toServer } from './convert.ts'

const read = (p) => JSON.parse(readFileSync(new URL(`../../twin/data/${p}`, import.meta.url), 'utf8'))
const bid = newBuildingId()
assert.match(bid, /^b-[a-z0-9]{8}$/)

for (const file of ['building.json', 'busan-station/building.json']) {
  const src = read(file)
  const once = toServer(src, bid)
  assert.deepEqual(toServer(once.twin, bid), once, `${file}: 재변환 결과 불일치`)
  const ids = new Set(once.twin.floors.flatMap((f) => f.rooms.map((r) => r.id)))
  assert.ok([...ids].every((id) => id.startsWith(`${bid}.`) && !id.startsWith(`${bid}.${bid}.`)), `${file}: 접두어 누락·중복`)
  const srcIds = new Set(src.floors.flatMap((f) => f.rooms.map((r) => r.id)))
  for (const [i, u] of once.twin.idus.entries()) assert.equal(u.room, srcIds.has(src.idus[i].room) ? `${bid}.${src.idus[i].room}` : u.room)
  for (const a of once.twin.aps ?? []) for (const id of [a.room, a.in].flat().filter(Boolean)) assert.ok(ids.has(id) || !srcIds.has(id), `${file}: AP 호실 참조 ${id}`)
  const plan = Object.values(once.plan.floors).flatMap((f) => f.rooms.map((r) => r.id))
  assert.ok(once.rooms.length > 0, `${file}: 호실 없음`)
  assert.deepEqual(new Set(plan), new Set(once.rooms.map((r) => r.id)), `${file}: rooms·plan id 불일치`)
  assert.ok(plan.every((id) => ids.has(id)), `${file}: plan id가 twin에 없음`)
  console.log(`${file}: 호실 ${once.rooms.length}개, 층 ${Object.keys(once.plan.floors).length}개`)
}

const door = { id: 'DOOR-1F-edit-1', a: [2, 4], b: [2.9, 4], hinge: 'a', side: 1, source: 'manual' }
const src = read('building.json')
assert.deepEqual(toServer({ ...src, floors: src.floors.map((f, i) => (i ? f : { ...f, doors: [door] })) }, bid).twin.floors[0].doors, [door], '문 보존')
console.log('convert 자가 점검 통과')
