import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { alignWallPoint, area, contains, distance, edges, floorBoundary, inRoom, interiorWallAt, intersectWallAxis, mergePolygons, moveInteriorWall, nearestSegment, overlapsWall, partitionTarget, projection, segmentInsideRoom, segmentWithout, sharedWallAt, solidWallSpans, splitPolygon, type Opening, type Plan, type PlanFloor, type PlanRoom, type Point, type Segment, type Wall, type WallAxis } from './floor-edit'
import './building-editor.css'
import { UnitLegend } from './ingest/UnitSymbol'
import { useUnitTool } from './ingest/UnitTool'

type Tool = 'select' | 'wall' | 'erase' | 'move' | 'cut' | 'partition' | 'unit' | 'align'
const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: '방 선택', hint: '평면도에서 방을 클릭하면 이름을 수정할 수 있습니다.' },
  { id: 'wall', label: '벽 설치', hint: '벽에서 시작해 끝점을 찍으세요. 반대쪽 벽에 닿으면 방을 나눕니다. 점선이 뜨면 수직·수평으로 맞춰집니다.' },
  { id: 'erase', label: '벽 삭제', hint: '내부 벽을 클릭해 전체를 지웁니다. 방과 복도 사이에는 열린 통로를 만듭니다.' },
  { id: 'move', label: '벽 이동', hint: '벽을 선택한 뒤 새 위치를 클릭하세요. 파란 선은 이동할 위치입니다.' },
  { id: 'cut', label: '부분 삭제', hint: '같은 벽의 시작점과 끝점을 찍어 그 구간만 엽니다.' },
  { id: 'partition', label: '부분 생성', hint: '두 점으로 칸막이를 만듭니다. 점선이 뜨면 수직·수평으로 맞춰지고, 열린 벽선 위를 찍으면 벽을 복원합니다.' },
  { id: 'unit', label: '실내기', hint: '추가할 유형을 고른 뒤 방 안을 누르십시오. 실내기를 누르면 선택되고, 끌어서 옮길 수 있습니다.' },
  { id: 'align', label: '위치 맞춤', hint: '도면 이미지의 기준점 2개를 누른 뒤, 평면도에서 같은 위치 2개를 누르십시오.' },
]
const pathOf = (room: PlanRoom) => [room.polygon, ...(room.holes ?? [])].map(loop => 'M' + loop.map(p => p.join(',')).join('L') + 'Z').join(' ')
const wallPathOf = (room: PlanRoom, openings: Opening[]) => [room.polygon, ...(room.holes ?? [])]
  .flatMap(edges).flatMap(([a,b]) => solidWallSpans(a,b,room.id,openings))
  .map(([a,b]) => `M${a.join(',')}L${b.join(',')}`).join(' ')

