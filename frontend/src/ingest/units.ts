import HVAC from './hvac-types.json' with { type: 'json' }
import { distance, edges, inRoom, projection, type Affine, type Detection, type Door, type IndoorUnit, type OutdoorUnit, type Plan, type PlanFloor, type PlanRoom, type Point, type ScheduleRow } from '../floor-edit.ts'

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

// 냉방 용량과 출처. 정격 소비전력은 냉방 용량의 31%(직접 추가, 트윈 파이프라인 placeIdus와 같음)
export const kwFields = (coolKw: number, kwSource: IndoorUnit['kwSource']) => ({ coolKw, ratedKw: Math.round(coolKw * 31) / 100, kwSource })

type ModelRow = { kw: number; model: string; market?: string; source?: string; manual?: string }
type Match = Pick<IndoorUnit, 'model' | 'manual' | 'modelMatch' | 'coolKw' | 'ratedKw' | 'kwSource' | 'review'>
const tagKey = (s: string) => s.replace(/\s+/g, '').toUpperCase()

// 모델 대응(규약 3-5절): 장비 번호와 장비일람표(schedule) → 용량(exact, nearest) → 유형 예시(type)
// - 원본 모델명(source)과 직접 입력(manual)은 호출하는 쪽에서 유지. 일람표 행의 용량은 도면 용량보다 우선
// - 용량: types[].models에서 차이 0.05kW 이하는 exact, 아니면 용량 이상인 가장 작은 모델(없으면 가장 큰 모델)로 nearest와 review
// - 매뉴얼은 유형 매뉴얼. models 항목에 manual이 있으면 그 값
export function modelFor(cls: string, kw?: number, tag?: string, schedule: ScheduleRow[] = []): Match {
  const t = TYPES.find(x => x.class === cls)
  const row = tag ? schedule.find(r => tagKey(r.tag) === tagKey(tag)) : undefined
  const cap = row?.kw ?? kw
  const kwSet = row?.kw ? kwFields(row.kw, 'schedule') : {}
  if (row?.model) return { model: row.model, manual: t?.manual, modelMatch: 'schedule', ...kwSet }
  // 같은 용량은 JSON 순서(국내 모델 먼저)를 유지하는 안정 정렬
  const models = [...((t as { models?: ModelRow[] } | undefined)?.models ?? [])].sort((a, b) => a.kw - b.kw)
  if (cap && models.length) {
    const exact = models.find(m => Math.abs(m.kw - cap) <= .05 + 1e-9)
    const pick = exact ?? models.find(m => m.kw >= cap) ?? models[models.length - 1]
    return { model: pick.model, manual: pick.manual ?? t?.manual, modelMatch: exact ? 'exact' : 'nearest', review: !exact, ...kwSet }
  }
  return { model: t?.exampleModel ?? undefined, manual: t?.manual, modelMatch: t?.exampleModel ? 'type' : undefined, ...kwSet }
}

