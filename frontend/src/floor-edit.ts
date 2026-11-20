import { wallSpans as solidWallSpans } from '../twin/pipeline/wall-spans.js'

export { solidWallSpans }

export type Point = [number, number]
export type PlanRoom = { id: string; name: string; type: string; polygon: Point[]; holes?: Point[][]; capacity?: number; number?: string; zoneOf?: string; zoneBasis?: unknown; use?: string; finish?: unknown }
export type Segment = { a: Point; b: Point }
export type WallAxis = 'vertical' | 'horizontal'
export type Wall = Segment & { room: string; hole?: boolean }
export type Opening = Segment & { rooms: string[] }
// 도면 변환 확장 필드(background, detections, cls 등): docs/human/reference/plan-ingest.md 3절
export type Affine = [number, number, number, number, number, number]
export type Detection = { cls: string; conf: number; box: [number, number, number, number] }
export type PlanBackground = { key?: string; px: [number, number]; toPlan: Affine | null }
export type PlanFloor = { id: string; rooms: PlanRoom[]; footprint?: Point[] | Point[][]; atrium?: boolean; openWalls?: Opening[]; partitions?: Segment[]; elevation?: number; background?: PlanBackground; detections?: Detection[] }
export type IndoorUnit = { id: string; room: string; pos: Point; model?: string; type?: string; coolKw?: number; ratedKw?: number; source?: string; basis?: string
  cls?: string; manual?: string; conf?: number; review?: boolean; rot?: number; size?: [number, number]; ref?: string; floor?: string }
export type Plan = {
  schema: 'twin.building/v1'
  building: { name: string; size: { w: number; d: number } }
  floors: PlanFloor[]
  idus: IndoorUnit[]
  atrium?: { x0: number; y0: number; x1: number; y1: number }
  aps?: { room?: string; floor?: string; pos: Point }[]
  meta?: { ingest?: { jobId?: string; kind?: string; createdAt?: string; warnings?: string[] } }
}

const EPS = 1e-5
export const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1])
const lineSide = (a: Point, b: Point, p: Point) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
const key = (p: Point) => p.map(v => v.toFixed(5)).join(',')
export const edges = (points: Point[]) => points.map((a, i) => [a, points[(i + 1) % points.length]] as [Point, Point])
function clean(points: Point[]) {
  return points.filter((p, i) => !i || distance(points[i - 1], p) > EPS)
    .filter((p, i, all) => i !== all.length - 1 || distance(p, all[0]) > EPS)
}
function signedArea(polygon: Point[]) {
  return edges(polygon).reduce((sum, [a,b]) => sum + a[0] * b[1] - a[1] * b[0], 0) / 2
}
export const area = (polygon: Point[]) => Math.abs(signedArea(polygon))
export function contains(p: Point, polygon: Point[]) {
  return edges(polygon).reduce((inside, [a,b]) =>
    (a[1] > p[1]) !== (b[1] > p[1]) && p[0] < a[0] + (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) ? !inside : inside, false)
}
export function projection(p: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy
  const t = length2 ? Math.min(1, Math.max(0, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / length2)) : 0
  return [a[0] + t*dx, a[1] + t*dy]
}

export function alignWallPoint(start: Point, target: Point, tolerance: number): { point: Point; axis?: WallAxis } {
  const dx = Math.abs(target[0]-start[0]), dy = Math.abs(target[1]-start[1])
  if (dy >= tolerance*1.5 && dx <= tolerance) return { point:[start[0],target[1]], axis:'vertical' }
  if (dx >= tolerance*1.5 && dy <= tolerance) return { point:[target[0],start[1]], axis:'horizontal' }
  return { point:target }
}

export function intersectWallAxis(target: Point, a: Point, b: Point, axis: WallAxis): Point | null {
  const i = axis === 'vertical' ? 0 : 1
  const delta = b[i]-a[i]
  if (Math.abs(delta) < EPS) return Math.abs(target[i]-a[i]) < EPS ? projection(target,a,b) : null
  const t = (target[i]-a[i])/delta
  if (t < 0 || t > 1) return null
  const point = interpolate(a,b,t)
  point[i] = target[i]
  return point
}

const interpolate = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0])*t, a[1] + (b[1] - a[1])*t]
const onEdge = (p: Point, a: Point, b: Point, tolerance = EPS) => distance(p, projection(p,a,b)) <= tolerance
export const inRoom = (p: Point, r: PlanRoom) => contains(p,r.polygon) && !r.holes?.some(h => contains(p,h))

