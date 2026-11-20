import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import Panel from '../panels/Panel'
import { usePoll } from '../panels/usePoll'
import { getBreakdown, query } from './api'
import type { Breakdown, Period } from './api'
import { NAMES, fmt, tipLeft, useWidth } from './util'
import './energy.css'

// 사용 구성 흐름도(건물 → 층 → 용도, Sankey 형식 SVG)
// - 띠 두께는 kWh에 비례, 단일 색(파랑) 반투명 띠와 불투명 노드
// - 노드 칸 최소 높이 40px(라벨 2줄), 작은 노드는 칸 가운데 표시하고 띠 두께는 비례 유지
// - 띠에 마우스·터치·화살표 키로 선택하면 툴팁, 같은 값은 사용 구성 표와 표로 보기에서도 제공
const NW = 12
const GAP = 8
const SLOT = 40
const SCALE = 220
const HEAD = 28
const LABEL_C = 128

type Flow = { from: string; to: string; kwh: number; d: string; tx: number; ty: number }

function layout(data: Breakdown, w: number) {
  const floors = data.floors.filter((f) => f.kwh > 0)
  const byUse = new Map<string, number>()
  for (const f of floors) for (const u of f.uses) byUse.set(u.use, (byUse.get(u.use) ?? 0) + u.kwh)
  const uses = [...byUse].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const total = floors.reduce((s, f) => s + f.kwh, 0)
  const k = total > 0 ? SCALE / total : 0
  const stack = (items: [string, number][]) => {
    let y = HEAD
    return items.map(([name, kwh]) => {
      const h = kwh * k
      const slot = Math.max(h, SLOT)
      const node = { name, kwh, y: y + (slot - h) / 2, h }
      y += slot + GAP
      return node
    })
  }
  const B = stack(floors.map((f) => [f.floor, f.kwh]))
  const C = stack(uses)
  const xC = w - LABEL_C - NW
  const xB = NW + (xC - NW) * 0.4
  const band = (x0: number, y0: number, x1: number, y1: number, h: number) => {
    const m = (x0 + x1) / 2
    return `M${x0} ${y0}C${m} ${y0} ${m} ${y1} ${x1} ${y1}L${x1} ${y1 + h}C${m} ${y1 + h} ${m} ${y0 + h} ${x0} ${y0 + h}Z`
  }
  const flows: Flow[] = []
  let ya = HEAD
  for (const b of B) {
    flows.push({ from: data.name, to: b.name, kwh: b.kwh, d: band(NW, ya, xB, b.y, b.h), tx: xB, ty: b.y + b.h / 2 })
    ya += b.h
  }
  const cOff = new Map(C.map((c) => [c.name, c.y]))
  for (const [i, f] of floors.entries()) {
    let yb = B[i].y
    for (const c of C) {
      const kwh = f.uses.find((u) => u.use === c.name)?.kwh ?? 0
      if (kwh <= 0) continue
      const yc = cOff.get(c.name)!
      flows.push({ from: f.floor, to: c.name, kwh, d: band(xB + NW, yb, xC, yc, kwh * k), tx: xC, ty: yc + (kwh * k) / 2 })
      yb += kwh * k
      cOff.set(c.name, yc + kwh * k)
    }
  }
  const last = (ns: { y: number; h: number }[]) => Math.max(0, ...ns.map((n) => n.y + Math.max(n.h, SLOT / 2)))
  return { B, C, flows, xB, xC, total, height: Math.max(HEAD + SCALE, last(B), last(C)) + 8 }
}

