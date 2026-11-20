import type { CSSProperties, ReactNode } from 'react'
import './skeleton.css'

// 스켈레톤: 데이터 도착 전 실제 배치와 같은 자리에 회색 블록 표시
// - 움직임: 불투명도 맥동(skeleton.css), 데이터 도착 전에만 표시
// - 화면 낭독기: 블록은 숨기고 "불러오는 중입니다" 1회 안내
type Len = number | string

export function Sk({ w = '100%', h = 16, r = 8, style }: { w?: Len; h?: Len; r?: Len; style?: CSSProperties }) {
  return <span className="sk" style={{ width: w, height: h, borderRadius: r, ...style }} />
}

export function SkWrap({ label = '불러오는 중입니다', className = '', children }: { label?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`sk-wrap ${className}`} role="status" aria-live="polite">
      <span className="sk-sr">{label}</span>
      <div className="sk-body" aria-hidden>{children}</div>
    </div>
  )
}

// 수치 머리: 라벨, 큰 숫자, 보조 문구
export function SkFigure() {
  return (
    <div className="sk-col">
      <Sk w="34%" h={15} />
      <Sk w="46%" h={34} />
      <Sk w="62%" h={14} />
    </div>
  )
}

// 핵심 수치 카드 n개(.kpis 격자 그대로 사용)
export function SkKpis({ n = 4 }: { n?: number }) {
  return (
    <SkWrap className="kpis sk-kpis">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="kpi"><Sk w="45%" h={15} /><Sk w="38%" h={34} /><Sk w="70%" h={14} /></div>
      ))}
    </SkWrap>
  )
}

// 목록 행: 머리 줄, 본문 2줄, 오른쪽 버튼 자리
export function SkRows({ rows = 3, action = false, tall = false }: { rows?: number; action?: boolean; tall?: boolean }) {
  return (
    <div className="sk-rows">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={tall ? 'sk-row tall' : 'sk-row'}>
          <div className="sk-col">
            <Sk w="28%" h={14} />
            <Sk w={`${62 - i * 7}%`} h={18} />
            <Sk w="88%" h={14} />
            {tall && <Sk w="74%" h={14} />}
          </div>
          {action && <Sk w={112} h={44} />}
        </div>
      ))}
    </div>
  )
}

// 선 그래프 영역: 범례 줄, 가로 눈금선 4개, 아래 축
export function SkChart({ h = 220 }: { h?: number }) {
  return (
    <div className="sk-col">
      <div className="sk-line"><Sk w={88} h={14} /><Sk w={132} h={14} /></div>
      <div className="sk-chart" style={{ height: h }}>
        {[0, 1, 2, 3].map((i) => <i key={i} />)}
        <Sk w="100%" h={2} r={1} style={{ position: 'absolute', bottom: 0 }} />
      </div>
      <div className="sk-line"><Sk w={28} h={12} /><Sk w={28} h={12} /><Sk w={28} h={12} /><Sk w={28} h={12} /></div>
    </div>
  )
}

// 가로 막대 비교(건물별 사용량)
export function SkBars({ rows = 4 }: { rows?: number }) {
  return (
    <div className="sk-rows">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-col sk-bar">
          <div className="sk-line"><Sk w={72} h={17} /><Sk w={96} h={22} /></div>
          <Sk w={`${92 - i * 18}%`} h={16} r={4} />
          <Sk w="58%" h={13} />
        </div>
      ))}
    </div>
  )
}

// 요일×시간 격자 7×24
export function SkHeatmap() {
  return (
    <div className="sk-col">
      <div className="sk-line">{[0, 1, 2, 3, 4].map((i) => <Sk key={i} w={56} h={14} />)}</div>
      <div className="sk-heat">{Array.from({ length: 7 * 24 }, (_, i) => <span key={i} className="sk" />)}</div>
    </div>
  )
}

// 사용 구성 흐름도: 건물, 층, 용도 3열
export function SkFlow() {
  return (
    <div className="sk-flow">
      <Sk w={14} h="100%" r={3} />
      <div className="sk-col sk-flow-mid">{[44, 32, 24].map((h) => <Sk key={h} w={14} h={`${h}%`} r={3} />)}</div>
      <div className="sk-col sk-flow-end">{[48, 26, 18, 8].map((h) => <div key={h} className="sk-line" style={{ height: `${h}%` }}><Sk w={14} h="100%" r={3} /><Sk w={64} h={14} /></div>)}</div>
    </div>
  )
}

// 표 rows×cols
export function SkTable({ rows = 4, cols = 3 }: { rows?: number; cols?: number }) {
  return (
    <div className="sk-table" style={{ gridTemplateColumns: `2fr repeat(${cols - 1}, 1fr)` }}>
      {Array.from({ length: rows * cols }, (_, i) => <Sk key={i} w={i % cols === 0 ? '70%' : '50%'} h={15} />)}
    </div>
  )
}

// 대화 말풍선: AI 왼쪽, 사용자 오른쪽 교대
export function SkBubbles() {
  return (
    <SkWrap label="대화 기록을 불러오는 중입니다" className="sk-bubbles">
      <Sk w="58%" h={44} r="14px 14px 4px 14px" style={{ alignSelf: 'flex-end' }} />
      <div className="sk-bubble"><Sk w="40%" h={14} /><Sk w="92%" h={16} /><Sk w="76%" h={16} /></div>
      <Sk w="46%" h={44} r="14px 14px 4px 14px" style={{ alignSelf: 'flex-end' }} />
      <div className="sk-bubble"><Sk w="36%" h={14} /><Sk w="88%" h={16} /></div>
    </SkWrap>
  )
}

// 층 목록 버튼 n개
export function SkFloors({ n = 2 }: { n?: number }) {
  return (
    <SkWrap label="층 정보를 불러오는 중입니다" className="sk-floors">
      <Sk w={24} h={14} style={{ marginLeft: 12 }} />
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="sk-floor"><div className="sk-line"><Sk w={34} h={24} /><Sk w={64} h={16} /></div><div className="sk-line"><Sk w={52} h={14} /><Sk w={80} h={14} /></div></div>
      ))}
    </SkWrap>
  )
}

// 3D 도면 자리: 바닥판 위 호실 블록
export function SkPlan() {
  return (
    <SkWrap label="3D 도면을 불러오는 중입니다" className="sk-plan">
      <div className="sk-plate">
        {[[8, 10, 26, 22], [36, 8, 18, 30], [58, 12, 30, 18], [10, 40, 20, 26], [34, 44, 34, 14], [72, 36, 18, 30], [16, 72, 30, 16], [52, 66, 24, 22]].map(([l, t, w, h]) => (
          <span key={`${l}-${t}`} className="sk" style={{ position: 'absolute', left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%`, borderRadius: 4 }} />
        ))}
      </div>
    </SkWrap>
  )
}

// 세로 시간표: 시각 열과 1시간 칸, 스케줄 칸 2개
export function SkTimetable() {
  return (
    <div className="sk-col">
      <div className="sk-line" style={{ justifyContent: 'flex-start' }}><Sk w={48} h={22} /><Sk w={72} h={14} /><Sk w={72} h={14} /></div>
      <div className="sk-tt">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="sk-tt-row"><Sk w={36} h={14} /></div>)}
        <Sk w="38%" h="62%" r={8} style={{ position: 'absolute', left: 72, top: '30%' }} />
        <Sk w="38%" h="40%" r={8} style={{ position: 'absolute', left: 'calc(72px + 40%)', top: '55%' }} />
      </div>
    </div>
  )
}
