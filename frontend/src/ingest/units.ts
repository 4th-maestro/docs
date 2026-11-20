import HVAC from './hvac-types.json' with { type: 'json' }
import { distance, edges, inRoom, projection, type Affine, type Detection, type IndoorUnit, type OutdoorUnit, type Plan, type PlanFloor, type PlanRoom, type Point } from '../floor-edit.ts'

// 실내기 매핑 계산(화면과 무관한 순수 함수). 규약: docs/human/reference/plan-ingest.md 3절
// 유형표 hvac-types.json은 _maestro/ml/hvac_types.json의 복사본이며 원본은 ml 폴더입니다.
export const TYPES = HVAC.types
const r2 = (v: number) => Math.round(v * 100) / 100

export const toPlan = (m: Affine, [u, v]: Point): Point => [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]]
export function fromPlan(m: Affine, [x, y]: Point): Point {
  const det = m[0] * m[4] - m[1] * m[3], dx = x - m[2], dy = y - m[5]
  return [(m[4] * dx - m[1] * dy) / det, (m[0] * dy - m[3] * dx) / det]
}

// 기준점 2쌍(도면 이미지 점 → 평면 점)으로 회전, 축척, 이동을 구함. 점이 겹치면 null
// 복소수 비 (q2 - q1) / (p2 - p1) = a + bi가 회전과 축척, 나머지가 이동
export function similarity([p1, p2]: Point[], [q1, q2]: Point[]): Affine | null {
  const du = p2[0] - p1[0], dv = p2[1] - p1[1], dx = q2[0] - q1[0], dy = q2[1] - q1[1]
  const n = du * du + dv * dv
  if (n < 1e-9 || dx * dx + dy * dy < 1e-9) return null
  const a = (dx * du + dy * dv) / n, b = (dy * du - dx * dv) / n
  return [a, -b, q1[0] - a * p1[0] + b * p1[1], b, a, q1[1] - b * p1[0] - a * p1[1]]
}

// 유형 표시 필드: 이름, LG 예시 모델, 매뉴얼. 목록에 없는 cls는 unknown
export function typeFields(cls: string): Pick<IndoorUnit, 'cls' | 'type' | 'model' | 'manual'> {
  const t = TYPES.find(x => x.class === cls)
  return t ? { cls, type: t.name, model: t.exampleModel ?? undefined, manual: t.manual } : { cls: 'unknown', type: '유형 미확인', model: undefined, manual: undefined }
}

// cls가 없는 기존 데이터의 표시 유형: 3D 트윈의 1방향, 4방향 판정(type, model 문자열)과 같은 규칙
export function clsOf(u: IndoorUnit): string {
  if (u.cls) return u.cls
  const text = `${u.type ?? ''} ${u.model ?? ''}`
  return /1\s*WAY|1방향/i.test(text) ? 'cassette_1way' : /벽걸이|WALL/i.test(text) ? 'wall_mounted' : 'cassette_4way'
}

// 호실 배정: 실(type room)을 먼저, 그다음 다른 공간. 포함하는 공간이 없으면 가장 가까운 실(inside false)
export function assignRoom(p: Point, rooms: PlanRoom[]): { room: PlanRoom; inside: boolean } | null {
  const hit = rooms.find(r => r.type === 'room' && inRoom(p, r)) ?? rooms.find(r => inRoom(p, r))
  if (hit) return { room: hit, inside: true }
  const pool = rooms.some(r => r.type === 'room') ? rooms.filter(r => r.type === 'room') : rooms
  let best: PlanRoom | null = null, gap = Infinity
  for (const r of pool) for (const [a, b] of edges(r.polygon)) {
    const d = distance(p, projection(p, a, b))
    if (d < gap) { gap = d; best = r }
  }
  return best && { room: best, inside: false }
}

// 인식 결과(도면 이미지 픽셀 상자) → 실내기. 신뢰도 0.5 미만, unknown, 호실 밖이면 review
export function detectionsToUnits(floor: PlanFloor, m: Affine, detections: Detection[] = floor.detections ?? []): IndoorUnit[] {
  const scale = Math.hypot(m[0], m[3])
  return detections.flatMap((d, i) => {
    const [u0, v0, u1, v1] = d.box
    const pos = toPlan(m, [(u0 + u1) / 2, (v0 + v1) / 2])
    const hit = assignRoom(pos, floor.rooms)
    if (!hit) return []
    const fields = typeFields(d.cls)
    return [{ id: `IDU-${floor.id}-yolo-${i + 1}`, room: hit.room.id, pos: [r2(pos[0]), r2(pos[1])] as Point, ...fields, source: 'yolo', conf: r2(d.conf),
      review: d.conf < .5 || fields.cls === 'unknown' || !hit.inside, size: [r2(Math.abs(u1 - u0) * scale), r2(Math.abs(v1 - v0) * scale)] as [number, number], ref: `det-${i + 1}` }]
  })
}

