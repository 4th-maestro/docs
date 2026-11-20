import type { ReactNode } from 'react'
import { AlertTriangle, BarChart3, CheckCircle2, ChevronRight, Info, TrendingDown } from 'lucide-react'
import { hhmm } from '../panels/usePoll'
import type { BuildingCard, Level, Portfolio as Data } from '../types'
import './portfolio.css'

// 전체 현황: 건물 카드는 API 순서(이상, 절감 검토, 정상 순)로 표시, 상태는 색·아이콘·글자 병행(디자인 시스템 1절)
const LEVEL: Record<Level, { Icon: typeof AlertTriangle; text: (b: BuildingCard) => string }> = {
  alert: { Icon: AlertTriangle, text: (b) => `이상 ${b.now.anomaly}건` },
  warn: { Icon: TrendingDown, text: () => '절감 검토' },
  ok: { Icon: CheckCircle2, text: () => '정상' },
}
const fmt = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 })
const n = (v: number) => fmt.format(v)
// 전체 합계는 정수: 390px 화면 2열 요약 칸(약 147px)에서 수치와 단위가 한 줄에 표시되도록
const n0 = (v: number) => fmt.format(Math.round(v))

// compare: 건물 비교 영역(다른 브랜치의 BuildingCompare), 카드 목록 아래에 표시
export default function Portfolio({ data, error, compare }: { data: Data | null; error: string; compare?: ReactNode }) {
  const list = data?.buildings ?? []
  const sum = (f: (b: BuildingCard) => number) => list.reduce((s, b) => s + f(b), 0)
  const anomaly = sum((b) => b.now.anomaly)
  return (
    <main className="pf">
      <div className="pf-head">
        <h1>전체 현황</h1>
        {data && (
          <span className="pf-meta">
            {data.mock && <span className="tag">목업</span>}
            <time dateTime={data.generatedAt}>기준 {hhmm(data.generatedAt)}</time>
          </span>
        )}
      </div>
      {data?.virtual && (
        <div className="banner" role="note">
          <Info size={16} aria-hidden />
          <span>가상 데이터로 채운 화면입니다. 실제 설비 수치가 아닙니다.{data.mock ? ' API에 연결하지 못해 목업 데이터를 표시합니다.' : ''}</span>
        </div>
      )}
      {error && !data && <p className="error" role="alert">건물 목록을 불러오지 못했습니다({error}).</p>}
      {!data && !error && <ul className="pf-grid" aria-hidden>{[0, 1, 2, 3].map((i) => <li key={i} className="pf-card pf-skel" />)}</ul>}
      {data && (
        <>
          <section className="kpis" aria-label="전체 건물 요약">
            <div className="kpi">
              <span className="klabel">전체 이상</span>
              <span className={anomaly ? 'kval bad' : 'kval'}>{anomaly}<small>건</small></span>
              <span className="ksub">설정온도 미도달 HVAC</span>
            </div>
            <div className="kpi">
              <span className="klabel">오늘 사용량</span>
              <span className="kval">{n0(sum((b) => b.todayKwh))}<small>kWh</small></span>
              <span className="ksub">0시부터 {hhmm(data.generatedAt)}까지</span>
            </div>
            <div className="kpi">
              <span className="klabel">절감 가능</span>
              <span className="kval">{n0(sum((b) => b.savingKwh))}<small>kWh/일</small></span>
              <span className="ksub">추천 스케줄 적용 시(가상)</span>
            </div>
            <div className="kpi">
              <span className="klabel">건물</span>
              <span className="kval">{list.length}<small>곳</small></span>
              <span className="ksub">가상 건물 {list.filter((b) => b.virtual).length}곳 포함</span>
            </div>
          </section>
          <h2>건물별 현황(점검 필요 순)</h2>
          <ul className="pf-grid">{list.map((b) => <Card key={b.id} b={b} />)}</ul>
        </>
      )}
      {compare}
    </main>
  )
}

function Card({ b }: { b: BuildingCard }) {
  const { Icon, text } = LEVEL[b.level]
  return (
    <li className="pf-card">
      <div className="pf-title">
        <h3>
          {/* 카드 전체 누름 영역: 링크의 ::after가 카드를 덮음(카드 안 다른 링크는 위에 배치) */}
          <a className="pf-enter" href={`#/b/${b.id}`} aria-label={`${b.name} 운영 화면 열기`}>{b.name}<ChevronRight size={20} aria-hidden /></a>
        </h3>
        {b.virtual && <span className="tag" title={b.basis}>가상 건물</span>}
      </div>
      <p className={`pf-level ${b.level}`}><Icon size={18} aria-hidden />{text(b)}</p>
      <dl className="pf-kv">
        <dt>현재 전력</dt><dd>{n(b.now.powerKw)}kW</dd>
        <dt>오늘 사용량</dt><dd>{n(b.todayKwh)}kWh</dd>
        <dt>절감 가능</dt><dd>{n(b.savingKwh)}kWh/일</dd>
        <dt>용도</dt><dd>{b.use}</dd>
        <dt>규모</dt><dd>{b.floors.join(', ')}, 호실 {b.roomCount}곳, {n0(b.areaM2)}㎡</dd>
      </dl>
      <a className="pf-sub" href={`#/b/${b.id}/energy`} aria-label={`${b.name} 전력 분석`}><BarChart3 size={18} aria-hidden />전력 분석</a>
    </li>
  )
}
