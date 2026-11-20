import { Check, Circle, CircleAlert, LoaderCircle } from 'lucide-react'
import { STEP_ORDER, type AskState, type Step } from './types'
import './thinking.css'

// 대기 단계 표시용 이름(서버 query.py LABELS와 같은 값)
const LABELS: Record<string, string> = { understand: '요청 해석', query: '데이터 조회', review: '결과 검토', answer: '답변 작성' }
const STATUS = { active: '진행 중', done: '완료', error: '오류', pending: '대기' }
const ICON = { active: LoaderCircle, done: Check, error: CircleAlert, pending: Circle }
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}초`

type Row = Omit<Step, 'status'> & { status: Step['status'] | 'pending' }

// AI 사고 과정 패널: 단계 목록, 조건 칩, 스트리밍 답변
// - 대기 단계: WebSocket 진행 중에만 마지막 수신 단계 뒤의 단계를 빈 원으로 표시(일어나지 않은 단계는 만들지 않음)
export function ThinkingPanel({ state, query }: { state: AskState; query?: string }) {
  if (state.status === 'idle') return null
  const running = state.status === 'running'
  const now = state.startedAt + state.elapsedMs
  const last = Math.max(-1, ...state.steps.map((s) => STEP_ORDER.indexOf(s.id as never)))
  const pending: Row[] = running && state.transport === 'ws' ? STEP_ORDER.slice(last + 1).map((id) => ({ id, status: 'pending', label: LABELS[id] })) : []
  return (
    <div className="thinking" aria-live="polite" aria-busy={running}>
      {query && <p className="th-query">{query}</p>}
      {state.steps.length + pending.length > 0 && (
        <ol className="th-steps">
          {[...state.steps, ...pending].map((s) => <StepRow key={s.id} s={s} now={now} />)}
        </ol>
      )}
      {state.answer && (
        <p className="th-answer">
          {state.answer}
          {running && <span className="th-caret" aria-hidden />}
        </p>
      )}
      {state.status === 'error' && <p className="th-error" role="alert">{state.error}</p>}
    </div>
  )
}

function StepRow({ s, now }: { s: Row; now: number }) {
  const Icon = ICON[s.status]
  const time = s.status === 'active' && s.at ? sec(Math.max(0, now - s.at)) : s.ms != null ? sec(s.ms) : ''
  return (
    <li className={`th-step ${s.status}`}>
      <span className="th-icon"><Icon size={16} aria-hidden /></span>
      <div className="th-body">
        <div className="th-line">
          <span className="th-label">{s.label}</span>
          <span className="th-sr">{STATUS[s.status]}</span>
          {time && <span className="th-sec">{time}</span>}
        </div>
        {s.detail && <p className="th-detail">{s.detail}</p>}
        {!!s.chips?.length && (
          <ul className="th-chips" aria-label="반영한 조건">
            {s.chips.map((c) => <li key={c}>{c}</li>)}
          </ul>
        )}
      </div>
    </li>
  )
}

// 검색창 옆 진행 표시(예: AI 분석 중 2.1초), 진행 중일 때만 표시
export function ThinkingBadge({ state }: { state: AskState }) {
  if (state.status !== 'running') return null
  return (
    <span className="th-badge">
      <LoaderCircle size={14} aria-hidden />
      AI 분석 중 <span className="th-sec" aria-hidden>{sec(state.elapsedMs)}</span>
    </span>
  )
}
