// 실내기 매핑 계산 자가 점검: node src/ingest/units.check.mjs (Node 23.6 이상, TypeScript 형식 제거 실행)
// 범위: 기준점 변환, 호실 배정, 인식 결과 변환, 인식용 보정 해상도와 픽셀 → m 환산
import assert from 'node:assert/strict'
import { applyDetections, assignRoom, connectOdus, detectionsToUnits, fromPlan, ODU_MARGIN, similarity, toPlan } from './units.ts'
import { autoUnits } from './auto-units.ts'
import { MARGIN, rectify } from '../../twin/pipeline/pipeline-core.js'
import { detectRes } from '../../twin/pipeline/host-bridge.js'

const near = (a, b, eps = 1e-6) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < eps), `${a} ≠ ${b}`)

// 1. 기준점 2쌍: 90도 회전, 축척 0.05, 이동 (10, 2) → 두 점과 임의의 점이 모두 맞아야 함
const truth = ([u, v]) => [10 - v * .05, 2 + u * .05]
const m = similarity([[100, 40], [300, 260]], [truth([100, 40]), truth([300, 260])])
near(toPlan(m, [520, 77]), truth([520, 77]))
near(fromPlan(m, truth([520, 77])), [520, 77])
assert.equal(similarity([[1, 1], [1, 1]], [[0, 0], [1, 0]]), null)

// 2. 호실 배정: 포함하는 실, 실 밖이면 가장 가까운 실
const rooms = [
  { id: 'A', name: 'A', type: 'room', polygon: [[0, 0], [5, 0], [5, 4], [0, 4]] },
  { id: 'B', name: 'B', type: 'room', polygon: [[5, 0], [10, 0], [10, 4], [5, 4]] },
  { id: 'C', name: '복도', type: 'corridor', polygon: [[0, 4], [10, 4], [10, 6], [0, 6]] },
]
assert.deepEqual([assignRoom([2, 2], rooms).room.id, assignRoom([2, 2], rooms).inside], ['A', true])
assert.deepEqual([assignRoom([3, 5], rooms).room.id, assignRoom([3, 5], rooms).inside], ['C', true])
assert.deepEqual([assignRoom([11, 1], rooms).room.id, assignRoom([11, 1], rooms).inside], ['B', false])

// 3. 인식 결과 → 실내기: 상자 중심 좌표, 크기(m), review 조건(신뢰도 0.5 미만, unknown, 실 밖)
const floor = { id: '2F', rooms, detections: [
  { cls: 'cassette_4way', conf: .9, box: [40, 40, 60, 60] },
  { cls: 'wall_mounted', conf: .3, box: [140, 20, 160, 30] },
  { cls: 'mystery', conf: .8, box: [140, 60, 160, 80] },
  { cls: 'cassette_1way', conf: .8, box: [215, 20, 225, 30] },
] }
const scale = [.05, 0, 0, 0, .05, 0]
const units = detectionsToUnits(floor, scale)
assert.deepEqual(units.map(u => [u.room, u.pos, u.review]), [['A', [2.5, 2.5], false], ['B', [7.5, 1.25], true], ['B', [7.5, 3.5], true], ['B', [11, 1.25], true]])
assert.deepEqual(units[0].size, [1, 1])
assert.deepEqual([units[0].type, units[0].model, units[0].source], ['천장형 4방향 카세트', 'ARNU12GTRB4', 'yolo'])
assert.equal(units[2].cls, 'unknown')

// 4. 초안 정리: 맞춘 층만 변환, 면적 추정 실내기 제외, 미맞춤 층은 detections 유지
const plan = { schema: 'twin.building/v1', building: { name: 't', size: { w: 10, d: 6 } },
  floors: [{ ...floor, background: { px: [200, 120], toPlan: scale } }, { id: '3F', rooms: [], detections: floor.detections, background: { px: [200, 120], toPlan: null } }],
  idus: [{ id: 'old', room: 'A', pos: [1, 1], source: 'estimate' }, { id: 'kept', room: 'A', pos: [1, 1], source: 'plan' }, { id: 'ifc', room: 'B', pos: [6, 1], cls: 'ceiling_duct', model: 'X-1' }] }
const out = applyDetections(plan)
assert.deepEqual(out.idus.map(u => u.id), ['kept', 'ifc', 'IDU-2F-yolo-1', 'IDU-2F-yolo-2', 'IDU-2F-yolo-3', 'IDU-2F-yolo-4'])
assert.deepEqual([out.floors[0].detections.length, out.floors[1].detections.length], [0, 4])
assert.deepEqual([out.idus[1].type, out.idus[1].model], ['천장 매립 덕트형', 'X-1'])
// 5. 인식용 보정 해상도: 80px/m 상한, 원본 해상도 상한, 여백 포함 긴 변 8000px 상한
assert.equal(detectRes([[0, 0], [1999, 0], [1999, 999], [0, 999]], 10, 5, MARGIN), 80)
assert.equal(detectRes([[0, 0], [480, 0], [480, 350], [0, 350]], 48, 35, MARGIN), 10)
assert.equal(detectRes([[0, 0], [40000, 0], [40000, 10000], [0, 10000]], 200, 50, MARGIN), 37.7)

