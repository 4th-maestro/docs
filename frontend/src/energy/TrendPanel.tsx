import { useId, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import Panel from '../panels/Panel'
import { usePoll } from '../panels/usePoll'
import { getTrend, query } from './api'
import type { Period } from './api'
import { Delta, LineKey } from './parts'
import { NAMES, fmt, niceStep, tipLeft, useWidth } from './util'
import './energy.css'

// 기간 추이 선 그래프(PowerTrend와 같은 규칙)
// - 이번 기간: 실선(파랑), 지난 기간: 점선(회색, 비교 기준). 마지막 점은 집계 중인 현재 시간·날짜
// - 단일 y축(kWh), 눈금 4칸, 격자는 실선 헤어라인
// - 마우스·터치·좌우 화살표 키로 시점 선택, 같은 값은 표로 보기에서도 제공
const H = 220
const PAD = { l: 56, r: 16, t: 12, b: 28 }
const TICKS: Record<Period, (n: number) => number[]> = {
  day: () => [0, 6, 12, 18, 23],
  week: () => [0, 1, 2, 3, 4, 5, 6],
  month: (n) => [0, 7, 14, 21, n - 1],
}

export default function TrendPanel({ building, period }: { building: string; period: Period }) {
  const { data, error, stale } = usePoll(getTrend, query({ building, period }))
  const [w, measure] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()
  const names = NAMES[data?.period ?? period]

  const cur = data?.current ?? []
  const prev = data?.previous ?? []
  const n = Math.max(cur.length, prev.length)
  const last = cur.length - 1
  const step = niceStep(Math.max(0, ...cur.map((p) => p.kwh), ...prev.map((p) => p.kwh)))
  const iw = Math.max(0, w - PAD.l - PAD.r)
  const x = (i: number) => PAD.l + (n > 1 ? i / (n - 1) : 0.5) * iw
  const y = (v: number) => PAD.t + (1 - v / (step * 4)) * (H - PAD.t - PAD.b)
  const path = (ps: { kwh: number }[]) => ps.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.kwh).toFixed(1)}`).join(' ')
  const clamp = (i: number) => Math.min(n - 1, Math.max(0, i))

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left
    setHover(clamp(Math.round(((px - PAD.l) / Math.max(iw, 1)) * (n - 1))))
  }
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      setHover((h) => clamp((h ?? last) + (e.key === 'ArrowLeft' ? -1 : 1)))
    } else if (e.key === 'Escape') setHover(null)
  }
  const label = (i: number) => (cur[i] ?? prev[i])?.label ?? ''
  const summary = data
    ? `${names.cur} 누적 ${fmt(data.totalKwh)}kWh, ${names.same} ${fmt(data.prevSameKwh)}kWh, ${names.prev} 전체 ${fmt(data.prevTotalKwh)}kWh입니다.`
    : ''

  return (
    <Panel
      title="전력 사용량 추이" at={data?.generatedAt} mock={data?.mock} error={error} loading={!data && !error} stale={stale}
      empty={data !== null && ![...cur, ...prev].some((p) => p.kwh > 0) && '전력 사용 기록이 없습니다.'}
    >
      {data && (
        <>
          <div className="pn-stat">
            <span className="label">{names.cur} 누적 사용량</span>
            <strong>{fmt(data.totalKwh)}<small>kWh</small></strong>
            <span className="sub en-sub"><Delta cur={data.totalKwh} prev={data.prevSameKwh} />{names.same} {fmt(data.prevSameKwh)}kWh 대비</span>
          </div>
          <div className="pn-keys">
            <span><span className="pn-key"><LineKey />{names.cur}</span><span className="pn-key"><LineKey dashed />{names.prev}</span></span>
            <span>단위 kWh({data.period === 'day' ? '시간별' : '일별'} 합계), 가상 데이터</span>
          </div>
          <div className="pn-plotbox" ref={measure} style={{ height: H }}>
            {w > 0 && (
              <svg
                className="pn-plot" width={w} height={H} role="img" aria-labelledby={`${id}t ${id}d`} tabIndex={0}
                onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(last)} onBlur={() => setHover(null)} onKeyDown={key}
              >
                <title id={`${id}t`}>{data.period === 'day' ? '시간별' : '일별'} 전력 사용량: {names.cur}, {names.prev}</title>
                <desc id={`${id}d`}>{summary}</desc>
                {[0, 1, 2, 3, 4].map((i) => (
                  <g key={i}>
                    <line x1={PAD.l} x2={w - PAD.r} y1={y(step * i)} y2={y(step * i)} stroke={i ? 'var(--hairline-soft)' : 'var(--hairline)'} />
                    <text x={PAD.l - 8} y={y(step * i)} dy="0.32em" textAnchor="end">{fmt(step * i)}</text>
                  </g>
                ))}
                {TICKS[data.period](n).filter((i) => i < n).map((i) => (
                  <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 && n > 7 ? 'start' : i === n - 1 && n > 7 ? 'end' : 'middle'}>{label(i)}</text>
                ))}
                <path d={path(prev)} fill="none" stroke="var(--en-prev)" strokeWidth={2} strokeDasharray="4 4" strokeLinejoin="round" />
                <path d={path(cur)} fill="none" stroke="var(--en-cur)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                {last >= 0 && <circle cx={x(last)} cy={y(cur[last].kwh)} r={4} fill="var(--en-cur)" stroke="var(--canvas)" strokeWidth={2} />}
                {hover !== null && (
                  <g pointerEvents="none">
                    <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={y(0)} stroke="var(--border-strong)" />
                    {prev[hover] && <circle cx={x(hover)} cy={y(prev[hover].kwh)} r={4} fill="var(--en-prev)" stroke="var(--canvas)" strokeWidth={2} />}
                    {cur[hover] && <circle cx={x(hover)} cy={y(cur[hover].kwh)} r={4} fill="var(--en-cur)" stroke="var(--canvas)" strokeWidth={2} />}
                  </g>
                )}
              </svg>
            )}
            {hover !== null && (
              <div className="pn-tip" style={{ left: tipLeft(x(hover), w) }} aria-hidden>
                <p>{label(hover)}{hover === last ? ' 집계 중' : ''}</p>
                <div><LineKey /><strong>{cur[hover] ? `${fmt(cur[hover].kwh)}kWh` : '집계 전'}</strong><span>{names.cur}</span></div>
                <div><LineKey dashed /><strong>{prev[hover] ? `${fmt(prev[hover].kwh)}kWh` : '없음'}</strong><span>{names.prev}</span></div>
              </div>
            )}
          </div>
          <details className="pn-table">
            <summary>표로 보기</summary>
            <table>
              <thead><tr><th>{data.period === 'day' ? '시각' : '날짜'}</th><th>{names.cur}(kWh)</th><th>{names.prev}(kWh)</th></tr></thead>
              <tbody>
                {Array.from({ length: n }, (_, i) => (
                  <tr key={i}><td>{label(i)}</td><td>{cur[i] ? fmt(cur[i].kwh) : '-'}</td><td>{prev[i] ? fmt(prev[i].kwh) : '-'}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Panel>
  )
}