export function floorBoundary(plan: Plan, floor: PlanFloor) {
  const {w,d} = plan.building.size
  const footprint = floor.footprint
  const outer: Point[][] = footprint?.length
    ? (Array.isArray(footprint[0][0]) ? footprint as Point[][] : [footprint as Point[]])
    : [[[0,0],[w,0],[w,d],[0,d]]]
  const voids: Point[][] = []
  if (floor.atrium && plan.atrium) {
    const {x0,y0,x1,y1} = plan.atrium
    voids.push([[x0,y0],[x1,y0],[x1,y1],[x0,y1]])
  }
  return { outer, voids }
}

export function isExteriorWall(a: Point, b: Point, outer: Point[][], voids: Point[][]) {
  const mid = interpolate(a,b,.5)
  if (!outer.some(loop => contains(mid,loop) || edges(loop).some(([c,d]) => onEdge(mid,c,d,.12)))) return true
  return [...outer,...voids].some(loop => edges(loop).some(([c,d]) =>
    onEdge(mid,c,d,.12) && Math.abs(lineSide(c,d,a) - lineSide(c,d,b)) <= distance(c,d)*distance(a,b)*.08))
}

export function interiorWallAt(floor: PlanFloor, p: Point, tolerance: number, outer: Point[][], voids: Point[][], preferred?: string, solidOnly = false): Wall | null {
  let best = tolerance, wall: Wall | null = null
  for (const r of floor.rooms) for (const ring of [r.polygon,...(r.holes ?? [])]) for (const [a,b] of edges(ring)) {
    if (distance(a,b) <= EPS || !onEdge(p,a,b,tolerance) || isExteriorWall(a,b,outer,voids)) continue
    const spans = solidOnly ? solidWallSpans(a,b,r.id,floor.openWalls ?? []) : [[a,b]] as [Point, Point][]
    for (const [u,v] of spans) {
      const dist = distance(p,projection(p,u,v))
      const score = dist - (r.id === preferred ? .045 : r.type === 'room' ? .02 : 0)
      if (dist > tolerance || score >= best) continue
      best = score
      wall = { a:u,b:v,room:r.id,hole:ring !== r.polygon }
    }
  }
  return wall
}

export function nearestSegment<T extends Segment>(segments: T[], p: Point, tolerance: number) {
  let closest: T | undefined
  for (const segment of segments) {
    const d = distance(p,projection(p,segment.a,segment.b))
    if (d < tolerance) { closest = segment; tolerance = d }
  }
  return closest
}

export function partitionTarget(start: Point, target: Point, opening: Opening | undefined, snapDistance: number) {
  if (!opening) return { point:target, restores:false }
  const snapped = projection(target,opening.a,opening.b)
  // Preserve small angles on short walls while still letting users snap onto the original line.
  const tolerance = Math.min(snapDistance,distance(start,target)*.04)
  return distance(target,snapped) <= tolerance
    ? { point:snapped, restores:true }
    : { point:target, restores:false }
}

export function segmentWithout<T extends Segment>(segment: T, a: Point, b: Point): T[] {
  const ends = [projection(a,segment.a,segment.b),projection(b,segment.a,segment.b)].sort((u,v) => distance(segment.a,u)-distance(segment.a,v))
  return [{ ...segment,b:ends[0] },{ ...segment,a:ends[1] }].filter(({a,b}) => distance(a,b) > .06)
}

export function overlapsWall(segment: Segment, a: Point, b: Point, tolerance = .025) {
  const length = distance(a,b)
  if (length < EPS || [segment.a,segment.b].some(p => Math.abs(lineSide(a,b,p))/length > tolerance)) return false
  return distance(projection(segment.a,a,b),projection(segment.b,a,b)) > .06
}

export function segmentInsideRoom(a: Point, b: Point, room: PlanRoom) {
  const border = [room.polygon,...(room.holes ?? [])].flatMap(edges)
  const points = [a,b,...border.flatMap(([u,v]) => intersection(a,b,u,v))].sort((u,v) => distance(a,u)-distance(a,v))
  return points.slice(1).every((p,i) => {
    const midpoint = interpolate(p,points[i],.5)
    return distance(p,points[i]) < EPS || inRoom(midpoint,room) && !border.some(([u,v]) => onEdge(midpoint,u,v))
  })
}

function intersection(a: Point, b: Point, c: Point, d: Point): Point[] {
  const [dx,dy] = [b[0]-a[0],b[1]-a[1]], [ex,ey] = [d[0]-c[0],d[1]-c[1]]
  const denom = dx*ey - dy*ex
  if (Math.abs(denom) < EPS) return [c,d].filter(p => onEdge(p,a,b))
  const [x,y] = [c[0]-a[0],c[1]-a[1]]
  const t = (x*ey-y*ex)/denom, u = (x*dy-y*dx)/denom
  return t >= -EPS && t <= 1+EPS && u >= -EPS && u <= 1+EPS ? [interpolate(a,b,Math.max(0,Math.min(1,t)))] : []
}

