import { useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AlertCircle, AlertTriangle, ArrowUp, Check, ExternalLink, Info, MessageSquareText, Trash2 } from 'lucide-react'
import type { Chart, Draft, Room, Source } from '../types'
import ChartView, { ChartModal } from './ChartView'
import { ThinkingBadge, ThinkingPanel } from './ThinkingPanel'
import type { AskState, Step } from './types'
import './chat.css'
import { SkBubbles } from '../skeleton/Skeleton'
import OpsDraftCard from '../ops/OpsDraftCard'
import { OpsCard, OpsStatusCard } from '../ops/OpsMessages'
import type { Decision, OpsAction, OpsDraft, OpsOverview } from '../ops/types'

// 대화 메시지: 서버 기록(GET /chat)과 화면에서 추가한 메시지 공용
// - draftState: pending(저장 대기, 초안 카드 표시), saved(저장됨), closed(닫음·지난 기록)
export type ChatMsg = {
  id: string
  role: 'user' | 'assistant'
  text: string
  steps?: Step[]
  highlight?: string[]
  opsDraft?: OpsDraft | null
  opsDraftActive?: boolean
  opsDraftResult?: string
  draft?: Draft | null
  draftState?: 'pending' | 'saved' | 'closed'
  mock?: boolean
  note?: boolean
  // 화면에서 방금 추가한 메시지: 아래에서 올라오며 등장
  fresh?: boolean
  // 도구 결과 그래프(서버 생성), 말풍선 안 표시와 크게 보기
  charts?: Chart[]
  // 근거 문서(서버 생성), 그래프 아래 목록 표시
  sources?: Source[]
}

const ACTION = { off: '운전 OFF', on: '운전 ON', setpoint: '설정온도 변경' }
const DONE: AskState = { status: 'done', steps: [], answer: '', result: null, startedAt: 0, elapsedMs: 0, transport: 'ws' }
const secs = (steps: Step[]) => (steps.reduce((s, x) => s + (x.ms ?? 0), 0) / 1000).toFixed(1)

// 자동 운영 알림(대화 안 AI 알림 카드와 마지막 상태 메시지). 값이 없으면 표시하지 않음
export type OpsView = {
  overview: OpsOverview
  canToggle: boolean
  busy: string | null
  notice: string
  onAct: (d: Decision, action: OpsAction) => void
  onToggle: (v: boolean) => void
  onLocate: (id: string) => void
}

// 대화 시각: 서버 기록 id는 "ISO 시각#순번", 화면에서 만든 id는 Date.now() 36진수로 시작. 읽지 못하면 앞 메시지 시각
function msgTimes(ms: ChatMsg[]): number[] {
  let prev = 0
  return ms.map((m) => {
    const t = /^\d{4}-/.test(m.id) ? Date.parse(m.id.split('#')[0]) : parseInt(m.id.slice(0, 8), 36)
    prev = Number.isFinite(t) && t > 0 ? t : prev
    return prev
  })
}

type Props = {
  ai: AskState
  onOpsDone: (m: ChatMsg, notice: string) => void
  ops?: OpsView | null
  messages: ChatMsg[]
  rooms: Room[]
  suggestions: { icon: LucideIcon; text: string }[]
  busy: boolean
  history: 'loading' | 'server' | 'local'
  onSend: (text: string) => void
  onClear: () => void
  onSave: (m: ChatMsg) => void
  onClose: (m: ChatMsg) => void
  onFocus: (ids: string[]) => void
  onSelect: (id: string) => void
}

