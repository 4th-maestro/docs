// 실내기 매핑 계산 자가 점검: node src/ingest/units.check.mjs (Node 23.6 이상, TypeScript 형식 제거 실행)
// 범위: 기준점 변환, 호실 배정, 인식 결과 변환(실내기, 문), 기호 찾기 결과 변환, 인식용 보정 해상도와 픽셀 → m 환산, 실외기 연결, 빈 호실 추정, 모델 대응
import assert from 'node:assert/strict'
import { applyDetections, assignRoom, connectOdus, detectionsToDoors, detectionsToUnits, fromPlan, matchesToDetections, matchesToUnits, modelFor, ODU_MARGIN, similarity, snapDoor, toPlan, TYPES } from './units.ts'
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

// 8. 문 인식 결과(cls door): 가장 가까운 호실 변 위 구간(폭 = 상자 긴 변), 열림 쪽은 상자 중심 쪽, review(변 없음, 폭 0.6~2.0m 밖), 실내기로 바꾸지 않음
{
  const dets = [
    { cls: 'door', conf: .8, box: [40, 60, 60, 80] },      // 실 A 아래 벽(y 4) 위쪽 1m 상자 → A의 변 [5,4]→[0,4]
    { cls: 'door', conf: .7, box: [100, 40, 150, 90] },    // 2.5m 상자 → 폭 범위 밖
    { cls: 'door', conf: .6, box: [400, 400, 410, 420] },  // 건물 밖 → 맞는 변 없음, 상자 긴 축(세로) 구간
    { cls: 'cassette_4way', conf: .9, box: [40, 40, 60, 60] },
  ]
  const f = { id: '2F', rooms, detections: dets }
  const doors = detectionsToDoors(f, scale)
  assert.deepEqual(doors.map(d => [d.id, d.a, d.b, d.hinge, d.side, d.review, d.ref]), [
    ['DOOR-2F-yolo-1', [3, 4], [2, 4], 'a', -1, false, 'det-1'],
    ['DOOR-2F-yolo-2', [7.5, 4], [5, 4], 'a', -1, true, 'det-2'],
    ['DOOR-2F-yolo-3', [20.25, 20], [20.25, 21], 'a', 1, true, 'det-3'],
  ])
  assert.ok(doors.every(d => d.source === 'yolo'))
  assert.deepEqual(detectionsToUnits(f, scale).map(u => u.ref), ['det-4'])
  const out = applyDetections({ ...plan, floors: [{ ...f, background: { px: [200, 120], toPlan: scale } }], idus: [] })
  assert.deepEqual([out.floors[0].detections.length, out.floors[0].doors.length, out.idus.length], [0, 3, 1])
  // 변 끝을 넘는 점은 변 안으로 밀고, dir과 반대 방향 변이면 a, b를 바꿈
  assert.deepEqual(snapDoor(rooms, [.1, 4], .9, .3), { a: [.9, 4], b: [0, 4] })
  assert.deepEqual(snapDoor(rooms, [.1, 4], .9, .3, [1, 0]), { a: [0, 4], b: [.9, 4] })
  assert.equal(snapDoor(rooms, [2.5, 2], .9, .3), null)
}
// 9. 기호 찾기 결과: 맞춘 층은 실내기(기존 실내기 자리·앞 결과와 겹침 건너뜀, 점수 0.5 미만·실 밖 review), 미맞춤 층은 detections(기존 상자 자리 건너뜀)
{
  const f = { id: '2F', rooms }
  const ms = [
    { box: [40, 40, 60, 60], score: 1 }, // A (2.5, 2.5)
    { box: [140, 40, 160, 60], score: .42 }, // B (7.5, 2.5), 점수 낮음
    { box: [10, 10, 30, 30], score: .9 }, // A (1, 1): 기존 실내기 (1.2, 1)와 0.2m(기호 1m 미만)
    { box: [44, 44, 64, 64], score: .8 }, // 첫 결과와 0.28m
    { box: [215, 20, 235, 40], score: .7 }, // 건물 밖 (11.25, 1.5) → 가장 가까운 실 B, review
  ]
  const us = matchesToUnits(f, [{ id: 'old', room: 'A', pos: [1.2, 1] }], ms, 'cassette_1way', scale)
  assert.deepEqual(us.map(u => [u.room, u.pos, u.conf, u.review, u.ref]), [
    ['A', [2.5, 2.5], 1, false, 'match-1'], ['B', [7.5, 2.5], .42, true, 'match-2'], ['B', [11.25, 1.5], .7, true, 'match-5']])
  assert.deepEqual([us[0].source, us[0].cls, us[0].type, us[0].model, us[0].size],
    ['match', 'cassette_1way', TYPES.find(t => t.class === 'cassette_1way').name, modelFor('cassette_1way').model, [1, 1]])
  assert.equal(new Set(us.map(u => u.id)).size, 3)
  const dets = matchesToDetections({ id: '3F', rooms: [], detections: [{ cls: 'cassette_4way', conf: .9, box: [42, 42, 62, 62] }] }, ms, 'wall_mounted')
  assert.deepEqual(dets.map(d => [d.cls, d.conf, d.box]), [['wall_mounted', .42, [140, 40, 160, 60]], ['wall_mounted', .9, [10, 10, 30, 30]], ['wall_mounted', .7, [215, 20, 235, 40]]])
}
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