// 유형 표시 필드: 이름과 모델 대응(modelFor). 목록에 없는 cls는 unknown
export function typeFields(cls: string, kw?: number, tag?: string, schedule?: ScheduleRow[]): Pick<IndoorUnit, 'cls' | 'type'> & Match {
  const t = TYPES.find(x => x.class === cls)
  return { cls: t ? cls : 'unknown', type: t?.name ?? '유형 미확인', ...modelFor(cls, kw, tag, schedule) }
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

// 인식 결과(도면 이미지 픽셀 상자) → 실내기. 신뢰도 0.5 미만, unknown, 호실 밖, 용량 근사 모델이면 review. 문(cls door)은 제외
// - 상자 주변 용량 표기(kw)와 장비 번호(tag)로 모델 대응(modelFor). schedule은 meta.ingest.schedule
export function detectionsToUnits(floor: PlanFloor, m: Affine, schedule: ScheduleRow[] = []): IndoorUnit[] {
  const scale = Math.hypot(m[0], m[3])
  return (floor.detections ?? []).flatMap((d, i) => {
    if (d.cls === 'door') return []
    const [u0, v0, u1, v1] = d.box
    const pos = toPlan(m, [(u0 + u1) / 2, (v0 + v1) / 2])
    const hit = assignRoom(pos, floor.rooms)
    if (!hit) return []
    const fields = typeFields(d.cls, d.kw, d.tag, schedule)
    return [{ id: `IDU-${floor.id}-yolo-${i + 1}`, room: hit.room.id, pos: [r2(pos[0]), r2(pos[1])] as Point, ...(d.kw ? kwFields(d.kw, 'pdf-text') : {}), ...fields,
      tag: d.tag, source: 'yolo', conf: r2(d.conf), review: d.conf < .5 || fields.cls === 'unknown' || !hit.inside || !!fields.review, size: [r2(Math.abs(u1 - u0) * scale), r2(Math.abs(v1 - v0) * scale)] as [number, number], ref: `det-${i + 1}` }]
  })
}

// 기호 찾기 결과(POST /plans/match, 도면 이미지 픽셀 상자와 점수). 규약 3-6절
export type SymbolMatch = { box: [number, number, number, number]; score: number }
const centerOf = ([u0, v0, u1, v1]: SymbolMatch['box']): Point => [(u0 + u1) / 2, (v0 + v1) / 2]

// 위치를 맞춘 층: 기호 찾기 결과 → 실내기(source match, conf 점수, 점수 0.5 미만·실 밖·용량 근사 모델이면 review)
// - 기존 실내기(existing)나 먼저 넣은 결과와 중심 거리가 기호 크기(상자 긴 변, m) 미만이면 같은 자리로 보고 건너뜀
// - 모델은 유형 대응(typeFields). 용량 표기를 읽지 않으므로 유형 예시 모델
export function matchesToUnits(floor: PlanFloor, existing: IndoorUnit[], matches: SymbolMatch[], cls: string, m: Affine): IndoorUnit[] {
  const scale = Math.hypot(m[0], m[3]), taken = existing.map(u => u.pos), out: IndoorUnit[] = []
  matches.forEach((match, i) => {
    const [u0, v0, u1, v1] = match.box, size: [number, number] = [r2(Math.abs(u1 - u0) * scale), r2(Math.abs(v1 - v0) * scale)]
    const pos = toPlan(m, centerOf(match.box)), hit = assignRoom(pos, floor.rooms)
    if (!hit || taken.some(p => distance(p, pos) < Math.max(...size))) return
    const fields = typeFields(cls)
    taken.push(pos)
    out.push({ id: `IDU-${floor.id}-match-${crypto.randomUUID()}`, room: hit.room.id, pos: [r2(pos[0]), r2(pos[1])], ...fields, source: 'match', conf: r2(match.score),
      review: match.score < .5 || fields.cls === 'unknown' || !hit.inside || !!fields.review, size, ref: `match-${i + 1}` })
  })
  return out
}

// 위치를 맞추지 않은 층: 기호 찾기 결과 → 인식 결과(detections). 위치 맞춤 때 detectionsToUnits가 실내기로 바꿈
// 기존 인식 결과와 중심 거리가 상자 긴 변(픽셀) 미만이면 같은 기호로 보고 건너뜀
export function matchesToDetections(floor: PlanFloor, matches: SymbolMatch[], cls: string): Detection[] {
  const boxes = (floor.detections ?? []).map(d => d.box), out: Detection[] = []
  for (const { box, score } of matches) {
    const c = centerOf(box), side = Math.max(Math.abs(box[2] - box[0]), Math.abs(box[3] - box[1]))
    if (boxes.some(b => distance(centerOf(b), c) < side)) continue
    boxes.push(box)
    out.push({ cls, conf: r2(score), box })
  }
  return out
}

// 문 구간: 점 p에서 가장 가까운 호실 변(거리 max 이하)에 폭 w 구간을 둠. 맞는 변이 없으면 null
// - 변이 폭보다 길면 구간이 변 안에 들어가게 밀고, a→b가 dir과 반대면 a, b를 바꿔 기존 경첩, 열림 방향을 유지
export function snapDoor(rooms: PlanRoom[], p: Point, w: number, max: number, dir?: Point): { a: Point; b: Point } | null {
  // 공유 벽처럼 거리가 같은 변은 먼저 나온 변(1e-6m 차이까지 같은 거리로 봄)
  let edge: [Point, Point] | null = null, gap = max + 2e-6
  for (const r of rooms) for (const [a, b] of edges(r.polygon)) {
    const d = distance(p, projection(p, a, b))
    if (d < gap - 1e-6 && distance(a, b) > 1e-6) { gap = d; edge = [a, b] }
  }
  if (!edge) return null
  const [s, e] = edge, len = distance(s, e), ux = (e[0] - s[0]) / len, uy = (e[1] - s[1]) / len
  const t = len < w ? len / 2 : Math.min(len - w / 2, Math.max(w / 2, (p[0] - s[0]) * ux + (p[1] - s[1]) * uy))
  const at = (k: number): Point => [r2(s[0] + ux * k), r2(s[1] + uy * k)]
  const [a, b] = [at(t - w / 2), at(t + w / 2)]
  return dir && dir[0] * ux + dir[1] * uy < 0 ? { a: b, b: a } : { a, b }
}

// 인식 결과 중 문(cls door) → 문. 상자 중심에서 가장 가까운 호실 변(거리 ≤ 상자 긴 변)에 폭 = 긴 변 구간을 두고, 열림 쪽은 상자 중심 쪽
// 맞는 변이 없으면 상자 긴 축 위 구간. 맞는 변이 없거나 폭이 0.6~2.0m 밖이거나 신뢰도 0.5 미만이면 review(Lambda common.door_from_box와 같음). 경첩은 상자로 알 수 없어 a
export function detectionsToDoors(floor: PlanFloor, m: Affine, detections: Detection[] = floor.detections ?? []): Door[] {
  const scale = Math.hypot(m[0], m[3])
  return detections.flatMap((d, i): Door[] => {
    if (d.cls !== 'door') return []
    const [u0, v0, u1, v1] = d.box, uc = (u0 + u1) / 2, vc = (v0 + v1) / 2, wide = Math.abs(u1 - u0) >= Math.abs(v1 - v0)
    const w = Math.max(Math.abs(u1 - u0), Math.abs(v1 - v0)) * scale, c = toPlan(m, [uc, vc])
    const seg = snapDoor(floor.rooms, c, w, w)
    const { a, b } = seg ?? { a: toPlan(m, wide ? [u0, vc] : [uc, v0]).map(r2) as Point, b: toPlan(m, wide ? [u1, vc] : [uc, v1]).map(r2) as Point }
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    return [{ id: `DOOR-${floor.id}-yolo-${i + 1}`, a, b, hinge: 'a', side: cross > 1e-9 ? -1 : 1, source: 'yolo', conf: r2(d.conf),
      review: !seg || w < .6 || w > 2 || d.conf < .5, ref: `det-${i + 1}` }]
  })
}

// 초안 정리: 위치를 맞춘 층(background.toPlan 있음)의 인식 결과를 실내기와 문(cls door)으로 바꾸고 detections를 비움
// - 인식 결과가 1개 이상인 층은 파이프라인의 면적 추정 실내기(source estimate)를 뺌
// - 호실이 없는 실내기(파서 결과의 floor만 있음)는 그 층에서 호실을 배정하고, 실 밖이면 review
// - cls만 있는 실내기는 유형 이름, 모델, 매뉴얼을 채움. 원본 모델명은 유지(modelMatch source), 없으면 장비일람표, 용량, 유형 예시 순서로 대응
export function applyDetections(plan: Plan): Plan {
  const schedule = plan.meta?.ingest?.schedule
  const fill = (u: IndoorUnit): IndoorUnit => {
    const f: Partial<IndoorUnit> = u.model ? { ...typeFields(u.cls!), model: u.model, modelMatch: u.modelMatch ?? 'source' } : typeFields(u.cls!, u.coolKw, u.tag, schedule)
    return { ...u, ...f, ...(u.manual ? { manual: u.manual } : {}), review: u.review || f.review }
  }
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
    idus = [...idus.filter(u => !(ids.has(u.room) && u.source === 'estimate')), ...detectionsToUnits(f, m, schedule)]
    return { ...f, detections: [], doors: [...(f.doors ?? []), ...detectionsToDoors(f, m)] }
  })
  return { ...plan, floors, idus: idus.map(u => (u.cls && !u.type ? fill(u) : u)) }
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

// 운영자 확인이 필요한 실내기, 문과 위치를 맞추지 않은 인식 결과 수
export const reviewUnits = (plan: Plan) => plan.idus.filter(u => u.review)
export const reviewDoors = (plan: Plan) => plan.floors.flatMap(f => (f.doors ?? []).filter(d => d.review))
export const pendingDetections = (plan: Plan) => plan.floors.reduce((n, f) => n + (f.detections?.length ?? 0), 0)