// 초안 정리: 위치를 맞춘 층(background.toPlan 있음)의 인식 결과를 실내기로 바꾸고 detections를 비움
// - 인식 결과가 1개 이상인 층은 파이프라인의 면적 추정 실내기(source estimate)를 뺌
// - 호실이 없는 실내기(파서 결과의 floor만 있음)는 그 층에서 호실을 배정하고, 실 밖이면 review
// - cls만 있는 실내기는 유형 이름, LG 예시 모델, 매뉴얼을 채움(원본 모델명은 유지)
export function applyDetections(plan: Plan): Plan {
  const rooms = new Set(plan.floors.flatMap(f => f.rooms.map(r => r.id)))
  let idus = plan.idus.map(u => {
    const floor = !rooms.has(u.room) && plan.floors.find(f => f.id === u.floor)
    const hit = floor && assignRoom(u.pos, floor.rooms)
    return hit ? { ...u, room: hit.room.id, review: u.review || !hit.inside } : u
  })
  const floors = plan.floors.map(f => {
    const m = f.background?.toPlan
    if (!m || !f.detections?.length) return f
    const ids = new Set(f.rooms.map(r => r.id))
    idus = [...idus.filter(u => !(ids.has(u.room) && u.source === 'estimate')), ...detectionsToUnits(f, m)]
    return { ...f, detections: [] }
  })
  return { ...plan, floors, idus: idus.map(u => (u.cls && !u.type ? { ...u, ...typeFields(u.cls), ...(u.model ? { model: u.model } : {}), ...(u.manual ? { manual: u.manual } : {}) } : u)) }
}

// 2D 매핑 화면에서 평면 좌우 바깥에 실외기 기호를 두는 여백(m)
export const ODU_MARGIN = 4
// 층별 서·동 실외기 id: 트윈 파이프라인 placeIdus와 같은 규칙(실내기 x가 건물 폭의 절반 미만이면 서측)
export const oduId = (floor: string, x: number, w: number) => `ODU-${floor}-${x < w / 2 ? 'W' : 'E'}`
export const oduFloor = (o: OutdoorUnit) => o.serves ?? o.id.split('-')[1]
// 실외기 연결: 실외기가 없는 실내기를 층별 서·동 실외기에 연결하고, 목록에 없는 실외기를 만들고, 기호 위치가 없으면 평면 좌우 여백에 둠
export function connectOdus(plan: Plan): Plan {
  const { w, d } = plan.building.size
  const floorOf = new Map(plan.floors.flatMap(f => f.rooms.map(r => [r.id, f.id] as const)))
  const idus = plan.idus.map(u => (u.odu || !floorOf.has(u.room) ? u : { ...u, odu: oduId(floorOf.get(u.room)!, u.pos[0], w) }))
  const odus = [...(plan.odus ?? [])]
  for (const u of idus) if (u.odu && !odus.some(o => o.id === u.odu)) {
    odus.push({ id: u.odu, model: 'LG MULTI V 실외기', location: `옥상 ${u.odu.endsWith('-W') ? '서측' : '동측'}`, serves: floorOf.get(u.room) })
  }
  // 같은 층 같은 쪽 실외기는 가운데에서 위아래로 3m씩 벌려 둠
  const placed: OutdoorUnit[] = []
  for (const o of odus) {
    const west = o.id.endsWith('-W'), k = placed.filter(p => oduFloor(p) === oduFloor(o) && p.id.endsWith('-W') === west).length
    const y = Math.min(d - .5, Math.max(.5, d / 2 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 3))
    placed.push(o.mark ? o : { ...o, mark: [west ? -ODU_MARGIN / 2 : w + ODU_MARGIN / 2, r2(y)] })
  }
  return { ...plan, idus, odus: placed }
}

// 편집할 수 있는 twin.building/v1인지 확인(건물 크기, 층별 실 목록)
export function asPlan(data: unknown): Plan {
  const plan = data as Partial<Plan> | null
  const size = plan?.building?.size
  if (plan?.schema !== 'twin.building/v1' || !size || !(size.w > 0) || !(size.d > 0) || !plan.floors?.length || !plan.floors.every(f => Array.isArray(f.rooms)))
    throw new Error('도면 변환 결과가 twin.building/v1 형식이 아닙니다.')
  return { ...(plan as Plan), idus: plan.idus ?? [] }
}

// 운영자 확인이 필요한 실내기와 위치를 맞추지 않은 인식 결과 수
export const reviewUnits = (plan: Plan) => plan.idus.filter(u => u.review)
export const pendingDetections = (plan: Plan) => plan.floors.reduce((n, f) => n + (f.detections?.length ?? 0), 0)