// Split both outlines at their intersections and keep the sides that bound the resulting area.
function polygonChange(subject: Point[], strip: Point[], operation: 'add' | 'subtract'): Point[] | null {
  const rings = [edges(subject),edges(strip)]
  const inside = (p: Point) => operation === 'add' ? contains(p,subject) || contains(p,strip) : contains(p,subject) && !contains(p,strip)
  const boundary = new Map<string,[Point,Point]>()
  rings.forEach((ring,i) => ring.forEach(([a,b]) => {
    const points = [a,b,...rings[1-i].flatMap(([c,d]) => intersection(a,b,c,d))]
    const sorted = [...new Map(points.map(p => [key(p),p])).values()].sort((p,q) => distance(a,p)-distance(a,q))
    for (const [j,u] of sorted.slice(0,-1).entries()) {
      const v = sorted[j+1], length = distance(u,v)
      if (length < EPS) continue
      const [x,y] = interpolate(u,v,.5), dx = (v[1]-u[1])*EPS/length, dy = (v[0]-u[0])*EPS/length
      const left = inside([x-dx,y+dy]), right = inside([x+dx,y-dy])
      if (left === right) continue
      const segment: [Point,Point] = left ? [u,v] : [v,u]
      boundary.set(segment.map(key).join('|'),segment)
    }
  }))
  return traceBoundary(boundary)
}

const meet = (a: Point[], b: Point[]) => a.some(p => contains(p,b)) || b.some(p => contains(p,a)) ||
  edges(a).some(([u,v]) => edges(b).some(([c,d]) => intersection(u,v,c,d).length > 0))

export function moveInteriorWall(floor: PlanFloor, wall: Wall, target: Point, outer: Point[][], voids: Point[][]) {
  const owner = floor.rooms.find(r => r.id === wall.room)
  const {a,b} = wall, length = distance(a,b)
  if (!owner || wall.hole || length < EPS || isExteriorWall(a,b,outer,voids)) return null
  const normal: Point = [(a[1]-b[1])/length,(b[0]-a[0])/length]
  const mid = interpolate(a,b,.5)
  const wanted = (target[0]-mid[0])*normal[0] + (target[1]-mid[1])*normal[1]
  if (Math.abs(wanted) < .06) return null
  const offset = (p: Point): Point => [p[0]+normal[0]*wanted,p[1]+normal[1]*wanted]
  const newA = offset(a), newB = offset(b), strip = [a,b,newB,newA]
  const boundaryEdges = outer.flatMap(edges)
  const insideOuter = (p: Point) => outer.some(loop => contains(p,loop)) || boundaryEdges.some(([c,d]) => onEdge(p,c,d))
  if (strip.some(p => !insideOuter(p)) ||
      edges(strip).some(([u,v]) => {
        const points = [u,v,...boundaryEdges.flatMap(([c,d]) => intersection(u,v,c,d))].sort((p,q) => distance(u,p)-distance(u,q))
        return points.slice(1).some((p,i) => !insideOuter(interpolate(p,points[i],.5)))
      }) ||
      [...voids,...(owner.holes ?? [])].some(loop => meet(loop,strip))) return null
  const expand = wanted * signedArea(owner.polygon) < 0
  const polygon = polygonChange(owner.polygon,strip,expand ? 'add' : 'subtract')
  const delta = length*Math.abs(wanted)
  if (!polygon || area(polygon) < 1 || Math.abs(area(polygon)-area(owner.polygon)-(expand ? delta : -delta)) > .01) return null
  const shared = sharedWallAt(floor.rooms,mid,.3,owner.id)
  const neighbor = shared?.rooms.find(id => id !== owner.id)
  const reachesOldWall = (r: PlanRoom) => edges(r.polygon).some(([u,v]) =>
    [interpolate(a,b,.15),mid,interpolate(a,b,.85)].some(p => onEdge(p,u,v,.35)) ||
    [u,v].some(p => onEdge(p,a,b,.35)))
  const rooms: PlanRoom[] = []
  for (const r of floor.rooms) {
    if (r.id === owner.id) { rooms.push({ ...r,polygon }); continue }
    const resize = expand ? meet(r.polygon,strip) : r.id === neighbor
    if (!resize) { rooms.push(r); continue }
    const updated = polygonChange(r.polygon,strip,expand ? 'subtract' : 'add')
    if (!updated || area(updated) < 1 || r.holes?.some(h => meet(h,strip))) return null
    if (Math.abs(area(updated)-area(r.polygon)) <= .001) { rooms.push(r); continue }
    if (!reachesOldWall(r)) return null
    rooms.push({ ...r,polygon:updated })
  }
  return { rooms, a:newA, b:newB, meters:Math.abs(wanted) }
}

