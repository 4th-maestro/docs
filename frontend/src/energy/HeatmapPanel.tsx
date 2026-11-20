import { useId, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import Panel from '../panels/Panel'
import { usePoll } from '../panels/usePoll'
import { getHeatmap, query } from './api'
import { fmt, tipLeft, useWidth } from './util'
import './energy.css'
import { SkFigure, SkHeatmap } from '../skeleton/Skeleton'
import CountUp from '../motion/CountUp'

// 요일×시간 평균 전력 히트맵(최근 4주)
// - 색: 0kW는 무채색, 0 초과는 최댓값 기준 5단계 순차 파랑(밝음→어두움, 어두운 화면은 반대). 운영 시간 밖에서 색이 있는 칸이 낭비 후보
// - 운영 시간: 운영 요일·시간 영역을 굵은 테두리로 표시
// - 칸 사이 2px 간격, 마우스·터치·화살표 키로 칸 선택, 같은 값은 표로 보기에서도 제공
const DAYS = ['월', '화', '수', '목', '금', '토', '일']
const LABEL_W = 28
const TOP = 28
const ROW = 32
const AXIS = 28
const H = TOP + ROW * 7 + AXIS
const BINS = 5

export default function HeatmapPanel({ building }: { building: string }) {
  const { data, error, stale } = usePoll(getHeatmap, query({ building, weeks: '4' }))
  const [w, measure] = useWidth()
  const [sel, setSel] = useState<[number, number] | null>(null)
  const id = useId()

  const cells = data?.cells ?? []
  const max = data?.max ?? 0
  const [open, close] = data?.hours ?? [9, 18]
  const days = data?.weekend ? 7 : 5
  const cw = Math.max(0, (w - LABEL_W) / 24)
  const bin = (v: number) => (v < 0.05 || max <= 0 ? 0 : Math.min(BINS, Math.floor((v / max) * BINS) + 1))
  const inHours = (d: number, h: number) => d < days && open <= h && h < close
  // 운영 시간 밖 사용량(1주 평균): 칸 값(평균 kW) × 1시간
  const total = cells.flat().reduce((s, v) => s + v, 0)
  const after = cells.reduce((s, row, d) => s + row.reduce((t, v, h) => t + (inHours(d, h) ? 0 : v), 0), 0)
  const worst = cells.flatMap((row, d) => row.map((v, h) => ({ d, h, v }))).filter((c) => !inHours(c.d, c.h)).sort((a, b) => b.v - a.v)[0]
  const share = total > 0 ? Math.round((after / total) * 1000) / 10 : 0
  const hoursText = `${data?.weekend ? '매일' : '평일'} ${open}~${close}시`

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const h = Math.floor((e.clientX - r.left - LABEL_W) / Math.max(cw, 1))
    const d = Math.floor((e.clientY - r.top - TOP) / ROW)
    setSel(h >= 0 && h < 24 && d >= 0 && d < 7 ? [d, h] : null)
  }
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    const move: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }
    if (move[e.key]) {
      e.preventDefault()
      const [dd, dh] = move[e.key]
      setSel((s) => {
        const [d, h] = s ?? [0, open]
        return [Math.min(6, Math.max(0, d + dd)), Math.min(23, Math.max(0, h + dh))]
      })
    } else if (e.key === 'Escape') setSel(null)
  }
  const edges = Array.from({ length: BINS + 1 }, (_, i) => (max * i) / BINS)
  const cx = (h: number) => LABEL_W + h * cw

  return (
    <Panel
      title="최근 4주 요일·시간별 평균 전력" at={data?.generatedAt} mock={data?.mock} error={error} loading={!data && !error} skeleton={<><SkFigure /><SkHeatmap /></>} stale={stale}
      empty={data !== null && max <= 0 && '전력 사용 기록이 없습니다.'}
    >
      {data && (
        <>
          <div className="pn-stat">
            <span className="label">운영 시간({hoursText}) 밖 사용 비율</span>
            <strong><CountUp value={Number(fmt(share).replace(/,/g, ''))} /><small>%</small></strong>
            <span className="sub">주당 {fmt(after, 0)}kWh{worst && worst.v > 0 ? `, 가장 큰 칸 ${DAYS[worst.d]} ${worst.h}시 ${fmt(worst.v)}kW` : ''}</span>
          </div>
          <div className="en-legend" aria-label="색 범례">
            <span><i className="en-sw" style={{ background: 'var(--en-z)' }} />0</span>
            {edges.slice(1).map((e, i) => (
              <span key={i}><i className="en-sw" style={{ background: `var(--en-${i + 1})` }} />{fmt(edges[i], 0)}~{fmt(e, 0)}</span>
            ))}
            <span><i className="en-sw en-band" />운영 시간</span>
            <span>단위 kW(시간 평균), 가상 데이터</span>
          </div>
          <div className="pn-plotbox" ref={measure} style={{ height: H }}>
            {w > 0 && (
              <svg
                className="pn-plot" width={w} height={H} role="img" aria-labelledby={`${id}t ${id}d`} tabIndex={0}
                onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setSel(null)}
                onFocus={() => setSel([0, open])} onBlur={() => setSel(null)} onKeyDown={key}
              >
                <title id={`${id}t`}>최근 {data.weeks}주 요일·시간별 평균 전력</title>
                <desc id={`${id}d`}>{`최댓값 ${fmt(max)}kW입니다. 운영 시간(${hoursText}) 밖 사용 비율은 ${fmt(share)}%, 주당 ${fmt(after, 0)}kWh입니다.`}</desc>
                {DAYS.map((d, i) => <text key={d} x={0} y={TOP + i * ROW + ROW / 2} dy="0.32em">{d}</text>)}
                {[0, 6, 12, 18, 23].map((h) => <text key={h} x={cx(h) + cw / 2} y={H - 8} textAnchor={h === 23 ? 'end' : 'middle'}>{h}시</text>)}
                {cells.map((row, d) => row.map((v, h) => (
                  <rect key={`${d}-${h}`} x={cx(h) + 1} y={TOP + d * ROW + 1} width={Math.max(0, cw - 2)} height={ROW - 2} rx={2} className="en-cell" fill={`var(--en-${bin(v) || 'z'})`} />
                )))}
                <rect x={cx(open)} y={TOP} width={(close - open) * cw} height={days * ROW} fill="none" stroke="var(--ink)" strokeWidth={2} rx={3} />
                <text className="en-ink" x={cx(open)} y={TOP - 10}>운영 {open}~{close}시</text>
                {sel && <rect x={cx(sel[1]) + 1} y={TOP + sel[0] * ROW + 1} width={Math.max(0, cw - 2)} height={ROW - 2} rx={2} fill="none" stroke="var(--ink)" strokeWidth={2} pointerEvents="none" />}
              </svg>
            )}
            {sel && cells[sel[0]] && (
              <div className="pn-tip" style={{ left: tipLeft(cx(sel[1]) + cw, w), top: sel[0] < 4 ? TOP + (sel[0] + 1) * ROW : TOP + sel[0] * ROW - 96 }} aria-hidden>
                <p>{DAYS[sel[0]]}요일 {sel[1]}시</p>
                <div><strong>{fmt(cells[sel[0]][sel[1]])}kW</strong><span>평균</span></div>
                <div><span>{inHours(sel[0], sel[1]) ? '운영 시간' : '운영 시간 밖'}</span></div>
              </div>
            )}
          </div>
          <details className="pn-table en-scroll">
            <summary>표로 보기</summary>
            <table>
              <thead><tr><th>시각</th>{DAYS.map((d) => <th key={d}>{d}</th>)}</tr></thead>
              <tbody>
                {Array.from({ length: 24 }, (_, h) => (
                  <tr key={h}><td>{h}시</td>{DAYS.map((_, d) => <td key={d}>{fmt(cells[d]?.[h] ?? 0)}</td>)}</tr>
                ))}
              </tbody>
            </table>
            <p className="en-note">단위는 최근 {data.weeks}주 평균 kW입니다. 운영 시간은 {hoursText}입니다.</p>
          </details>
        </>
      )}
    </Panel>
  )
}