export default function BreakdownPanel({ building, period }: { building: string; period: Period }) {
  const { data, error, stale } = usePoll(getBreakdown, query({ building, period }))
  const [w, measure] = useWidth()
  const [sel, setSel] = useState<number | null>(null)
  const id = useId()
  const L = data ? layout(data, w) : null
  const pct = (v: number) => (L && L.total > 0 ? Math.round((v / L.total) * 1000) / 10 : 0)
  const names = NAMES[data?.period ?? period]

  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!L) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
      setSel((s) => ((s ?? 0) + step + L.flows.length) % L.flows.length)
    } else if (e.key === 'Escape') setSel(null)
  }
  const f = L && sel !== null ? L.flows[sel] : null
  const label = (x: number, y: number, a: string, b: string) => (
    <text className="en-ink" x={x} y={y}>
      <tspan x={x} dy="-0.2em" fontWeight={600}>{a}</tspan>
      <tspan x={x} dy="1.25em" className="en-muted">{b}</tspan>
    </text>
  )
  const uses = L?.C ?? []

  return (
    <Panel
      title={`${names.cur} 사용 구성`} at={data?.generatedAt} mock={data?.mock} error={error} loading={!data && !error} stale={stale}
      empty={data !== null && data.totalKwh <= 0 && '전력 사용 기록이 없습니다.'}
    >
      {data && (
        <>
          <div className="pn-stat">
            <span className="label">{data.name} {names.cur} 사용량</span>
            <strong>{fmt(data.totalKwh)}<small>kWh</small></strong>
            <span className="sub">{uses[0] ? `가장 큰 용도 ${uses[0].name} ${fmt(pct(uses[0].kwh))}%` : ''}</span>
          </div>
          <div className="pn-plotbox" ref={measure} style={{ height: L?.height ?? HEAD + SCALE }}>
            {L && w > 0 && (
              <svg
                className="pn-plot en-flow" width={w} height={L.height} role="img" aria-labelledby={`${id}t ${id}d`} tabIndex={0}
                onFocus={() => setSel(0)} onBlur={() => setSel(null)} onKeyDown={key} onPointerLeave={() => setSel(null)}
              >
                <title id={`${id}t`}>{data.name} 전력 사용 구성: 건물, 층, 용도</title>
                <desc id={`${id}d`}>{uses.map((c) => `${c.name} ${fmt(c.kwh)}kWh(${fmt(pct(c.kwh))}%)`).join(', ')}</desc>
                <text x={0} y={16}>건물</text>
                <text x={L.xB} y={16}>층</text>
                <text x={L.xC} y={16}>용도</text>
                {L.flows.map((fl, i) => (
                  <path key={i} d={fl.d} className={sel === i ? 'en-link on' : 'en-link'} onPointerEnter={() => setSel(i)} onPointerDown={() => setSel(i)} />
                ))}
                <rect x={0} y={HEAD} width={NW} height={SCALE} rx={2} className="en-node" />
                {L.B.map((b) => <rect key={b.name} x={L.xB} y={b.y} width={NW} height={Math.max(b.h, 2)} rx={2} className="en-node" />)}
                {L.C.map((c) => <rect key={c.name} x={L.xC} y={c.y} width={NW} height={Math.max(c.h, 2)} rx={2} className="en-node" />)}
                <text className="en-ink" x={NW + 8} y={HEAD + 16} fontWeight={600}>{data.name}</text>
                {L.B.map((b) => <g key={b.name}>{label(L.xB + NW + 8, b.y + b.h / 2, b.name, `${fmt(b.kwh, 0)}kWh`)}</g>)}
                {L.C.map((c) => <g key={c.name}>{label(L.xC + NW + 8, c.y + c.h / 2, c.name, `${fmt(c.kwh, 0)}kWh ${fmt(pct(c.kwh))}%`)}</g>)}
              </svg>
            )}
            {f && (
              <div className="pn-tip" style={{ left: tipLeft(f.tx - 24, w), top: Math.max(0, f.ty - 40) }} aria-hidden>
                <p>{f.from} → {f.to}</p>
                <div><strong>{fmt(f.kwh)}kWh</strong><span>전체의 {fmt(pct(f.kwh))}%</span></div>
              </div>
            )}
          </div>
          <table className="en-share">
            <caption className="en-note">용도별 사용량, 단위 kWh, 가상 데이터</caption>
            <thead><tr><th>용도</th><th>사용량</th><th>비율</th></tr></thead>
            <tbody>
              {uses.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td><td>{fmt(c.kwh)}</td>
                  <td><span className="en-meter" aria-hidden><i style={{ width: `${pct(c.kwh)}%` }} /></span>{fmt(pct(c.kwh))}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="pn-table">
            <summary>표로 보기</summary>
            <table>
              <thead><tr><th>층</th><th>용도</th><th>사용량(kWh)</th><th>비율</th></tr></thead>
              <tbody>
                {data.floors.flatMap((fl) => [
                  <tr key={fl.floor} className="en-sum"><td>{fl.floor}</td><td>소계</td><td>{fmt(fl.kwh)}</td><td>{fmt(pct(fl.kwh))}%</td></tr>,
                  ...fl.uses.map((u) => <tr key={`${fl.floor}-${u.use}`}><td>{fl.floor}</td><td>{u.use}</td><td>{fmt(u.kwh)}</td><td>{fmt(pct(u.kwh))}%</td></tr>),
                ])}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Panel>
  )
}