export function splitPolygon(polygon: Point[], a: Point, b: Point): [Point[], Point[]] | null {
  const ring = edges(polygon)
  if (![a,b].every(p => ring.some(([u,v]) => distance(p,projection(p,u,v)) < EPS))) return null
  const cuts = new Set<string>()
  const halves: [Point[], Point[]] = [[],[]]
  for (const [u,v] of ring) {
    const du = lineSide(a,b,u), dv = lineSide(a,b,v)
    if (Math.abs(du) < EPS && Math.abs(dv) < EPS) return null
    if (Math.abs(du) < EPS) cuts.add(key(u))
    if (du >= -EPS) halves[0].push(u)
    if (du <= EPS) halves[1].push(u)
    if (du * dv < 0 && Math.abs(du) >= EPS && Math.abs(dv) >= EPS) {
      const t = du/(du-dv), p: Point = [u[0] + (v[0]-u[0])*t,u[1] + (v[1]-u[1])*t]
      cuts.add(key(p))
      halves[0].push(p)
      halves[1].push(p)
    }
  }
  if (cuts.size !== 2 || halves.some(p => p.length < 3 || area(p) < 1)) return null
  return [clean(halves[0]),clean(halves[1])]
}

export type SharedWall = { a: Point; b: Point; rooms: [string, string]; adjusted?: Point[] }

export function sharedWallAt(rooms: PlanRoom[], p: Point, tolerance: number, preferred?: string): SharedWall | null {
  let closest = Infinity, result: SharedWall | null = null
  const maxGap = .25
  const candidates = rooms.flatMap(room => edges(room.polygon).flatMap(([a,b]) =>
    distance(p,projection(p,a,b)) <= tolerance + maxGap ? [{room,a,b}] : []))
  for (const [i,first] of candidates.entries()) for (const second of candidates.slice(i + 1)) {
    if (first.room.id === second.room.id || preferred && preferred !== first.room.id && preferred !== second.room.id) continue
    const {a,b} = first, length = distance(a,b)
    const otherLength = distance(second.a,second.b)
    if (length <= EPS || otherLength <= EPS) continue
    const dx = (b[0]-a[0])/length, dy = (b[1]-a[1])/length
    const facing = (dx*(second.b[0]-second.a[0]) + dy*(second.b[1]-second.a[1])) / otherLength
      * Math.sign(signedArea(first.room.polygon) * signedArea(second.room.polygon))
    if (facing > -.98) continue
    const offsets = [second.a,second.b].map(q => lineSide(a,b,q)/length)
    const gap = Math.max(...offsets.map(Math.abs))
    if (gap > maxGap) continue
    const [u,v] = [second.a,second.b].map(q => projection(q,a,b))
    if (distance(u,v) < .15) continue
    const d = distance(p,projection(p,u,v)), score = d + gap / 2
    if (d > tolerance || score >= closest) continue
    const adjusted = gap > EPS ? second.room.polygon.map(q => {
      if (q !== second.a && q !== second.b) return q
      const offset = lineSide(a,b,q) / length
      return [q[0] + dy*offset, q[1] - dx*offset] as Point
    }) : undefined
    closest = score
    result = {a:u,b:v,rooms:[first.room.id,second.room.id],adjusted}
  }
  return result
}

export function mergePolygons(first: Point[], second: Point[]): Point[] | null {
  const oriented = [first, second].map(poly => signedArea(poly) > 0 ? poly : [...poly].reverse())
  const points = [...first,...second]
  const boundary = new Map<string,[Point,Point]>()
  let joined = false
  for (const ring of oriented) for (const [a,b] of edges(ring)) {
    const onLine = points.filter(p => distance(p,projection(p,a,b)) < EPS)
    const segments = [...new Map(onLine.map(p => [key(p),p])).values()].sort((u,v) => distance(a,u)-distance(a,v))
    for (let i = 1; i < segments.length; i++) {
      const u = segments[i-1], v = segments[i], forward = key(u)+'|'+key(v), reverse = key(v)+'|'+key(u)
      if (boundary.delete(reverse)) joined = true
      else if (boundary.has(forward)) return null
      else boundary.set(forward,[u,v])
    }
  }
  if (!joined) return null
  const poly = traceBoundary(boundary)
  const sum = area(first)+area(second)
  return poly && Math.abs(area(poly)-sum) < Math.max(EPS,sum*EPS) ? poly : null
}

function traceBoundary(boundary: Map<string,[Point,Point]>): Point[] | null {
  if (boundary.size < 3) return null
  const next = new Map([...boundary.values()].map(([a,b]) => [key(a),b]))
  if (next.size !== boundary.size) return null
  const start = [...boundary.values()][0][0], poly = [start]
  for (let i = 0; i < boundary.size; i++) {
    const p = next.get(key(poly.at(-1)!))
    if (!p) return null
    if (key(p) === key(start)) {
      return poly.length === boundary.size ? poly : null
    }
    poly.push(p)
  }
  return null
}
