import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { Maximize2, X } from 'lucide-react'
import { LineKey, Seg } from '../energy/parts'
import { fmt, niceStep, tipLeft, useWidth } from '../energy/util'
import '../energy/energy.css'
import type { Chart, LineChart } from '../types'
import './chart.css'

// AI 답변 그래프: 숫자는 서버 도구 결과(lambda/src/tools.py chart), 화면은 그리기만 함
// - bar: 한 가지 색 가로 막대(값은 막대 오른쪽 글자), line: 이번 기간 파랑 실선·이전 기간 회색 점선(전력 분석과 같은 규칙)
// - 표로 보기 전환, 말풍선에서는 막대 8개까지(크게 보기에서 전체)
const COMPACT_ROWS = 8

export default function ChartView({ chart, big = false, onExpand }: { chart: Chart; big?: boolean; onExpand?: () => void }) {
  const [table, setTable] = useState(chart.prefer === 'table')
  return (
    <figure className={big ? 'cv big' : 'cv'}>
      <figcaption className="cv-head">
        <b>{chart.title}</b>
        {chart.note && <span>{chart.note}</span>}
      </figcaption>
      <div className="cv-tools">
        <Seg label="표시 방식" options={[['chart', '그래프'], ['table', '표']]} value={table ? 'table' : 'chart'} onChange={(v) => setTable(v === 'table')} />
        {onExpand && <button type="button" className="icon" onClick={onExpand} aria-label={`${chart.title} 크게 보기`} title="크게 보기"><Maximize2 size={18} /></button>}
      </div>
      {table ? <Table chart={chart} /> : chart.kind === 'bar' ? <Bars chart={chart} big={big} /> : <Line chart={chart} big={big} />}
    </figure>
  )
}

function Bars({ chart, big }: { chart: Extract<Chart, { kind: 'bar' }>; big: boolean }) {
  const rows = big ? chart.items : chart.items.slice(0, COMPACT_ROWS)
  const max = Math.max(...chart.items.map((i) => Math.abs(i.value)), 0) || 1
  return (
    <ol className="cv-bars" aria-label={`${chart.title}, 단위 ${chart.unit}`}>
      {rows.map((i, n) => (
        <li key={i.id ?? `${i.label}-${n}`} className="rise-in" style={{ '--i': n } as React.CSSProperties}>
          <span className="cv-label" title={i.label}>{i.label}{i.sub && <small>{i.sub}</small>}</span>
          <span className="cv-track" aria-hidden><i className="grow" style={{ width: `${(Math.abs(i.value) / max) * 100}%` }} /></span>
          <span className="cv-val">{fmt(i.value)}<small>{chart.unit}</small></span>
        </li>
      ))}
      {rows.length < chart.items.length && <li className="cv-more">외 {chart.items.length - rows.length}개 항목은 크게 보기 또는 표에서 확인하십시오.</li>}
    </ol>
  )
}

