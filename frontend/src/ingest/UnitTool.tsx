import { useEffect, useState, type ReactNode } from 'react'
import { distance, inRoom, type Affine, type IndoorUnit, type Plan, type PlanFloor, type Point } from '../floor-edit'
import { clsOf, connectOdus, detectionsToDoors, detectionsToUnits, fromPlan, oduFloor, similarity, snapDoor, toPlan, TYPES, typeFields } from './units'
import { UnitIcon, UnitSymbol } from './UnitSymbol'
import './ingest.css'

// 평면도 편집(BuildingEditor)의 실내기 도구와 도면 위치 맞춤 도구
// - 실내기: 유형 6종 추가, 선택 후 끌어서 이동, 삭제, 유형 변경, 방향 회전, 확인 필요(review) 목록
// - 실외기: 층별 기호(평면 좌우 여백), 실내기 연결선, 끌어서 이동, 실내기를 고른 뒤 실외기를 눌러 연결 변경, 추가, 삭제
// - 빈 호실 추정: 실내기가 없는 실에 면적 추정 실내기(40㎡당 1대)를 넣고 실외기에 연결
// - 위치 맞춤: 도면 이미지 점 2개 → 평면 점 2개로 회전, 축척, 이동(toPlan)을 구하고 위치를 맞추지 않은 인식 결과를 실내기와 문(cls door)으로 변환
// - 모든 변경은 BuildingEditor의 commit(실행 취소 기록)으로 반영
const SOURCE: Record<string, string> = { ifc: 'IFC 객체', cad: 'CAD 블록', yolo: '도면 인식', manual: '직접 추가', estimate: '면적 추정', plan: '도면 표기', photo: '사진 대수', model: '위치 예측' }
const r2 = (v: number) => Math.round(v * 100) / 100
// 위치를 맞추지 않은 도면 이미지는 건물 크기에 맞춰 왼쪽 위에 임시 배치
const fit = ([w, h]: [number, number], size: { w: number; d: number }): Affine => { const s = Math.min(size.w / w, size.d / h); return [s, 0, 0, 0, s, 0] }

type Args = {
  model: Plan; commit(next: Plan): void; level: string; current: PlanFloor; tool: string; scale: number
  backgrounds?: Record<string, string>; say(message: string): void; onFloor(id: string): void; onTool(tool: 'unit' | 'align'): void
}