// 6. 원본(약 200px/m)에서 80px/m로 다시 보정한 이미지의 픽셀 → 평면 m(toPlan = [1/80, 0, -MARGIN, …])이 원래 위치와 같아야 함
const src = { width: 2000, height: 1000, data: new Uint8ClampedArray(2000 * 1000 * 4).fill(255) }
for (let y = 590; y < 610; y++) for (let x = 390; x < 410; x++) src.data.fill(0, (y * 2000 + x) * 4, (y * 2000 + x) * 4 + 3)
const res = detectRes([[0, 0], [1999, 0], [1999, 999], [0, 999]], 10, 5, MARGIN)
const rect = rectify(src, [[0, 0], [1999, 0], [1999, 999], [0, 999]], 10, 5, res)
assert.deepEqual([rect.width, rect.height], [1760, 1360])
let su = 0, sv = 0, n = 0
for (let j = 0; j < rect.height; j++) for (let i = 0; i < rect.width; i++) if (rect.data[(j * rect.width + i) * 4] < 128) { su += i + .5; sv += j + .5; n++ }
near(toPlan([1 / res, 0, -MARGIN, 0, 1 / res, -MARGIN], [su / n, sv / n]), [400 / 199.9, 600 / 199.8], .02)

// 7. 호실 없는 파서 실내기(floor만 있음): 그 층에서 호실 배정, 실 밖이면 review
const loose = applyDetections({ ...plan, floors: plan.floors.map(f => ({ ...f, detections: [] })), idus: [{ id: 'p1', room: '', floor: '2F', pos: [7, 2] }, { id: 'p2', room: '', floor: '2F', pos: [12, 2] }] })
assert.deepEqual(loose.idus.map(u => [u.room, Boolean(u.review)]), [['B', false], ['B', true]])
console.log('units.check: 통과')

// 실외기 연결과 빈 호실 추정: 20×10m 건물, 1F에 실 3개(서측 60㎡ 실내기 없음, 동측 30㎡ 실내기 없음, 동측 실 실내기 1대), 복도 1개
{
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  const plan = { schema: 'twin.building/v1', building: { name: 't', size: { w: 20, d: 10 } }, floors: [{ id: '1F', rooms: [
    { id: 'A', name: 'A', type: 'room', polygon: sq(0, 0, 10, 6) }, { id: 'B', name: 'B', type: 'room', polygon: sq(10, 0, 15, 6) },
    { id: 'C', name: 'C', type: 'room', polygon: sq(15, 0, 20, 6) }, { id: 'H', name: '복도', type: 'corridor', polygon: sq(0, 6, 20, 10) }] }],
    idus: [{ id: 'u1', room: 'C', pos: [17, 3] }] }
  const c = connectOdus(plan)
  assert.equal(c.idus[0].odu, 'ODU-1F-E')
  assert.deepEqual(c.odus.map(o => [o.id, o.serves, o.mark]), [['ODU-1F-E', '1F', [20 + ODU_MARGIN / 2, 5]]])
  const { plan: a, added } = autoUnits(plan)
  // A 60㎡ → 2대(4방향), B 30㎡ → 1대(1방향), C는 기존 1대 유지, 복도 제외
  assert.equal(added, 3)
  assert.deepEqual(a.idus.filter(u => u.source === 'estimate').map(u => [u.room, u.cls, u.review, u.odu]),
    [['A', 'cassette_4way', true, 'ODU-1F-W'], ['A', 'cassette_4way', true, 'ODU-1F-W'], ['B', 'cassette_1way', true, 'ODU-1F-E']])
  assert.deepEqual(a.odus.map(o => o.id).sort(), ['ODU-1F-E', 'ODU-1F-W'])
  assert.ok(a.odus.every(o => o.mark[0] < 0 || o.mark[0] > 20), '실외기 기호는 평면 좌우 여백')
  // 위치를 맞추지 않은 인식 결과가 있는 층은 추정하지 않음
  assert.equal(autoUnits({ ...plan, floors: plan.floors.map(f => ({ ...f, detections: [{ cls: 'cassette_4way', conf: .9, box: [0, 0, 1, 1] }] })) }).added, 0)
  console.log('실외기 연결, 빈 호실 추정 통과')
}

