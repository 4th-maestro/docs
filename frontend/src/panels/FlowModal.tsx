import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { TwinFlow } from '../twin'
import './flow.css'

// 데이터 흐름 모달: 트윈 보고(flow)를 앱 화면 위 대화 상자로 표시(3D를 가리지 않음)
// - 연결선: 노드 위치를 재서 SVG 곡선. 강조는 마우스·포커스 노드, 없으면 현재 역할 기준(트윈 drawFlow와 같은 규칙)
// - 사람을 누르면 그 역할로 전환(트윈 persona 동작). 닫기·Esc는 <dialog> 기본 동작
type Path = { d: string; on: boolean }

// 강조할 노드: 사람이면 그 사람이 받는 정보와 출처, 정보면 출처와 받는 사람, 출처면 그 출처를 쓰는 정보와 받는 사람
function litNodes(flow: TwinFlow, pk: string): Set<string> {
  const on = new Set([pk])
  const [kind, id] = [pk.slice(0, 1), pk.slice(2)]
  for (const f of flow.infos) {
    const hit = kind === 'p' ? f.to.includes(id) : kind === 'f' ? f.id === id : f.src.includes(id)
    if (!hit) continue
    on.add(`f:${f.id}`)
    if (kind !== 's') f.src.forEach((k) => on.add(`s:${k}`))
    if (kind !== 'p') f.to.forEach((k) => on.add(`p:${k}`))
  }
  return on
}

export default function FlowModal({ flow, persona, onPersona, onClose }: { flow: TwinFlow; persona: string; onPersona(key: string): void; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const cols = useRef<HTMLDivElement>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [paths, setPaths] = useState<Path[]>([])
  useEffect(() => {
    const d = ref.current
    d?.showModal()
    return () => d?.close()
  }, [])

  const pk = focus ?? `p:${persona}`
  const on = litNodes(flow, pk)
  useLayoutEffect(() => {
    const el = cols.current
    if (!el) return
    const draw = () => {
      const base = el.getBoundingClientRect()
      const box = (n: string) => el.querySelector(`[data-n="${n}"]`)?.getBoundingClientRect()
      const lit = litNodes(flow, pk)
      const out: Path[] = []
      const link = (a: string, b: string, only: boolean) => {
        const ra = box(a), rb = box(b)
        if (!ra || !rb) return
        const x1 = ra.right - base.left, y1 = ra.top + ra.height / 2 - base.top, x2 = rb.left - base.left, y2 = rb.top + rb.height / 2 - base.top, mx = (x1 + x2) / 2
        out.push({ d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, on: lit.has(a) && lit.has(b) && only })
      }
      for (const f of flow.infos) {
        for (const k of f.src) link(`s:${k}`, `f:${f.id}`, pk.startsWith('s:') ? pk === `s:${k}` : true)
        for (const k of f.to) link(`f:${f.id}`, `p:${k}`, pk.startsWith('p:') ? pk === `p:${k}` : true)
      }
      // 강조선은 마지막 순서로 렌더링해 다른 선 위에 표시
      setPaths(out.sort((a, b) => Number(a.on) - Number(b.on)))
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    return () => ro.disconnect()
  }, [flow, pk])

  const co = flow.sources.filter((s) => s.org === '회사').length
  const node = (n: string, extra = '') => ({
    'data-n': n,
    className: `flow-node${extra}${on.has(n) ? '' : ' dim'}`,
    onPointerEnter: () => setFocus(n),
  })
  return (
    <dialog ref={ref} className="flow-modal" aria-labelledby="flow-title" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      <div className="flow-body">
        <div className="flow-head">
          <h2 id="flow-title">데이터 흐름</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="닫기"><X size={20} /></button>
        </div>
        <p className="flow-lead">회사 보유 데이터 {co}종과 공공 데이터 {flow.sources.length - co}종으로 {flow.personas.length}개 역할에 필요한 정보를 만듭니다. 역할을 누르면 3D 화면이 그 역할 기준으로 바뀝니다.</p>
        <div className="flow-cols" ref={cols} onPointerLeave={() => setFocus(null)}>
          <svg aria-hidden>{paths.map((p, i) => <path key={i} d={p.d} className={p.on ? 'on' : 'dim'} />)}</svg>
          <div className="flow-col">
            <h3>1. 수집 데이터</h3>
            {flow.sources.map((s) => (
              <div key={s.key} {...node(`s:${s.key}`)}>
                <span className="flow-org">{s.org}</span>{s.name}<small>{s.what}</small>
              </div>
            ))}
          </div>
          <div className="flow-col">
            <h3>2. 트윈이 만드는 정보</h3>
            {flow.infos.map((f) => (
              <div key={f.id} {...node(`f:${f.id}`)}>
                {f.label}{f.value && <span className="v">{f.value}</span>}
                <small>{f.src.map((k) => flow.sources.find((s) => s.key === k)?.label ?? k).join(', ')}</small>
              </div>
            ))}
          </div>
          <div className="flow-col">
            <h3>3. 받는 사람</h3>
            {flow.personas.map((p) => (
              <button key={p.key} type="button" {...node(`p:${p.key}`, p.key === persona ? ' hot' : '')} aria-pressed={p.key === persona}
                onFocus={() => setFocus(`p:${p.key}`)} onBlur={() => setFocus(null)} onClick={() => onPersona(p.key)}>
                {p.name}<small>{p.why}</small><small className="cnt">정보 {flow.infos.filter((f) => f.to.includes(p.key)).length}개 수신</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    </dialog>
  )
}
