import { useCallback, useId, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { History, HourPoint } from './types'
import { hhmm } from './usePoll'
import { Sk } from '../skeleton/Skeleton'
import './panels.css'

// 시간별 전력 추이선: 상단 전력·요금 카드의 마지막 줄(차트 라이브러리 없이 SVG)
// - 오늘: 실선(파랑), 어제: 점선(회색, 비교 기준)
// - y축 눈금 없음: 값은 시간 선택 시 말풍선 표시, 눈금 있는 그래프는 전력 분석 탭
// - 마우스·터치·좌우 화살표 키로 시간 선택
// 높이: 별도 카드(그래프 170px, 카드 391px)를 카드 안 한 줄로 축소(2026-11-21)
const LINE = 44
const AXIS = 18
const H = LINE + AXIS
const PAD = { l: 12, r: 12, t: 4 }
const TIP_W = 164
const r1 = (v: number) => Math.round(v * 10) / 10
const total = (ps: HourPoint[]) => ps.reduce((s, p) => s + p.kwh, 0)

function Key({ dashed }: { dashed?: boolean }) {
  return (
    <svg width="16" height="8" aria-hidden>
      <line x1="2" x2="14" y1="4" y2="4" stroke={dashed ? 'var(--prev)' : 'var(--today)'} strokeWidth="2" strokeLinecap={dashed ? 'butt' : 'round'} strokeDasharray={dashed ? '4 4' : undefined} />
    </svg>
  )
}

// 조회는 화면(App)이 맡고 결과만 받음: "오늘 누적 사용량"과 같은 응답(요청 1회)
// - scope: 표시 이름(층 또는 "건물 전체"), id: 그래프 다시 그리기 기준(건물·층)
export default function PowerTrend({ poll: { data, error, stale }, scope, id: drawKey }: { poll: { data: History | null; error: string; stale: boolean }; scope: string; id: string }) {
  const [w, setW] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()
  // 실제 픽셀 너비로 그림: viewBox 확대·축소는 좁은 화면에서 축 글자를 12px 미만으로 줄임
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (!data) return <div className="ktrend">{error ? <p className="ktrend-msg">전력 기록을 불러오지 못했습니다. {error}</p> : <Sk h={H + 28} />}</div>
  const today = data.today
  const prev = data.yesterday
  if (![...today, ...prev].some((p) => p.kw > 0)) return <div className="ktrend"><p className="ktrend-msg">{scope}의 전력 기록이 없습니다.</p></div>

  const nowH = today.length - 1
  const minute = Number(data.generatedAt.slice(14, 16))
  const todayKwh = r1(total(today))
  const prevSame = r1(total(prev.slice(0, nowH)) + (prev[nowH]?.kwh ?? 0) * (minute / 60))
  const diff = prevSame ? r1((todayKwh / prevSame - 1) * 100) : 0
  const peak = today.reduce<HourPoint | undefined>((a, p) => (!a || p.kw > a.kw ? p : a), undefined)
  const max = Math.max(1, ...today.map((p) => p.kw), ...prev.map((p) => p.kw))
  const iw = Math.max(0, w - PAD.l - PAD.r)
  const x = (h: number) => PAD.l + (h / 23) * iw
  const y = (v: number) => PAD.t + (1 - v / max) * (LINE - PAD.t)
  const path = (ps: HourPoint[]) => ps.map((p, i) => `${i ? 'L' : 'M'}${x(p.hour).toFixed(1)} ${y(p.kw).toFixed(1)}`).join(' ')
  const clamp = (h: number) => Math.min(23, Math.max(0, h))

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left
    setHover(clamp(Math.round(((px - PAD.l) / iw) * 23)))
  }
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      setHover((h) => clamp((h ?? nowH) + (e.key === 'ArrowLeft' ? -1 : 1)))
    } else if (e.key === 'Escape') setHover(null)
  }
  const summary = `오늘 0시부터 ${hhmm(data.generatedAt)}까지 ${todayKwh}kWh, 어제 같은 시각 ${prevSame}kWh입니다.${peak ? ` 오늘 최대 전력은 ${peak.hour}시 ${peak.kw}kW입니다.` : ''}`
  const tipLeft = hover === null ? 0 : x(hover) + 12 + TIP_W > w ? x(hover) - 12 - TIP_W : x(hover) + 12

  return (
    <div className={stale ? 'pn ktrend stale' : 'pn ktrend'}>
      <div className="pn-keys">
        <span><span className="pn-key"><Key />오늘</span><span className="pn-key"><Key dashed />어제</span></span>
        <span className="ktrend-cmp">어제 같은 시각 대비 <strong>{diff > 0 ? '+' : ''}{diff}%</strong>{data.mock ? ', 목업' : ', 가상 데이터'}</span>
      </div>
      <div className="pn-plotbox" ref={measure} style={{ height: H }}>
        {w > 0 && (
          <svg
            className="pn-plot" width={w} height={H} role="img" aria-labelledby={`${id}t ${id}d`} tabIndex={0}
            onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(nowH)} onBlur={() => setHover(null)} onKeyDown={key}
          >
            <title id={`${id}t`}>{scope} 시간별 전력, 오늘과 어제</title>
            <desc id={`${id}d`}>{summary}</desc>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--hairline)" />
            {[0, 6, 12, 18, 23].map((h) => <text key={h} x={x(h)} y={H - 2} textAnchor={h ? (h === 23 ? 'end' : 'middle') : 'start'}>{h}시</text>)}
            <path d={path(prev)} fill="none" stroke="var(--prev)" strokeWidth={2} strokeDasharray="4 4" strokeLinejoin="round" />
            <path key={drawKey} className="draw" pathLength={1} d={path(today)} fill="none" stroke="var(--today)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            {today[nowH] && <circle cx={x(nowH)} cy={y(today[nowH].kw)} r={4} fill="var(--today)" stroke="var(--canvas)" strokeWidth={2} />}
            {hover !== null && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={y(0)} stroke="var(--border-strong)" />
                {prev[hover] && <circle cx={x(hover)} cy={y(prev[hover].kw)} r={4} fill="var(--prev)" stroke="var(--canvas)" strokeWidth={2} />}
                {today[hover] && <circle cx={x(hover)} cy={y(today[hover].kw)} r={4} fill="var(--today)" stroke="var(--canvas)" strokeWidth={2} />}
              </g>
            )}
          </svg>
        )}
        {hover !== null && (
          <div className="pn-tip ktrend-tip" style={{ left: tipLeft }} aria-hidden>
            <p>{hover}시 평균</p>
            <div><Key /><strong>{today[hover] ? `${today[hover].kw}kW` : '집계 전'}</strong><span>오늘</span></div>
            <div><Key dashed /><strong>{prev[hover] ? `${prev[hover].kw}kW` : '-'}</strong><span>어제</span></div>
          </div>
        )}
      </div>
    </div>
  )
}