export function useUnitTool({ model, commit, level, current, tool, scale, backgrounds, say, onFloor, onTool }: Args) {
  const [sel, setSel] = useState('')
  const [addCls, setAddCls] = useState('')
  const [kw, setKw] = useState('7.2')
  const [drag, setDrag] = useState<{ id: string; from: Point; pos: Point } | null>(null)
  const [selOdu, setSelOdu] = useState('')
  const [oduDrag, setOduDrag] = useState<{ id: string; from: Point; pos: Point } | null>(null)
  const [pts, setPts] = useState<Point[]>([])
  const [opacity, setOpacity] = useState(.5)
  const bg = current.background
  const url = backgrounds?.[level]
  const view = bg && url ? bg.toPlan ?? fit(bg.px, model.building.size) : null
  const size = Math.max(.3, scale * .011)
  const units = model.idus.filter(u => current.rooms.some(r => r.id === u.room))
  const unit = model.idus.find(u => u.id === sel)
  const odus = (model.odus ?? []).filter(o => oduFloor(o) === level && o.mark)
  const odu = odus.find(o => o.id === selOdu)
  // 실내기를 둘 공간: 실 우선, 그다음 복도·홀(로비 등 실제로 실내기가 있는 공간)
  const roomAt = (p: Point) => current.rooms.find(r => r.type === 'room' && inRoom(p, r)) ?? current.rooms.find(r => r.type === 'corridor' && inRoom(p, r))
  const floorOf = (u: IndoorUnit) => model.floors.find(f => f.rooms.some(r => r.id === u.room))
  const patch = (id: string, change: Partial<IndoorUnit>) => commit({ ...model, idus: model.idus.map(u => (u.id === id ? { ...u, ...change } : u)) })
  const remove = (id: string) => { commit({ ...model, idus: model.idus.filter(u => u.id !== id) }); setSel(''); say('실내기를 삭제했습니다.') }
  const reset = () => { setSel(''); setDrag(null); setPts([]); setSelOdu(''); setOduDrag(null) }

  // 실외기 삭제: 연결된 실내기는 같은 층에서 가장 가까운 실외기로 옮김. 남는 실외기가 없으면 삭제하지 않음
  function removeOdu(id: string) {
    const rest = odus.filter(o => o.id !== id), linked = model.idus.filter(u => u.odu === id)
    if (linked.length && !rest.length) { say('연결된 실내기가 있어 이 층의 마지막 실외기는 삭제할 수 없습니다.'); return }
    const nearest = (u: IndoorUnit) => rest.reduce((b, o) => (distance(u.pos, o.mark!) < distance(u.pos, b.mark!) ? o : b)).id
    commit({ ...model, odus: (model.odus ?? []).filter(o => o.id !== id), idus: model.idus.map(u => (u.odu === id ? { ...u, odu: nearest(u) } : u)) })
    setSelOdu('')
    say(linked.length ? `실외기를 삭제하고 연결된 실내기 ${linked.length}대를 가까운 실외기로 옮겼습니다.` : '실외기를 삭제했습니다.')
  }
  function addOdu() {
    const n = Math.max(0, ...(model.odus ?? []).filter(o => oduFloor(o) === level).map(o => Number(o.id.split('-').at(-1)) || 0)) + 1
    const id = `ODU-${level}-${n}`
    commit(connectOdus({ ...model, odus: [...(model.odus ?? []), { id, model: 'LG MULTI V 실외기', location: '옥상', serves: level }] }))
    setSel(''); setSelOdu(id)
    say('실외기를 추가했습니다. 실내기를 고른 뒤 이 실외기를 누르면 연결됩니다.')
  }
  async function estimate() {
    const { autoUnits } = await import('./auto-units')
    const r = autoUnits(model, [level])
    if (!r.added) { say('이 층에는 실내기가 없는 호실이 없습니다.'); return }
    commit(r.plan)
    say(`실내기가 없는 호실에 추정 실내기 ${r.added}대를 넣었습니다. 확인 필요 목록에서 확인하십시오.`)
  }

  // Delete, Backspace: 선택한 실내기 삭제(입력칸에서는 무시)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((!sel && !selOdu) || (e.key !== 'Delete' && e.key !== 'Backspace') || (e.target as HTMLElement).closest('input, select, textarea')) return
      e.preventDefault()
      if (selOdu) { removeOdu(selOdu); return }
      commit({ ...model, idus: model.idus.filter(u => u.id !== sel) })
      setSel('')
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  function down(p: Point) {
    if (tool === 'align') { alignAt(p); return }
    // 실외기: 실내기를 고른 상태면 연결 변경, 아니면 선택 후 끌기
    const hitOdu = odus.find(o => distance(p, o.mark!) < size * 1.6)
    if (hitOdu) {
      if (unit && units.includes(unit)) { patch(unit.id, { odu: hitOdu.id }); say(`실내기를 ${hitOdu.id}에 연결했습니다.`); return }
      setSel(''); setSelOdu(hitOdu.id); setOduDrag({ id: hitOdu.id, from: hitOdu.mark!, pos: hitOdu.mark! }); return
    }
    setSelOdu('')
    const hit = units.reduce<IndoorUnit | undefined>((best, u) => (distance(p, u.pos) < (best ? distance(p, best.pos) : size * 1.4) ? u : best), undefined)
    if (hit) { setSel(hit.id); setDrag({ id: hit.id, from: hit.pos, pos: hit.pos }); return }
    if (!addCls) { setSel(''); return }
    const room = roomAt(p), coolKw = Number(kw)
    if (!room) { say('실내기를 설치할 방 안을 누르십시오.'); return }
    if (!Number.isFinite(coolKw) || coolKw < .5 || coolKw > 100) { say('냉방 용량을 0.5~100 kW로 입력하십시오.'); return }
    const id = 'IDU-edit-' + crypto.randomUUID()
    commit(connectOdus({ ...model, idus: [...model.idus, { id, room: room.id, pos: [r2(p[0]), r2(p[1])], ...typeFields(addCls), coolKw, ratedKw: Math.round(coolKw * 31) / 100, source: 'manual', basis: '평면도 편집에서 추가' }] }))
    setSel(id)
    say('실내기를 추가했습니다.')
  }
  const move = (p: Point) => { if (drag) setDrag({ ...drag, pos: p }); if (oduDrag) setOduDrag({ ...oduDrag, pos: p }) }
  function up() {
    if (oduDrag) {
      setOduDrag(null)
      if (distance(oduDrag.from, oduDrag.pos) < size * .3) return
      commit({ ...model, odus: (model.odus ?? []).map(o => (o.id === oduDrag.id ? { ...o, mark: [r2(oduDrag.pos[0]), r2(oduDrag.pos[1])] as Point } : o)) })
      say('실외기를 옮겼습니다.')
      return
    }
    if (!drag) return
    setDrag(null)
    if (distance(drag.from, drag.pos) < size * .3) return
    const room = roomAt(drag.pos)
    if (!room) { say('실내기는 방 안으로 옮기십시오.'); return }
    const u = model.idus.find(x => x.id === drag.id)
    patch(drag.id, { pos: [r2(drag.pos[0]), r2(drag.pos[1])], room: room.id, review: u?.cls === 'unknown' })
    say('실내기를 옮겼습니다.')
  }

  // 위치 맞춤: 앞의 2번은 도면 이미지 점(픽셀), 뒤의 2번은 평면 점(m)
  async function alignAt(p: Point) {
    if (!view || !bg) { say('이 층에는 맞출 도면 이미지가 없습니다.'); return }
    const next = [...pts, pts.length < 2 ? fromPlan(view, p) : p]
    if (next.length < 4) {
      setPts(next)
      say(next.length < 2 ? '도면 이미지에서 두 번째 기준점을 누르십시오.' : `평면도에서 기준점 ${next.length - 1}과 같은 위치를 누르십시오.`)
      return
    }
    setPts([])
    const m = similarity(next.slice(0, 2), next.slice(2))
    if (!m) { say('기준점 2개를 서로 떨어진 위치에 찍으십시오.'); return }
    // 이미 맞춘 층을 다시 맞추면 이 층의 인식 실내기, 인식 문도 같은 이미지 위치로 옮김(문은 가장 가까운 변에 다시 맞춤)
    const old = bg.toPlan
    const doors = (current.doors ?? []).map(d => {
      if (!old || d.source !== 'yolo') return d
      const [a, b] = [d.a, d.b].map(q => toPlan(m, fromPlan(old, q)).map(r2) as Point), w = distance(a, b)
      return { ...d, ...(snapDoor(current.rooms, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], w, w, [b[0] - a[0], b[1] - a[1]]) ?? { a, b, review: true }) }
    })
    const newDoors = detectionsToDoors(current, m)
    const floor: PlanFloor = { ...current, background: { ...bg, toPlan: m }, detections: [], doors: [...doors, ...newDoors] }
    const added = detectionsToUnits(current, m)
    const moved = model.idus.map(u => {
      if (!old || u.source !== 'yolo' || !current.rooms.some(r => r.id === u.room)) return u
      const pos = toPlan(m, fromPlan(old, u.pos)), room = roomAt(pos)
      return { ...u, pos: [r2(pos[0]), r2(pos[1])] as Point, room: room?.id ?? u.room, review: u.review || !room }
    })
    // 인식 결과가 없는 호실은 면적 추정 실내기로 채우고 실외기에 연결
    const { autoUnits } = await import('./auto-units')
    const r = autoUnits({ ...model, floors: model.floors.map(f => (f.id === level ? floor : f)), idus: [...moved, ...added] }, [level])
    commit(r.plan)
    say(`도면 위치를 맞췄습니다.${added.length ? ` 인식 결과 ${added.length}대를 실내기로 바꿨습니다.` : ''}${newDoors.length ? ` 인식한 문 ${newDoors.length}개를 넣었습니다.` : ''}${r.added ? ` 빈 호실에 추정 실내기 ${r.added}대를 넣었습니다.` : ''}`)
  }

  const review = model.idus.filter(u => u.review)
  const pending = model.floors.filter(f => f.detections?.length)
  const [bw, bh] = bg?.px ?? [0, 0]
  const layer: ReactNode = view && url && <image href={url} width={bw} height={bh} opacity={opacity} className="unit-bg" preserveAspectRatio="none"
    transform={`matrix(${view[0]} ${view[3]} ${view[1]} ${view[4]} ${view[2]} ${view[5]})`} />
  const at = (u: IndoorUnit) => (drag?.id === u.id ? drag.pos : u.pos)
  const markOf = (id?: string) => { const o = odus.find(x => x.id === id); return o && (oduDrag?.id === o.id ? oduDrag.pos : o.mark!) }
  const marks: ReactNode = <g>
    {units.map(u => {
      const m = markOf(u.odu)
      return m && <line key={'l' + u.id} className={u.odu === selOdu || u.id === sel ? 'odu-line on' : 'odu-line'} x1={at(u)[0]} y1={at(u)[1]} x2={m[0]} y2={m[1]} />
    })}
    {odus.map(o => {
      const [x, y] = markOf(o.id)!, tail = o.id.split('-').at(-1)
      return <g key={o.id} className={o.id === selOdu ? 'odu-mark on' : 'odu-mark'} transform={`translate(${x} ${y}) scale(${size})`}>
        <title>{o.id} {o.location ?? ''}</title>
        {o.id === selOdu && <rect className="sym-selected" x="-1.9" y="-1.6" width="3.8" height="3.2" rx=".3" />}
        <rect x="-1.5" y="-1.2" width="3" height="2.4" rx=".2" />
        <circle cx="-.5" r=".75" />
        <text x=".8" textAnchor="middle" dominantBaseline="central" fontSize="1.1">{tail === 'W' ? '서' : tail === 'E' ? '동' : tail}</text>
      </g>
    })}
    {units.map(u => {
      const [x, y] = drag?.id === u.id ? drag.pos : u.pos
      return <g key={u.id} className={u.id === sel ? 'unit-mark on' : 'unit-mark'} transform={`translate(${x} ${y}) rotate(${u.rot ?? 0}) scale(${size})`}>
        <title>{u.type ?? u.model ?? '실내기'}</title>
        {u.review && <rect className="sym-review" x="-1.35" y="-1.35" width="2.7" height="2.7" rx=".25" />}
        {u.id === sel && <rect className="sym-selected" x="-1.6" y="-1.6" width="3.2" height="3.2" rx=".3" />}
        <UnitSymbol cls={clsOf(u)} />
      </g>
    })}
    {tool === 'align' && view && pts.map((p, i) => {
      const [x, y] = i < 2 ? toPlan(view, p) : p
      return <g key={i} className={i < 2 ? 'align-pt image' : 'align-pt plan'} transform={`translate(${x} ${y}) scale(${size})`}>
        <circle r=".9" /><text textAnchor="middle" dominantBaseline="central" fontSize="1.1">{(i % 2) + 1}</text>
      </g>
    })}
  </g>

  const jump = (u: IndoorUnit) => { const f = floorOf(u); if (!f) return; onFloor(f.id); onTool('unit'); setSel(u.id) }
  const room = unit && model.floors.flatMap(f => f.rooms).find(r => r.id === unit.room)
  const panel: ReactNode = <div className="unit-panel">
    {tool === 'unit' && <>
      <fieldset className="unit-palette">
        <legend>추가할 유형</legend>
        {TYPES.map(t => <button type="button" key={t.class} className={addCls === t.class ? 'pill on' : 'pill'} aria-pressed={addCls === t.class}
          onClick={() => setAddCls(addCls === t.class ? '' : t.class)}><UnitIcon cls={t.class} />{t.name}</button>)}
      </fieldset>
      <div className="unit-actions">
        <button type="button" className="pill" onClick={estimate}>빈 호실 실내기 추정</button>
        <button type="button" className="pill" onClick={addOdu}>실외기 추가</button>
      </div>
      {odu && <section className="unit-card" aria-label="선택한 실외기">
        <h3>실외기 {odu.id}</h3>
        <dl>
          <dt>모델</dt><dd>{odu.model ?? '모델 정보 없음'}</dd>
          <dt>설치 위치</dt><dd>{odu.location ?? '미상'}</dd>
          <dt>연결 실내기</dt><dd>{model.idus.filter(u => u.odu === odu.id).length}대</dd>
        </dl>
        <p className="unit-step">실내기를 고른 뒤 이 실외기 기호를 누르면 연결이 바뀝니다.</p>
        <div className="unit-actions"><button type="button" className="pill unit-delete" onClick={() => removeOdu(odu.id)}>삭제</button></div>
      </section>}
      {addCls && <label className="edit-ac-capacity">냉방 용량 (kW) <input type="number" min=".5" max="100" step=".1" value={kw} onChange={e => setKw(e.target.value)} /></label>}
      {unit && <section className="unit-card" aria-label="선택한 실내기">
        <h3>{unit.type ?? unit.model ?? '실내기'}</h3>
        <dl>
          <dt>LG 모델</dt><dd>{unit.model ?? '모델 정보 없음'}</dd>
          <dt>매뉴얼</dt><dd>{unit.manual ? <a href={unit.manual} target="_blank" rel="noreferrer">매뉴얼 열기(PDF)</a> : '없음'}</dd>
          <dt>호실</dt><dd>{room?.name ?? unit.room}</dd>
          <dt>출처</dt><dd>{SOURCE[unit.source ?? ''] ?? unit.source ?? '미상'}{unit.conf != null ? `, 신뢰도 ${Math.round(unit.conf * 100)}%` : ''}</dd>
        </dl>
        <label className="unit-type">실외기 <select value={unit.odu ?? ''} onChange={e => patch(unit.id, { odu: e.target.value })}>
          {!odus.some(o => o.id === unit.odu) && <option value={unit.odu ?? ''}>{unit.odu ?? '연결 없음'}</option>}
          {odus.map(o => <option key={o.id} value={o.id}>{o.id}</option>)}
        </select></label>
        {unit.review && <p className="unit-review-note">확인 필요: {unit.cls === 'unknown' ? '유형을 고르십시오.' : (unit.conf ?? 1) < .5 ? '신뢰도가 낮습니다. 위치와 유형을 확인하십시오.' : '위치와 호실을 확인하십시오.'}</p>}
        <label className="unit-type">유형 <select value={clsOf(unit)} onChange={e => patch(unit.id, { ...typeFields(e.target.value), review: false })}>
          {unit.cls === 'unknown' && <option value="unknown">유형 미확인</option>}
          {TYPES.map(t => <option key={t.class} value={t.class}>{t.name}</option>)}
        </select></label>
        <div className="unit-actions">
          <button type="button" className="pill" onClick={() => patch(unit.id, { rot: ((unit.rot ?? 0) + 90) % 360 })}>방향 90° 회전</button>
          {unit.review && unit.cls !== 'unknown' && <button type="button" className="pill" onClick={() => patch(unit.id, { review: false })}>확인 완료</button>}
          <button type="button" className="pill unit-delete" onClick={() => remove(unit.id)}>삭제</button>
        </div>
      </section>}
    </>}
    {tool === 'align' && <p className="unit-step" role="status">{!view ? '이 층에는 맞출 도면 이미지가 없습니다.'
      : pts.length < 2 ? `도면 이미지에서 기준점 ${pts.length + 1}을 누르십시오.` : `평면도에서 기준점 ${pts.length - 1}과 같은 위치를 누르십시오.`}</p>}
    {view && <label className="unit-opacity">도면 이미지 농도 <input type="range" min="0" max="1" step=".1" value={opacity} onChange={e => setOpacity(Number(e.target.value))} /> {Math.round(opacity * 100)}%</label>}
    {(review.length > 0 || pending.length > 0) && <section className="unit-review" aria-label="확인 필요">
      <h3>확인 필요 {review.length}대</h3>
      <ul>
        {review.map(u => <li key={u.id}><button type="button" className="pill" disabled={!floorOf(u)} onClick={() => jump(u)}>
          {floorOf(u)?.id ?? '층 없음'} {model.floors.flatMap(f => f.rooms).find(r => r.id === u.room)?.name ?? u.room} {u.type ?? '실내기'}</button></li>)}
        {pending.map(f => <li key={f.id}><button type="button" className="pill" onClick={() => { onFloor(f.id); onTool('align') }}>
          {f.id} 위치를 맞추지 않은 인식 결과 {f.detections!.length}개</button></li>)}
      </ul>
    </section>}
  </div>

  return { down, move, up, reset, layer, marks, panel }
}