function Line({ chart, big }: { chart: LineChart; big: boolean }) {
  const [w, ref] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()
  const H = big ? 320 : 200
  const L = 44, R = 12, T = 10, B = 26
  const n = chart.labels.length
  const vals = chart.series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  const step = niceStep(Math.max(...vals, 0))
  const top = Math.ceil(Math.max(...vals, 0) / step) * step || step
  const x = (i: number) => L + (n > 1 ? (i / (n - 1)) * (w - L - R) : 0)
  const y = (v: number) => T + (1 - v / top) * (H - T - B)
  const path = (vs: (number | null)[]) => vs.reduce((d, v, i) => (v === null ? d : `${d}${d && vs[i - 1] !== null && i > 0 ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`), '')
  const every = Math.ceil(n / (w < 420 ? 5 : 8))
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - L) / (w - L - R)) * (n - 1)))))
  }
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setHover((h) => Math.max(0, Math.min(n - 1, (h ?? n - 1) + (e.key === 'ArrowRight' ? 1 : -1)))) }
  }
  const cur = chart.series.find((s) => s.role === 'current')
  const last = cur ? cur.values.reduce<number>((k, v, i) => (v !== null ? i : k), -1) : -1
  return (
    <div className="cv-line" ref={ref}>
      <div className="cv-legend">
        {[...chart.series].reverse().map((s) => <span key={s.name}><LineKey dashed={s.role === 'previous'} />{s.name}</span>)}
        <span className="cv-unit">단위 {chart.unit}</span>
      </div>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-labelledby={`${id}t`} tabIndex={0} onPointerMove={pick} onPointerLeave={() => setHover(null)} onKeyDown={key} onBlur={() => setHover(null)}>
          <title id={`${id}t`}>{chart.title}. {chart.series.map((s) => `${s.name} 합계 ${fmt(s.values.reduce<number>((a, v) => a + (v ?? 0), 0))}${chart.unit}`).join(', ')}</title>
          {Array.from({ length: Math.round(top / step) + 1 }, (_, k) => k * step).map((v) => (
            <g key={v}><line x1={L} x2={w - R} y1={y(v)} y2={y(v)} className="cv-grid" /><text x={L - 6} y={y(v) + 4} textAnchor="end" className="cv-axis">{fmt(v, 0)}</text></g>
          ))}
          {/* 눈금 글자: every 간격, 마지막 글자와 32px 미만인 글자는 생략해 겹침 방지 */}
          {chart.labels.map((lb, i) => ((i % every === 0 && x(n - 1) - x(i) >= 32) || i === n - 1) && <text key={lb + i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="cv-axis">{lb}</text>)}
          {chart.series.map((s) => (
            <path key={s.name} d={path(s.values)} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
              stroke={s.role === 'previous' ? 'var(--en-prev)' : 'var(--en-cur)'} strokeDasharray={s.role === 'previous' ? '4 4' : undefined}
              className={s.role === 'current' ? 'draw' : undefined} pathLength={s.role === 'current' ? 1 : undefined} />
          ))}
          {cur && last >= 0 && <circle cx={x(last)} cy={y(cur.values[last]!)} r={4} fill="var(--en-cur)" stroke="var(--canvas)" strokeWidth={2} />}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="cv-cross" />}
        </svg>
      )}
      {hover !== null && w > 0 && (
        <div className="cv-tip" style={{ left: tipLeft(x(hover), w, 168), top: 28 }} role="status">
          <b>{chart.labels[hover]}</b>
          {[...chart.series].reverse().map((s) => <span key={s.name}><LineKey dashed={s.role === 'previous'} />{s.name} {s.values[hover] === null ? '집계 전' : `${fmt(s.values[hover]!)}${chart.unit}`}</span>)}
        </div>
      )}
    </div>
  )
}

function Table({ chart }: { chart: Chart }) {
  return (
    <div className="cv-table">
      <table>
        {chart.kind === 'bar' ? (
          <>
            <thead><tr><th>항목</th><th>구분</th><th className="num">값({chart.unit})</th></tr></thead>
            <tbody>{chart.items.map((i, n) => <tr key={i.id ?? n}><td>{i.label}</td><td>{i.sub ?? ''}</td><td className="num">{fmt(i.value)}</td></tr>)}</tbody>
          </>
        ) : (
          <>
            <thead><tr><th>구간</th>{chart.series.map((s) => <th key={s.name} className="num">{s.name}({chart.unit})</th>)}</tr></thead>
            <tbody>{chart.labels.map((lb, i) => <tr key={lb + i}><td>{lb}</td>{chart.series.map((s) => <td key={s.name} className="num">{s.values[i] === null ? '-' : fmt(s.values[i]!)}</td>)}</tr>)}</tbody>
          </>
        )}
      </table>
    </div>
  )
}

// 크게 보기: <dialog>로 포커스 가두기와 Esc 닫기는 브라우저 기본 동작 사용
export function ChartModal({ chart, onClose }: { chart: Chart; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    d?.showModal()
    return () => d?.close()
  }, [])
  return (
    <dialog ref={ref} className="cv-modal" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose() }} aria-label={chart.title}>
      <div className="cv-modal-body">
        <button type="button" className="icon cv-close" onClick={onClose} aria-label="닫기"><X size={20} /></button>
        <ChartView chart={chart} big />
      </div>
    </dialog>
  )
}