// AI 운영 도우미(메신저형): 위는 대화 목록, 아래는 입력창
// - 자동 스크롤: 사용자가 아래쪽(120px 이내)을 보고 있을 때만, 이전 대화를 읽는 중에는 유지
export default function ChatPanel({ onOpsDone, ai, ops, messages, rooms, suggestions, busy, history, onSend, onClear, onSave, onClose, onFocus, onSelect }: Props) {
  const [text, setText] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [big, setBig] = useState<Chart | null>(null)
  const log = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const running = ai.status === 'running'
  // 제안 남은 시간 표시용 현재 시각(30초마다 갱신)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const live = running || (ai.status === 'error' && messages.at(-1)?.role === 'user')

  // 아래 붙임 여부는 스크롤할 때 기록(내용이 늘어난 뒤 재면 새 알림 카드 높이 때문에 아래를 보던 중에도 붙지 않음)
  const stick = useRef(true)
  useEffect(() => {
    const el = log.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages.length, ai.answer, ai.steps.length, ai.status, ops?.overview.decisions.length, ops?.overview.pendingCount])

  // 대화와 자동 운영 알림을 시각 순으로 합침(같은 시각이면 대화 먼저). 알림은 서버가 최신순으로 주므로 뒤집어 오래된 것부터
  const decisions = ops ? [...ops.overview.decisions].reverse() : []
  const times = msgTimes(messages)
  const timeline: ({ k: 'm'; m: ChatMsg } | { k: 'd'; d: Decision })[] = []
  let di = 0
  messages.forEach((m, i) => {
    while (di < decisions.length && Date.parse(decisions[di].createdAt) < times[i]) timeline.push({ k: 'd', d: decisions[di++] })
    timeline.push({ k: 'm', m })
  })
  while (di < decisions.length) timeline.push({ k: 'd', d: decisions[di++] })

  function send(q = text) {
    if (!q.trim() || running) return
    onSend(q.trim())
    setText('')
    if (input.current) input.current.style.height = ''
    requestAnimationFrame(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight })
  }

  return (
    <section className="card chat" aria-label="AI 운영 도우미">
      <div className="chat-head">
        <h2>AI 운영 도우미</h2>
        {!!ops?.overview.pendingCount && <span className="ops-badge" aria-label={`자동 운영 응답 대기 ${ops.overview.pendingCount}건`}><AlertCircle size={16} aria-hidden />제안 {ops.overview.pendingCount}</span>}
        <ThinkingBadge state={ai} />
        {messages.length > 0 && (confirmClear ? (
          <span className="chat-confirm">
            <button className="chat-mini danger" onClick={() => { onClear(); setConfirmClear(false) }}>지우기</button>
            <button className="chat-mini" onClick={() => setConfirmClear(false)}>취소</button>
          </span>
        ) : (
          <button className="icon" onClick={() => setConfirmClear(true)} aria-label="대화 지우기" title="대화 지우기"><Trash2 size={18} /></button>
        ))}
      </div>

      <div className="chat-log" ref={log} role="log" aria-live="polite" aria-busy={running}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120 }}>
        {history === 'loading' && <SkBubbles />}
        {history !== 'loading' && messages.length === 0 && decisions.length === 0 && !live && (
          <div className="chat-empty">
            <MessageSquareText size={28} aria-hidden />
            <p>층, 용도, 시각을 넣어 질문하면 AI가 조회하거나 스케줄 초안을 만듭니다.</p>
            <ul className="suggest">
              {suggestions.map(({ icon: Icon, text: q }) => (
                <li key={q}><button onClick={() => send(q)}><Icon size={18} aria-hidden />{q}</button></li>
              ))}
            </ul>
          </div>
        )}
        {history !== 'loading' && timeline.map((x) => (x.k === 'd'
          ? <OpsCard key={x.d.decisionId} d={x.d} now={now} busy={ops!.busy === x.d.decisionId} onAct={(a) => ops!.onAct(x.d, a)} onLocate={ops!.onLocate} />
          : x.m.role === 'user'
            ? <div key={x.m.id} className={x.m.fresh ? 'msg me rise-in' : 'msg me'}><p>{x.m.text}</p></div>
            : <Assistant onOpsDone={onOpsDone} key={x.m.id} m={x.m} rooms={rooms} busy={busy} onSave={onSave} onClose={onClose} onFocus={onFocus} onSelect={onSelect} onExpand={setBig} />))}
        {live && (
          <div className="msg ai">
            <ThinkingPanel state={ai} />
          </div>
        )}
        {ops && <OpsStatusCard s={ops.overview.settings} pending={ops.overview.pendingCount} canToggle={ops.canToggle} busy={ops.busy === 'settings'} notice={ops.notice} onToggle={ops.onToggle} />}
      </div>

      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send() }}>
        <label htmlFor="chat-q" className="chat-sr">AI에게 질문</label>
        <textarea
          id="chat-q" ref={input} rows={1} value={text} maxLength={500} placeholder="질문을 입력하십시오"
          onChange={(e) => {
            setText(e.target.value)
            e.target.style.height = ''
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
          }}
          // Enter 전송, Shift+Enter 줄바꿈. 한글 조합 중 Enter는 조합 확정이라 전송하지 않음
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
        />
        <button className="orb" type="submit" disabled={running || !text.trim()} aria-label="질문 보내기"><ArrowUp size={20} /></button>
      </form>
      {big && <ChartModal chart={big} onClose={() => setBig(null)} />}
      <p className="chat-hint">AI 해석은 틀릴 수 있습니다. 제어 요청은 확인 후에만 저장됩니다.{history === 'local' ? ' 대화 기록은 이 화면에만 남습니다.' : ''}</p>
    </section>
  )
}

