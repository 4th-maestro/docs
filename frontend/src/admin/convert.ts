import { webProfile, webStatus } from '../../twin/pipeline/web-demo.js'
import type { Plan, PlanFloor, Point } from '../floor-edit'

// 트윈 building.json → 서버 저장 형식 변환: 판매사 건물 추가, 도면 교체, 도면 편집 공용
// - twin: 호실 id에 건물 id 접두어를 붙인 building.json(서버 GET /buildings/{id}/twin 원본)
// - rooms: 실내기가 있는 실(type 'room')만, 필드는 lambda 호실 테이블과 같음(web-demo.js webStatus 기준)
// - plan: 내장 3D 형식(docs/human/reference/plan-storage.md), rooms와 같은 호실만, 좌표 y는 부호 반전
//   (트윈은 평면 y를 월드 +z, Twin3D는 평면 y를 월드 -z로 배치)
export type ServerRoom = { id: string; name: string; floor: string; use: string; areaM2: number; idu: string }
type PlanRoom3D = { id: string; polys: Point[][]; hvac: Point[] }
export type ServerPlan = { floors: Record<string, { elevation?: number; bounds: [number, number, number, number]; rooms: PlanRoom3D[] }> }
// 트윈 원본의 추가 필드(operation, odus, wifi 등)는 그대로 보존
export type Twin = Omit<Plan, 'building' | 'floors' | 'aps'> & {
  building: Plan['building'] & { floorHeight?: number }
  floors: (PlanFloor & { level?: number })[]
  aps?: (NonNullable<Plan['aps']>[number] & { in?: string | string[] })[]
}

// 건물 id: 서버 형식 ^b-[a-z0-9]{8}$, 중복이면 서버 409
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
export const newBuildingId = () => `b-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (v) => CHARS[v % CHARS.length]).join('')}`

// 호실 id 전역 고유: 모든 호실 id와 호실 참조에 '<건물 id>.' 접두어, 이미 붙은 값은 유지(편집 후 재저장)
// - 참조: idus[].room, aps[].room, aps[].in(호실 id인 값만), 구역 실의 zoneOf, 편집기 열린 벽 openWalls[].rooms
export function prefixTwin(B: Twin, bid: string): Twin {
  const head = `${bid}.`
  const p = (id: string) => (id.startsWith(head) ? id : head + id)
  const ids = new Set(B.floors.flatMap((f) => f.rooms.map((r) => r.id)))
  const ref = (id: string) => (ids.has(id) ? p(id) : id)
  return {
    ...B,
    floors: B.floors.map((f) => ({
      ...f,
      rooms: f.rooms.map((r) => ({ ...r, id: p(r.id), ...(r.zoneOf ? { zoneOf: p(r.zoneOf) } : {}) })),
      ...(f.openWalls ? { openWalls: f.openWalls.map((o) => ({ ...o, rooms: o.rooms.map(ref) })) } : {}),
    })),
    idus: (B.idus ?? []).map((u) => ({ ...u, room: p(u.room) })),
    ...(B.aps ? { aps: B.aps.map((a) => ({ ...a, ...(a.room ? { room: p(a.room) } : {}), ...(a.in ? { in: Array.isArray(a.in) ? a.in.map(ref) : ref(a.in) } : {}) })) } : {}),
  }
}

export function toServer(B: Twin, bid: string): { twin: Twin; rooms: ServerRoom[]; plan: ServerPlan } {
  const twin = prefixTwin(B, bid)
  const status = webStatus(twin, { id: bid })
  const rooms: ServerRoom[] = status.rooms.map((r: ServerRoom) => ({ id: r.id, name: r.name, floor: r.floor, use: r.use, areaM2: r.areaM2, idu: r.idu }))
  const keep = new Set(rooms.map((r) => r.id))
  const flip = (p: Point): Point => [p[0], -p[1]]
  const floors: ServerPlan['floors'] = {}
  twin.floors.forEach((f, i) => {
    const rs = f.rooms.filter((r) => keep.has(r.id)).map((r) => ({
      id: r.id,
      polys: [r.polygon.map(flip)],
      hvac: twin.idus.filter((u) => u.room === r.id).map((u) => flip(u.pos)),
    }))
    if (!rs.length) return
    const pts = rs.flatMap((r) => r.polys[0])
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    const h = twin.building.floorHeight
    floors[f.id] = { ...(h ? { elevation: (f.level ?? i) * h } : {}), bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], rooms: rs }
  })
  return { twin, rooms, plan: { floors } }
}

// 확인 단계 기본값: 이름은 도면 이름, 용도는 가장 많은 호실 용도, 운영 시간·주말은 building.json operation
export function twinDefaults(B: Twin) {
  const status = webStatus(B)
  const count = new Map<string, number>()
  for (const r of status.rooms as ServerRoom[]) count.set(r.use, (count.get(r.use) ?? 0) + 1)
  const use = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '기타'
  const { hours, weekend } = webProfile(B, status)
  const start = Math.min(Math.max(hours[0], 0), 23)
  return { name: (B.building.name ?? '').slice(0, 40), use: use.slice(0, 20), hours: [start, Math.min(Math.max(hours[1], start + 1), 24)] as [number, number], weekend, roomCount: status.rooms.length as number }
}