// draft: 도면 변환 초안(수정 없이도 저장 가능), backgrounds: 층 id → 도면 이미지 주소(floors[].background 표시용)
export default function BuildingEditor({ initial, floor, onSave, onCancel, draft, backgrounds }: { initial: Plan; floor: string; onSave(plan: Plan, level: string): void; onCancel(): void; draft?: boolean; backgrounds?: Record<string, string> }) {
  const [model, setModel] = useState(initial)
  const [history, setHistory] = useState<Plan[]>([])
  const [level, setLevel] = useState(initial.floors.some(f => f.id === floor) ? floor : initial.floors[0].id)
  const [tool, setTool] = useState<Tool>('select')
  const [selected, setSelected] = useState('')
  const [start, setStart] = useState<{ room: string; point: Point } | null>(null)
  const [wallStart, setWallStart] = useState<{ point: Point; wall?: Wall; opening?: Opening; partition?: Segment } | null>(null)
  const [cursor, setCursor] = useState<Point | null>(null)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const svg = useRef<SVGSVGElement>(null)
  const current = model.floors.find(f => f.id === level)!
  const { w, d } = model.building.size
  const room = current.rooms.find(r => r.id === selected)
  const scale = Math.max(w,d)
  const wallTolerance = Math.max(.3,scale*.013)
  const snapDistance = Math.min(.15,wallTolerance*.2)
  const anchorDistance = Math.min(.35,wallTolerance*.55)
  const alignmentTolerance = Math.min(.8,wallTolerance)
  const {outer,voids} = floorBoundary(model,current)
  const openings = current.openWalls ?? []
  const partitions = current.partitions ?? []
  const units = model.idus.filter(unit => current.rooms.some(r => r.id === unit.room))
  const wallAt = (p: Point) => interiorWallAt(current,p,wallTolerance,outer,voids,selected,tool === 'cut' || tool === 'erase')
  const findRoom = (p: Point) => current.rooms.find(r => r.type === 'room' && inRoom(p,r)) ?? current.rooms.find(r => inRoom(p,r))
  const nearest = (p: Point, r?: PlanRoom, tolerance = wallTolerance, axis?: WallAxis) => {
    let hit: { room: PlanRoom; point: Point } | null = null
    let best = tolerance
    for (const candidate of r ? [r] : current.rooms) for (const [a,b] of edges(candidate.polygon)) {
      const point = axis ? intersectWallAxis(p,a,b,axis) : projection(p,a,b)
      if (!point) continue
      const dist = distance(p,point)
      if (dist < best) { best = dist; hit = { room:candidate,point } }
    }
    return hit
  }
  const choose = (r?: PlanRoom) => {
    setSelected(r?.id ?? '')
    setName(r?.name ?? '')
  }
  const unitTool = useUnitTool({ model, commit, level, current, tool, scale, backgrounds, say: setMessage,
    onFloor: id => { setLevel(id); choose(); resetCursor() }, onTool: setTool })
  const resetCursor = () => { setStart(null); setWallStart(null); setCursor(null); setMessage(''); unitTool.reset() }

  useEffect(() => {
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') { setStart(null); setWallStart(null) } }
    window.addEventListener('keydown',esc)
    return () => window.removeEventListener('keydown',esc)
  }, [])

  function commit(next: Plan) {
    setHistory(previous => [...previous.slice(-29), model])
    setModel(next)
  }

  function apply(next: PlanRoom[], assignment?: (id: string, p: Point) => string, details?: Partial<PlanFloor>) {
    commit({
      ...model,
      floors:model.floors.map(f => f.id === level ? { ...f, ...details, rooms:next } : f),
      idus:assignment ? model.idus.map(unit => ({ ...unit, room:assignment(unit.room,unit.pos) })) : model.idus,
      aps:assignment ? model.aps?.map(ap => ap.room ? { ...ap, room:assignment(ap.room,ap.pos) } : ap) : model.aps,
    })
  }

  function openWall(wall: Wall, a = wall.a, b = wall.b) {
    const rooms = current.rooms.filter(r => r.id === wall.room || [r.polygon,...(r.holes ?? [])]
      .some(ring => edges(ring).some(([u,v]) => overlapsWall({ a,b },u,v,.25)))).map(r => r.id)
    const existing = openings.flatMap(item => overlapsWall(item,a,b) ? segmentWithout(item,a,b) : [item])
    apply(current.rooms, undefined, { openWalls: [...existing,{a,b,rooms}] })
    setCursor(null)
  }

  function aimPartition(start: { point: Point; opening?: Opening }, target: Point) {
    const placement = partitionTarget(start.point,target,start.opening,snapDistance)
    const alignment = alignWallPoint(start.point,placement.point,alignmentTolerance)
    const axis = alignment.axis && (placement.restores
      ? distance(placement.point,alignment.point) < .00001
      : canPlacePartition(start.point,alignment.point)) ? alignment.axis : undefined
    return { ...placement, point:axis ? alignment.point : placement.point, axis }
  }

  const canPlacePartition = (a: Point, b: Point) => current.rooms.some(r => segmentInsideRoom(a,b,r))

  function addPartition(a: Point, b: Point) {
    if (!canPlacePartition(a,b)) {
      setMessage('끝점은 칸막이가 한 공간 안에 들어가도록 찍으세요.')
      return false
    }
    apply(current.rooms, undefined, { partitions:[...partitions,{a,b}] })
    return true
  }

  function aimWall(origin: { room: string; point: Point }, target: Point): { point: Point; splitRoom?: PlanRoom; axis?: WallAxis } {
    const original = current.rooms.find(r => r.id === origin.room)!
    function endAt(point: Point, axis?: WallAxis) {
      const nearby = nearest(point,original,snapDistance,axis)
      if (nearby && segmentInsideRoom(origin.point,nearby.point,original)) return { point:nearby.point, splitRoom:original, axis }
      if (canPlacePartition(origin.point,point)) return { point, splitRoom:undefined, axis }
      const boundary = nearest(point,original,wallTolerance,axis)
      if (boundary && segmentInsideRoom(origin.point,boundary.point,original)) return { point:boundary.point, splitRoom:original, axis }
      return null
    }
    const alignment = alignWallPoint(origin.point,target,alignmentTolerance)
    return (alignment.axis && endAt(alignment.point,alignment.axis)) || endAt(target) || { point:target }
  }

  function editWall(p: Point) {
    const part = nearestSegment(partitions,p,wallTolerance)
    const hit = wallAt(p)
    if (tool === 'move') {
      if (!wallStart) {
        if (hit && !hit.hole) setWallStart({point:p,wall:hit})
        else setMessage('이동할 방 또는 복도의 내부 경계를 선택하세요.')
        return
      }
      const wall = wallStart.wall!
      const result = moveInteriorWall(current,wall,p,outer,voids)
      if (!result) { setMessage('이 위치로 벽을 옮기면 공간이 끊어지거나 외곽 또는 다른 공간과 겹칩니다. 가까운 위치를 선택하세요.'); return }
      const existing = units.filter(unit => current.rooms.some(r => r.id === unit.room && inRoom(unit.pos,r)))
      if (existing.some(unit => !result.rooms.some(r => inRoom(unit.pos,r)))) {
        setMessage('벽을 옮기면 에어컨이 공간 밖에 남습니다. 에어컨 위치를 먼저 조정하세요.')
        return
      }
      if (partitions.some(({a,b}) => !result.rooms.some(r => segmentInsideRoom(a,b,r)))) {
        setMessage('벽을 옮기면 칸막이가 공간 경계를 가로지릅니다. 칸막이를 먼저 조정하세요.')
        return
      }
      apply(result.rooms,(id,point) => {
        const previous = result.rooms.find(r => r.id === id)
        return previous && !inRoom(point,previous) ? result.rooms.find(r => inRoom(point,r))?.id ?? id : id
      }, { openWalls: openings.flatMap(item => item.rooms.includes(wall.room) && overlapsWall(item,wall.a,wall.b)
        ? segmentWithout(item,wall.a,wall.b) : [item]) })
      setWallStart(null)
      setMessage(`벽을 ${result.meters.toFixed(2)} m 옮겼습니다.`)
      return
    }
    if (tool === 'partition') {
      if (!wallStart) {
        const opening = nearestSegment(openings,p,wallTolerance)
        const boundary = nearest(p,undefined,anchorDistance)
        const partition = nearestSegment(partitions,p,boundary ? distance(p,boundary.point) : anchorDistance)
        const anchor = opening ?? partition
        setWallStart({ opening,point:anchor ? projection(p,anchor.a,anchor.b) : boundary?.point ?? p })
        return
      }
      const a = wallStart.point
      const { point:b,restores } = aimPartition(wallStart,p)
      if (distance(a,b) < .15) { setMessage('끝점을 조금 더 멀리 찍으세요.'); return }
      if (restores) apply(current.rooms, undefined, { openWalls:openings.flatMap(item => overlapsWall(item,a,b) ? segmentWithout(item,a,b) : [item]) })
      else if (!addPartition(a,b)) return
      setWallStart(null)
      setCursor(null)
      setMessage('선택한 구간에 벽을 설치했습니다.')
      return
    }
    if (tool === 'cut') {
      if (!wallStart) {
        const segment = part ?? hit
        if (segment) setWallStart({ point:projection(p,segment.a,segment.b), wall:part ? undefined : hit!, partition:part })
        else setMessage('내부 벽에서 부분 삭제를 시작할 위치를 찍으세요.')
        return
      }
      const segment = (wallStart.partition ?? wallStart.wall)!
      const a = wallStart.point, b = projection(p,segment.a,segment.b)
      if (distance(p,b) > wallTolerance || distance(a,b) < .15) { setMessage('같은 벽에서 끝점을 조금 더 멀리 찍으세요.'); return }
      if (wallStart.partition) apply(current.rooms,undefined,{partitions:partitions.flatMap(item => item === segment ? segmentWithout(item,a,b) : [item])})
      else openWall(wallStart.wall!,a,b)
      setWallStart(null)
      setCursor(null)
      setMessage('벽의 선택한 구간을 삭제했습니다.')
      return
    }
    if (part) {
      apply(current.rooms,undefined,{ partitions:partitions.filter(item => item !== part) })
      setCursor(null)
      setMessage('칸막이를 삭제했습니다.')
      return
    }
    if (!hit) { setMessage('편집할 내부 벽을 선택하세요. 외벽은 편집할 수 없습니다.'); return }
    const shared = sharedWallAt(current.rooms,p,wallTolerance,hit.room)
    if (shared && Math.abs(distance(shared.a,shared.b)-distance(hit.a,hit.b)) < .02) {
      const rooms = shared.rooms.map((id,i) => {
        const r = current.rooms.find(item => item.id === id)!
        return i === 1 && shared.adjusted ? { ...r,polygon:shared.adjusted } : r
      })
      const [keep,drop] = rooms[0].id === hit.room ? rooms : [...rooms].reverse()
      const polygon = keep.type === 'room' && drop.type === 'room' ? mergePolygons(keep.polygon,drop.polygon) : null
      if (polygon) {
        const merged = { ...keep, polygon, holes:[...(keep.holes ?? []),...(drop.holes ?? [])], capacity:(keep.capacity ?? 0)+(drop.capacity ?? 0), zoneOf:undefined, zoneBasis:undefined }
        const openWalls = openings.map(item => ({ ...item,rooms:[...new Set(item.rooms.map(id => id === drop.id ? keep.id : id))] }))
        apply(current.rooms.filter(r => r.id !== drop.id).map(r => r.id === keep.id ? merged : r), id => id === drop.id ? keep.id : id, { openWalls })
        choose(merged)
        setMessage('벽을 지우고 두 방을 합쳤습니다.')
        return
      }
    }
    openWall(hit)
    setMessage('내부 벽을 지우고 열린 구간을 만들었습니다.')
  }

  function pointAt(event: PointerEvent<SVGSVGElement>): Point | null {
    const m = svg.current?.getScreenCTM()
    if (!m) return null
    const mouse = new DOMPoint(event.clientX,event.clientY).matrixTransform(m.inverse())
    return [mouse.x,mouse.y]
  }

  function click(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return
    const p = pointAt(event)
    if (!p) return
    setMessage('')
    if (tool === 'select') { choose(findRoom(p)); return }
    if (tool === 'unit' || tool === 'align') { event.currentTarget.setPointerCapture(event.pointerId); unitTool.down(p); return }
    if (tool !== 'wall') { editWall(p); return }
    if (!start) {
      const boundary = (room && nearest(p,room)) || nearest(p)
      const partition = nearestSegment(partitions,p,Math.min(anchorDistance,boundary ? distance(p,boundary.point) : Infinity))
      const point = partition && projection(p,partition.a,partition.b)
      const anchorRoom = point && findRoom(point)
      const hit = point && anchorRoom ? { room:anchorRoom,point } : boundary
      if (!hit) { setMessage('벽의 시작점을 공간 경계에 놓으세요.'); return }
      setStart({ room:hit.room.id,point:hit.point })
      choose(hit.room)
      return
    }
    const { point:end, splitRoom } = aimWall(start,p)
    if (distance(start.point,end) < .15) { setMessage('끝점을 조금 더 멀리 찍으세요.'); return }
    const cut = splitRoom && splitPolygon(splitRoom.polygon,start.point,end)
    if (!cut || !splitRoom) {
      if (!addPartition(start.point,end)) return
      setStart(null)
      setCursor(null)
      setMessage('선택한 지점까지 칸막이를 설치했습니다.')
      return
    }
    const [a,b] = cut
    const holes = splitRoom.holes ?? []
    if (holes.some(h => ![a,b].some(side => h.every(q => contains(q,side))))) {
      setMessage('벽이 공간 내부의 빈 구역을 가로지릅니다.')
      return
    }
    const capacity = splitRoom.capacity
    const leftCapacity = capacity == null ? undefined : Math.round(capacity * area(a) / (area(a)+area(b)))
    const keep = { ...splitRoom, polygon:a, holes:holes.filter(h => contains(h[0],a)), capacity:leftCapacity, zoneOf:undefined, zoneBasis:undefined }
    const added = { ...keep, id:level+'-edit-'+crypto.randomUUID(), name:splitRoom.name+' 분리 공간', number:undefined, type:'room',
      polygon:b, holes:holes.filter(h => contains(h[0],b)), capacity:capacity == null ? undefined : capacity-(leftCapacity ?? 0) }
    const openWalls = openings.map(item => item.rooms.includes(keep.id) ? { ...item, rooms:[...item.rooms,added.id] } : item)
    apply(current.rooms.flatMap(r => r.id === keep.id ? [keep,added] : [r]), (id,p) => id === keep.id && contains(p,b) ? added.id : id, { openWalls })
    setStart(null)
    choose(added)
    setMessage('벽을 설치했습니다. 새 공간의 이름을 정할 수 있습니다.')
  }

  const wallPreview = start && cursor ? aimWall(start,cursor) : null
  const preview = wallPreview?.point
  const partitionPreview = tool === 'partition' && wallStart && cursor ? aimPartition(wallStart,cursor) : null
  const aligned = wallPreview?.axis ? wallPreview : partitionPreview?.axis ? partitionPreview : null
  const wallGuide = (() => {
    if (!cursor) return null
    if (!wallStart) {
      if (tool === 'partition') return nearestSegment(openings,cursor,wallTolerance)
      if (tool === 'cut' || tool === 'erase') return nearestSegment(partitions,cursor,wallTolerance) ?? wallAt(cursor)
      return tool === 'move' ? wallAt(cursor) : null
    }
    if (tool === 'move' && wallStart.wall) {
      const {a,b} = wallStart.wall
      const p = projection(cursor,a,b), length = distance(a,b)
      const nx = (a[1]-b[1])/length, ny = (b[0]-a[0])/length
      const shift = (cursor[0]-p[0])*nx + (cursor[1]-p[1])*ny
      return {a:[a[0]+nx*shift,a[1]+ny*shift],b:[b[0]+nx*shift,b[1]+ny*shift]} as Segment
    }
    if (partitionPreview) return {a:wallStart.point,b:partitionPreview.point}
    const base = wallStart.partition ?? wallStart.wall
    return {a:wallStart.point,b:base ? projection(cursor,base.a,base.b) : cursor}
  })()
  const pendingName = room && name.trim() && name.trim() !== room.name
  const renamedRooms = () => current.rooms.map(r => r.id === room?.id ? { ...r, name: name.trim() } : r)
  function goBack() {
    if ((!draft && !history.length && !pendingName) || window.confirm('저장하지 않은 수정 내용을 버릴까요?')) onCancel()
  }

  return (
    <section className="card building-edit" aria-label="평면도 편집">
      <header>
        <h2>평면도 편집</h2>
        <div className="edit-actions">
          <button className="pill" onClick={() => {
            if (!history.length) return
            setModel(history.at(-1)!)
            setHistory(history.slice(0,-1))
            choose()
            resetCursor()
          }} disabled={!history.length}>실행 취소</button>
          <button className="pill" onClick={goBack}>나가기</button>
          <button className="primary" disabled={!draft && !history.length && !pendingName} onClick={() => {
            const result = pendingName ? { ...model, floors: model.floors.map(f => f.id === level ? { ...f, rooms: renamedRooms() } : f) } : model
            onSave(result, level)
          }}>저장</button>
        </div>
      </header>
      <div className="edit-layout">
        <nav aria-label="편집할 층">
          {[...model.floors].reverse().map(f => (
            <button key={f.id} className={level === f.id ? 'pill on' : 'pill'} aria-pressed={level === f.id}
              onClick={() => { setLevel(f.id); choose(); resetCursor() }}>{f.id}</button>
          ))}
        </nav>
        <div className="edit-work">
          <div className="edit-actions" role="group" aria-label="편집 도구">
            {TOOLS.map(t => <button className={tool === t.id ? 'pill on' : 'pill'} key={t.id} aria-pressed={tool === t.id}
              onClick={() => { setTool(t.id); resetCursor() }}>{t.label}</button>)}
            {!current.rooms.length && current.footprint && <button className="pill" onClick={() => {
              const spaces = outer.map((polygon, index) => ({
                id: level+'-edit-'+crypto.randomUUID(), name: outer.length === 1 ? '새 공간' : '새 공간 ' + (index + 1), polygon, type: 'room',
              }))
              apply(spaces)
              choose(spaces[0])
              setTool('select')
            }}>층 외곽을 편집 공간으로 만들기</button>}
          </div>
          <p className="muted">{TOOLS.find(t => t.id === tool)?.hint}</p>
          {unitTool.panel}
          <svg ref={svg} aria-label={level+' 평면도'} className={'edit-plan '+tool} viewBox={[-1,-1,w+2,d+2].join(' ')}
            onPointerDown={click} onPointerMove={e => { const p = pointAt(e); setCursor(p); if (p) unitTool.move(p) }} onPointerUp={unitTool.up} onPointerLeave={() => setCursor(null)}>
            {outer.map((polygon, i) => <polygon key={i} points={polygon.map(p => p.join(',')).join(' ')} className="edit-outline" />)}
            {current.rooms.map(r => {
              const [x,y] = r.polygon.reduce<Point>((p,q) => [p[0]+q[0]/r.polygon.length,p[1]+q[1]/r.polygon.length],[0,0])
              return <g key={r.id}>
                <path d={pathOf(r)} fillRule="evenodd" className="edit-room" />
                <text x={x} y={y} fontSize={scale*.013} textAnchor="middle" dominantBaseline="middle">{r.name}</text>
              </g>
            })}
            {unitTool.layer}
            {current.rooms.map(r => <path key={r.id} d={wallPathOf(r,openings)} className={r.id === selected ? 'edit-wall selected' : 'edit-wall'} />)}
            {start && <circle className="edit-anchor" cx={start.point[0]} cy={start.point[1]} r={scale*.007} />}
            {start && preview && <line className="edit-preview" x1={start.point[0]} y1={start.point[1]} x2={preview[0]} y2={preview[1]} />}
            {partitions.map(({a,b},i) => <line key={i} className="edit-partition" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />)}
            {unitTool.marks}
            {aligned?.axis === 'vertical' && <line className="edit-alignment-guide" x1={aligned.point[0]} x2={aligned.point[0]} y1={0} y2={d} />}
            {aligned?.axis === 'horizontal' && <line className="edit-alignment-guide" x1={0} x2={w} y1={aligned.point[1]} y2={aligned.point[1]} />}
            {wallStart && <circle className="edit-anchor" cx={wallStart.point[0]} cy={wallStart.point[1]} r={scale*.007} />}
            {wallGuide && <line className={'edit-preview '+(tool === 'erase' || tool === 'cut' ? 'erase' : '')} x1={wallGuide.a[0]} y1={wallGuide.a[1]} x2={wallGuide.b[0]} y2={wallGuide.b[1]} />}
          </svg>
          <div className="edit-foot">
            {room && <form onSubmit={event => {
              event.preventDefault()
              if (!pendingName) return
              apply(renamedRooms())
              setMessage('방 이름을 변경했습니다.')
            }}>
              <label>방 이름 <input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
              <button className="pill" disabled={!pendingName}>이름 적용</button>
            </form>}
            <p role="status" className="muted">{message}</p>
            <UnitLegend />
          </div>
        </div>
      </div>
    </section>
  )
}