function Assistant({ onOpsDone, m, rooms, busy, onSave, onClose, onFocus, onSelect, onExpand }: { m: ChatMsg; rooms: Room[]; busy: boolean; onExpand: (c: Chart) => void } & Pick<Props, 'onOpsDone' | 'onSave' | 'onClose' | 'onFocus' | 'onSelect'>) {
  const byId = new Map(rooms.map((r) => [r.id, r]))
  const targets = (m.highlight ?? []).map((id) => byId.get(id)).filter((r): r is Room => !!r)
  const d = m.draft
  const sources = m.sources ?? []
  return (
    <div className={`msg ai${m.note ? ' note' : ''}${m.fresh ? ' rise-in' : ''}`}>
      {m.mock && <span className="tag">목업 응답</span>}
      {!!m.steps?.length && (
        <details className="msg-steps">
          <summary><Check size={16} aria-hidden />처리 {m.steps.length}단계, {secs(m.steps)}초</summary>
          <ThinkingPanel state={{ ...DONE, steps: m.steps }} />
        </details>
      )}
      <p className="msg-text">{m.note && <span className="pop-in"><Check size={16} aria-hidden /></span>}{m.text}</p>
      {m.opsDraft && <OpsDraftCard draft={m.opsDraft} active={!!m.opsDraftActive} result={m.opsDraftResult} onDone={(notice) => onOpsDone(m, notice)} />}
      {m.charts?.map((c, i) => <ChartView key={`${m.id}-${i}`} chart={c} onExpand={() => onExpand(c)} />)}
      {sources.length > 0 && (
        <div className="msg-sources">
          <h3>근거</h3>
          <ul>
            {sources.map((s, i) => (
              <li key={i}>
                {/* 서버 값이라 http(s) 주소만 링크, 그 외는 문서명만 표시 */}
                {/^https?:\/\//i.test(s.url) ? (
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    <span>{s.title}{s.date ? `(${s.date})` : ''}</span>
                    <ExternalLink size={16} aria-hidden />
                  </a>
                ) : <span className="src-title">{s.title}{s.date ? `(${s.date})` : ''}</span>}
                {s.checked && <p>원문 확인일 {s.checked}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d && m.draftState === 'pending' && (
        <div className="draft fade-in">
          <h3>스케줄 초안</h3>
          <dl>
            <dt>대상</dt><dd>{d.roomIds.length}곳({d.floor === 'all' ? '전체 층' : d.floor}, {d.use === 'all' ? '전체 용도' : d.use})</dd>
            <dt>조건</dt><dd>{d.time} 이후{d.condition === 'unused' ? ', 재실 없을 때' : ''}</dd>
            <dt>동작</dt><dd>{ACTION[d.action]}{d.setpoint ? ` ${d.setpoint}℃` : ''}</dd>
            <dt>예상 절감</dt><dd>{d.estimatedSavingKwh}kWh/일(가상)</dd>
          </dl>
          {/* 저장 안내는 AI 답변 대신 카드에 고정 표시(답변 3문장 규칙, 2026-11-20 평가) */}
          <p className="draft-note"><Info size={16} aria-hidden />아직 저장되지 않았습니다. 스케줄 생성을 누르면 저장되고, 실제 설비는 제어하지 않습니다.</p>
          <div className="btns">
            <button className="secondary" onClick={() => onClose(m)} disabled={busy}>취소</button>
            <button className="primary" onClick={() => onSave(m)} disabled={busy}>스케줄 생성</button>
          </div>
        </div>
      )}
      {d && m.draftState !== 'pending' && (
        <p className="msg-draft fade-in">{m.draftState === 'saved' ? <span className="pop-in"><Check size={16} aria-hidden /></span> : null}스케줄 초안 {d.time} {ACTION[d.action]}, {d.roomIds.length}곳({m.draftState === 'saved' ? '저장됨' : '닫음'})</p>
      )}
      {targets.length > 0 && (
        <div className="msg-rooms">
          <button className="chat-mini" onClick={() => onFocus(m.highlight!)}>3D에서 대상 {m.highlight!.length}곳 보기</button>
          <ul>
            {targets.slice(0, 6).map((r) => (
              <li key={r.id}>
                <button onClick={() => onSelect(r.id)}>
                  {r.anomaly && <AlertTriangle size={16} aria-label="이상" />}
                  <span>{r.name}</span>
                  <span className="num">{r.onOff ? `${r.powerKw}kW` : 'OFF'}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
