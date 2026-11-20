import { useEffect, useState, type ReactNode } from 'react'
import { distance, projection, type Door, type Plan, type PlanFloor, type Point } from '../floor-edit'
import { snapDoor } from './units'
import './ingest.css'

// 평면도 편집(BuildingEditor)의 문 도구. 규약: docs/human/reference/plan-ingest.md 3-4
// - 모든 도구에서 문 기호(경첩에서 문짝 선, 열리는 쪽 1/4 호)를 표시하고 확인 필요(review) 문을 강조
// - 문 도구: 벽 가까이를 누르면 폭 0.9m 문 추가, 문을 누르면 선택, 끌면 가장 가까운 호실 변으로 이동(폭, 방향 유지)
// - 선택한 문: 경첩 뒤집기, 열림 방향 뒤집기, 확인 완료, 삭제(Delete 키 포함)
// - 모든 변경은 BuildingEditor의 commit(실행 취소 기록)으로 반영
const SOURCE: Record<string, string> = { ifc: 'IFC 객체', cad: 'CAD 블록', yolo: '도면 인식', manual: '직접 추가' }
const width = (d: Door) => distance(d.a, d.b)
const mid = (d: Door): Point => [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2]
const gap = (p: Point, d: Door) => distance(p, projection(p, d.a, d.b))

// 문 기호 경로: 경첩 h, 반대 끝 e, 문짝 끝 leaf(열리는 쪽 = a→b 기준 화면 왼쪽 side 1). 호는 화면(y 아래) 기준 e→leaf가 시계 방향이면 sweep 1
function doorShape(d: Door) {
  const w = width(d) || 1, [h, e] = d.hinge === 'b' ? [d.b, d.a] : [d.a, d.b]
  const ux = (d.b[0] - d.a[0]) / w, uy = (d.b[1] - d.a[1]) / w, s = d.side === -1 ? -1 : 1
  const leaf: Point = [h[0] + uy * s * w, h[1] - ux * s * w]
  const sweep = (e[0] - h[0]) * (leaf[1] - h[1]) - (e[1] - h[1]) * (leaf[0] - h[0]) > 0 ? 1 : 0
  return { path: `M${h.join(' ')}L${leaf.join(' ')}M${e.join(' ')}A${w} ${w} 0 0 ${sweep} ${leaf.join(' ')}`,
    box: [h, e, [e[0] + leaf[0] - h[0], e[1] + leaf[1] - h[1]], leaf].map(p => p.join(',')).join(' ') }
}

type Args = {
  model: Plan; commit(next: Plan): void; level: string; current: PlanFloor; tool: string; tolerance: number
  say(message: string): void; onFloor(id: string): void; onTool(tool: 'door'): void
}

