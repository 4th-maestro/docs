import { useCallback, useId, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import Panel from './Panel'
import type { History, HourPoint } from './types'
import { hhmm } from './usePoll'
import { SkChart } from '../skeleton/Skeleton'

// 시간별 전력 선 그래프(차트 라이브러리 없이 SVG)
// - 오늘: 실선(파랑), 어제: 점선(회색, 비교 기준), 현재 시간 점과 값 직접 표시
// - 단일 y축(kW), 눈금 4칸, 격자는 실선 헤어라인
// - 마우스·터치·좌우 화살표 키로 시간 선택, 같은 값은 표로 보기에서도 제공
// 그래프 높이: 상단 지표 카드 아래 전체 너비 배치라 3D 도면이 많이 내려가지 않게 낮춤(2026-11-20, 이전 220)
const H = 170
const PAD = { l: 40, r: 96, t: 12, b: 28 }
const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 10]
const r1 = (v: number) => Math.round(v * 10) / 10
const total = (ps: HourPoint[]) => ps.reduce((s, p) => s + p.kwh, 0)

// y축 눈금 간격: 최댓값의 1/4 이상인 1·1.5·2·2.5·3·4·5·10 × 10^n 중 최솟값
function niceStep(max: number) {
  const raw = Math.max(max, 1) / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  return STEPS.find((s) => s * p >= raw)! * p
}

function Key({ dashed }: { dashed?: boolean }) {
  return (
    <svg width="16" height="8" aria-hidden>
      <line x1="2" x2="14" y1="4" y2="4" stroke={dashed ? 'var(--prev)' : 'var(--today)'} strokeWidth="2" strokeLinecap={dashed ? 'butt' : 'round'} strokeDasharray={dashed ? '4 4' : undefined} />
    </svg>
  )
}

// 조회는 화면(App)이 맡고 결과만 받음: 상단 "오늘 누적 사용량"과 같은 응답을 사용(요청 1회)
// - scope: 표시 이름(층 또는 "건물 전체"), id: 그래프 다시 그리기 기준(건물·층)
export default function PowerTrend({ poll: { data, error, stale }, scope, id: drawKey }: { poll: { data: History | null; error: string; stale: boolean }; scope: string; id: string }) {
  const [w, setW] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()
  // 실제 픽셀 너비로 그림: viewBox 확대·축소는 390px 화면에서 축 글자를 12px 미만으로 줄임
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const today = data?.today ?? []
  const prev = data?.yesterday ?? []
  const nowH = today.length - 1
  const last = today[nowH]
  const minute = data ? Number(data.generatedAt.slice(14, 16)) : 0
  const todayKwh = r1(total(today))
  const prevSame = r1(total(prev.slice(0, nowH)) + (prev[nowH]?.kwh ?? 0) * (minute / 60))
  const diff = prevSame ? r1((todayKwh / prevSame - 1) * 100) : 0
  const peak = today.reduce<HourPoint | undefined>((a, p) => (!a || p.kw > a.kw ? p : a), undefined)
  const step = niceStep(Math.max(0, ...today.map((p) => p.kw), ...prev.map((p) => p.kw)))
  const iw = Math.max(0, w - PAD.l - PAD.r)
  const x = (h: number) => PAD.l + (h / 23) * iw
  const y = (v: number) => PAD.t + (1 - v / (step * 4)) * (H - PAD.t - PAD.b)
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
  const summary = data && peak
    ? `오늘 0시부터 ${hhmm(data.generatedAt)}까지 ${todayKwh}kWh를 사용했습니다. 어제 같은 시각은 ${prevSame}kWh입니다. 오늘 최대 전력은 ${peak.hour}시 ${peak.kw}kW입니다.`
    : ''
  const tipLeft = hover === null ? 0 : x(hover) + 164 > w ? x(hover) - 164 : x(hover) + 12

  return (
    <Panel
      title="전력 추이" at={data?.generatedAt} mock={data?.mock} error={error} loading={!data && !error} skeleton={<SkChart h={H} />} stale={stale}
      empty={data !== null && ![...today, ...prev].some((p) => p.kw > 0) && `${scope}의 전력 기록이 없습니다.`}
    >
      {data && last && (
        <>
          {/* 오늘 누적 사용량 값은 상단 전력·요금 카드에 표시, 여기는 어제 같은 시각 대비만 */}
          <p className="pn-cmp">오늘 {todayKwh.toLocaleString('ko-KR')}kWh, 어제 같은 시각 {prevSame.toLocaleString('ko-KR')}kWh 대비 {diff > 0 ? '+' : ''}{diff}%</p>
          <div className="pn-keys">
            <span><span className="pn-key"><Key />오늘</span><span className="pn-key"><Key dashed />어제</span></span>
            <span>단위 kW(시간별 평균), 가상 데이터</span>
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
                {[0, 1, 2, 3, 4].map((i) => (
                  <g key={i}>
                    <line x1={PAD.l} x2={w - PAD.r} y1={y(step * i)} y2={y(step * i)} stroke={i ? 'var(--hairline-soft)' : 'var(--hairline)'} />
                    <text x={PAD.l - 8} y={y(step * i)} dy="0.32em" textAnchor="end">{r1(step * i)}</text>
                  </g>
                ))}
                {[0, 6, 12, 18, 23].map((h) => <text key={h} x={x(h)} y={H - 8} textAnchor="middle">{h}시</text>)}
                <path d={path(prev)} fill="none" stroke="var(--prev)" strokeWidth={2} strokeDasharray="4 4" strokeLinejoin="round" />
                <path key={drawKey} className="draw" pathLength={1} d={path(today)} fill="none" stroke="var(--today)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                <circle cx={x(nowH)} cy={y(last.kw)} r={4} fill="var(--today)" stroke="var(--canvas)" strokeWidth={2} />
                <text className="now-label" x={x(nowH) + 10} y={y(last.kw)} dy="0.32em">지금 {last.kw}kW</text>
                {hover !== null && (
                  <g pointerEvents="none">
                    <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={y(0)} stroke="var(--border-strong)" />
                    <circle cx={x(hover)} cy={y(prev[hover].kw)} r={4} fill="var(--prev)" stroke="var(--canvas)" strokeWidth={2} />
                    {today[hover] && <circle cx={x(hover)} cy={y(today[hover].kw)} r={4} fill="var(--today)" stroke="var(--canvas)" strokeWidth={2} />}
                  </g>
                )}
              </svg>
            )}
            {hover !== null && (
              <div className="pn-tip" style={{ left: tipLeft }} aria-hidden>
                <p>{hover}시 평균</p>
                <div><Key /><strong>{today[hover] ? `${today[hover].kw}kW` : '집계 전'}</strong><span>오늘</span></div>
                <div><Key dashed /><strong>{prev[hover].kw}kW</strong><span>어제</span></div>
              </div>
            )}
          </div>
          <details className="pn-table">
            <summary>표로 보기</summary>
            <table>
              <thead><tr><th>시각</th><th>오늘(kW)</th><th>어제(kW)</th></tr></thead>
              <tbody>{prev.map((p) => <tr key={p.hour}><td>{p.hour}시</td><td>{today[p.hour]?.kw ?? '-'}</td><td>{p.kw}</td></tr>)}</tbody>
            </table>
          </details>
        </>
      )}
    </Panel>
  )
}
