import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { hhmm } from './usePoll'
import { SkWrap } from '../skeleton/Skeleton'
import './panels.css'

// 패널 공통 틀: 제목, 데이터 기준 시각(디자인 시스템 6절), 목업 표시, 로딩 스켈레톤, 빈 상태, 오류
export default function Panel(props: {
  title: string
  at?: string
  mock?: boolean
  error: string
  loading: boolean
  stale?: boolean
  empty?: string | false
  // 패널 모양을 닮은 스켈레톤(src/skeleton), 없으면 기본 막대 3개
  skeleton?: ReactNode
  children?: ReactNode
}) {
  const { title, at, mock, error, loading, stale, empty, skeleton, children } = props
  return (
    <section className={stale ? 'card pn stale' : 'card pn'} aria-label={title} aria-busy={loading || stale}>
      <div className="pn-head">
        <h2>{title}</h2>
        <span className="pn-meta">
          {mock && <span className="pn-mock">목업</span>}
          {at && <time dateTime={at}>기준 {hhmm(at)}</time>}
        </span>
      </div>
      {error && <p className="pn-error" role="alert"><AlertTriangle size={14} aria-hidden />{error}</p>}
      {loading ? (
        skeleton ? <SkWrap>{skeleton}</SkWrap> : <div className="pn-skel" aria-hidden><i /><i /><i /></div>
      ) : empty ? (
        <p className="pn-empty fade-in">{empty}</p>
      ) : <div className="pn-body fade-in">{children}</div>}
    </section>
  )
}