// 모델 대응(규약 3-5절): 시험용 용량표(정렬 안 됨, 7.2kW만 자체 매뉴얼). 실제 표가 들어와도 시험 결과가 같도록 덮어쓰고 끝에 되돌림
{
  // 시험용 용량표: 4방향은 고정 값, 1방향은 비움(실제 표와 무관하게 유형 예시 대체를 점검)
  const t4 = TYPES.find(t => t.class === 'cassette_4way'), saved = t4.models
  const t1 = TYPES.find(t => t.class === 'cassette_1way'), saved1 = t1.models
  t1.models = []
  const td = TYPES.find(t => t.class === 'ceiling_duct'), savedD = { models: td.models, exampleModel: td.exampleModel }
  td.models = []; td.exampleModel = null
  t4.models = [{ kw: 7.2, model: 'K-72', manual: 'https://m/72' }, { kw: 3.6, model: 'K-36' }, { kw: 5.6, model: 'K-56' }]
  const pick = r => [r.model, r.modelMatch, Boolean(r.review)]
  assert.deepEqual(pick(modelFor('cassette_4way', 7.2)), ['K-72', 'exact', false])
  assert.equal(modelFor('cassette_4way', 7.2).manual, 'https://m/72')
  assert.deepEqual(pick(modelFor('cassette_4way', 7.15)), ['K-72', 'exact', false], '차이 0.05kW는 exact')
  assert.deepEqual(pick(modelFor('cassette_4way', 4)), ['K-56', 'nearest', true], '용량 이상인 가장 작은 모델')
  assert.equal(modelFor('cassette_4way', 4).manual, t4.manual, '항목 매뉴얼이 없으면 유형 매뉴얼')
  assert.deepEqual(pick(modelFor('cassette_4way', 20)), ['K-72', 'nearest', true], '용량 이상 모델이 없으면 가장 큰 모델')
  assert.deepEqual(pick(modelFor('cassette_4way')), ['ARNU12GTRB4', 'type', false], '용량을 모르면 유형 예시')
  assert.deepEqual(pick(modelFor('cassette_1way', 5.6)), ['ARNU07GTUA4', 'type', false], '용량표가 없는 유형은 유형 예시')
  assert.deepEqual(pick(modelFor('ceiling_duct', 5.6)), [undefined, undefined, false], '예시 모델도 없으면 모델 없음')
  // 장비일람표: 장비 번호는 공백, 대소문자 무시. 행의 용량이 도면 용량보다 우선. 모델 없는 행은 행 용량으로 대응
  const schedule = [{ tag: 'FCU-1', model: 'RNW0721T2S', kw: 7.1 }, { tag: 'FCU-2', kw: 5.6 }]
  assert.deepEqual(modelFor('cassette_4way', 3.6, 'fcu-1 ', schedule), { model: 'RNW0721T2S', manual: t4.manual, modelMatch: 'schedule', coolKw: 7.1, ratedKw: 2.2, kwSource: 'schedule' })
  assert.deepEqual([...pick(modelFor('cassette_4way', 9, 'FCU-2', schedule)), modelFor('cassette_4way', 9, 'FCU-2', schedule).kwSource], ['K-56', 'exact', false, 'schedule'])
  assert.deepEqual(pick(modelFor('cassette_4way', 3.6, 'FCU-9', schedule)), ['K-36', 'exact', false], '일람표에 없는 번호는 용량으로 대응')

  // 인식 결과: 용량 표기와 장비 번호를 실내기로 옮김(kwSource pdf-text), 용량 근사는 review, 문은 제외
  const f = { id: '2F', rooms, detections: [
    { cls: 'cassette_4way', conf: .9, box: [40, 40, 60, 60], kw: 5.6, tag: 'AC-1' },
    { cls: 'cassette_4way', conf: .9, box: [140, 20, 160, 30], kw: 6 },
    { cls: 'door', conf: .8, box: [40, 60, 60, 80], kw: 7.2 },
    { cls: 'cassette_4way', conf: .9, box: [140, 60, 160, 70], tag: 'FCU-1', kw: 3.6 },
  ] }
  const us = detectionsToUnits(f, scale, schedule)
  assert.deepEqual(us.map(u => [u.ref, u.tag, u.coolKw, u.kwSource, u.model, u.modelMatch, u.review]), [
    ['det-1', 'AC-1', 5.6, 'pdf-text', 'K-56', 'exact', false],
    ['det-2', undefined, 6, 'pdf-text', 'K-72', 'nearest', true],
    ['det-4', 'FCU-1', 7.1, 'schedule', 'RNW0721T2S', 'schedule', false],
  ])
  assert.equal(us[0].ratedKw, 1.74)

  // 초안 정리: 원본 모델명 유지(source), 파서 용량(cad-text)으로 대응, meta.ingest.schedule의 장비 번호 대응
  const out = applyDetections({ ...plan, meta: { ingest: { schedule } }, floors: [{ ...f, background: { px: [200, 120], toPlan: scale } }], idus: [
    { id: 'ifc', room: 'A', pos: [1, 1], cls: 'cassette_4way', model: 'X-1', source: 'ifc' },
    { id: 'cad', room: 'A', pos: [2, 1], cls: 'cassette_4way', coolKw: 3.6, kwSource: 'cad-text', source: 'cad' },
    { id: 'tag', room: 'B', pos: [6, 1], cls: 'cassette_4way', tag: 'FCU-1', source: 'cad' },
  ] })
  assert.deepEqual(out.idus.slice(0, 3).map(u => [u.id, u.model, u.modelMatch, u.coolKw, u.kwSource]), [
    ['ifc', 'X-1', 'source', undefined, undefined], ['cad', 'K-36', 'exact', 3.6, 'cad-text'], ['tag', 'RNW0721T2S', 'schedule', 7.1, 'schedule']])
  assert.equal(out.idus.find(u => u.ref === 'det-4').model, 'RNW0721T2S')

  // 빈 호실 추정(60㎡, 4방향): 추정 용량으로 대응, kwSource 없음, source estimate 유지
  const big = { id: 'R', name: 'R', type: 'room', polygon: [[0, 0], [10, 0], [10, 6], [0, 6]] }
  const est = autoUnits({ schema: 'twin.building/v1', building: { name: 't', size: { w: 10, d: 6 } }, floors: [{ id: '1F', rooms: [big] }], idus: [] }).plan.idus[0]
  assert.deepEqual([est.source, est.kwSource, est.review, est.model, est.modelMatch], ['estimate', undefined, true, ...pick(modelFor('cassette_4way', est.coolKw)).slice(0, 2)])
  assert.ok(est.coolKw > 0)
  t4.models = saved
  t1.models = saved1
  Object.assign(td, savedD)
  console.log('모델 대응 통과')
}