export function useDoorTool({ model, commit, level, current, tool, tolerance, say, onFloor, onTool }: Args) {
  const [sel, setSel] = useState('')
  const [drag, setDrag] = useState<{ id: string; from: Point; pos: Point } | null>(null)
  const doors = current.doors ?? []
  const door = doors.find(d => d.id === sel)
  const setDoors = (next: Door[]) => commit({ ...model, floors: model.floors.map(f => (f.id === level ? { ...f, doors: next } : f)) })
  const patch = (id: string, change: Partial<Door>) => setDoors(doors.map(d => (d.id === id ? { ...d, ...change } : d)))
  const remove = (id: string) => { setDoors(doors.filter(d => d.id !== id)); setSel(''); say('문을 삭제했습니다.') }
  const reset = () => { setSel(''); setDrag(null) }
  // 끌기: 문 중심을 끈 만큼 옮긴 점에서 가장 가까운 호실 변에 맞춤
  const moved = (d: Door, from: Point, to: Point) => {
    const c = mid(d)
    return snapDoor(current.rooms, [c[0] + to[0] - from[0], c[1] + to[1] - from[1]], width(d), tolerance, [d.b[0] - d.a[0], d.b[1] - d.a[1]])
  }

  // Delete, Backspace: 선택한 문 삭제(입력칸에서는 무시)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!sel || tool !== 'door' || (e.key !== 'Delete' && e.key !== 'Backspace') || (e.target as HTMLElement).closest('input, select, textarea')) return
      e.preventDefault()
      remove(sel)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  function down(p: Point) {
    // 문 기호(문짝과 호)가 벽에서 문 폭만큼 나오므로 문 폭 거리까지 선택
    const hit = doors.filter(d => gap(p, d) <= Math.max(tolerance, width(d))).sort((x, y) => gap(p, x) - gap(p, y))[0]
    if (hit) { setSel(hit.id); setDrag({ id: hit.id, from: p, pos: p }); return }
    const seg = snapDoor(current.rooms, p, .9, tolerance)
    if (!seg) { if (sel) setSel(''); else say('문을 추가할 벽 가까이를 누르십시오.'); return }
    const id = 'DOOR-edit-' + crypto.randomUUID()
    setDoors([...doors, { id, ...seg, hinge: 'a', side: 1, source: 'manual' }])
    setSel(id)
    say('문을 추가했습니다. 경첩과 열림 방향을 확인하십시오.')
  }
  const move = (p: Point) => { if (drag) setDrag({ ...drag, pos: p }) }
  function up() {
    if (!drag) return
    setDrag(null)
    const d = doors.find(x => x.id === drag.id)
    if (!d || distance(drag.from, drag.pos) < tolerance * .2) return
    const seg = moved(d, drag.from, drag.pos)
    if (!seg) { say('문은 벽 가까이로 옮기십시오.'); return }
    patch(d.id, seg)
    say('문을 옮겼습니다.')
  }

  const marks: ReactNode = <g>
    {doors.map(d => {
      const s = drag?.id === d.id ? { ...d, ...moved(d, drag.from, drag.pos) } : d, { path, box } = doorShape(s)
      return <g key={d.id} className="door-mark">
        <title>문 폭 {width(s).toFixed(2)} m</title>
        {d.review && <polygon className="sym-review" points={box} />}
        {d.id === sel && <polygon className="sym-selected" points={box} />}
        <line className="door-gap" x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]} />
        <path d={path} />
      </g>
    })}
  </g>

  const review = model.floors.flatMap(f => (f.doors ?? []).filter(d => d.review).map(d => ({ f: f.id, d })))
  const jump = (f: string, id: string) => { onFloor(f); onTool('door'); setSel(id) }
  const card = tool === 'door' && door && <section className="unit-card" aria-label="선택한 문">
    <h3>문</h3>
    <dl>
      <dt>폭</dt><dd>{width(door).toFixed(2)} m</dd>
      <dt>출처</dt><dd>{SOURCE[door.source] ?? door.source}{door.conf != null ? `, 신뢰도 ${Math.round(door.conf * 100)}%` : ''}</dd>
    </dl>
    {door.review && <p className="unit-review-note">확인 필요: {width(door) < .6 || width(door) > 2 ? '폭이 0.6~2.0 m 범위 밖입니다.' : '벽 위치와 열림 방향을 확인하십시오.'}</p>}
    <div className="unit-actions door-actions">
      <button type="button" className="pill" onClick={() => patch(door.id, { hinge: door.hinge === 'a' ? 'b' : 'a' })}>경첩 뒤집기</button>
      <button type="button" className="pill" onClick={() => patch(door.id, { side: door.side === -1 ? 1 : -1 })}>열림 방향 뒤집기</button>
      {door.review && <button type="button" className="pill" onClick={() => patch(door.id, { review: false })}>확인 완료</button>}
      <button type="button" className="pill unit-delete" onClick={() => remove(door.id)}>삭제</button>
    </div>
  </section>
  const panel: ReactNode = (card || review.length > 0) && <div className="unit-panel">
    {card}
    {review.length > 0 && <section className="unit-review" aria-label="문 확인 필요">
      <h3>문 확인 필요 {review.length}개</h3>
      <ul>
        {review.map(({ f, d }) => <li key={d.id}><button type="button" className="pill" onClick={() => jump(f, d.id)}>{f} 문 폭 {width(d).toFixed(2)} m</button></li>)}
      </ul>
    </section>}
  </div>

  return { down, move, up, reset, marks, panel }
}
