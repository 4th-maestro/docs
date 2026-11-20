import { useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AlertTriangle, ArrowUp, Check, Info, MessageSquareText, Trash2 } from 'lucide-react'
import type { Chart, Draft, Room } from '../types'
import ChartView, { ChartModal } from './ChartView'
import { ThinkingBadge, ThinkingPanel } from './ThinkingPanel'
import type { AskState, Step } from './types'
import './chat.css'
import { SkBubbles } from '../skeleton/Skeleton'

// 대화 메시지: 서버 기록(GET /chat)과 화면에서 추가한 메시지 공용
// - draftState: pending(저장 대기, 초안 카드 표시), saved(저장됨), closed(닫음·지난 기록)
export type ChatMsg = {
  id: string
  role: 'user' | 'assistant'
  text: string
  steps?: Step[]
  highlight?: string[]
  draft?: Draft | null
  draftState?: 'pending' | 'saved' | 'closed'
  mock?: boolean
  note?: boolean
  // 화면에서 방금 추가한 메시지: 아래에서 올라오며 등장
  fresh?: boolean
  // 도구 결과 그래프(서버 생성), 말풍선 안 표시와 크게 보기
  charts?: Chart[]
}

const ACTION = { off: '운전 OFF', on: '운전 ON', setpoint: '설정온도 변경' }
const DONE: AskState = { status: 'done', steps: [], answer: '', result: null, startedAt: 0, elapsedMs: 0, transport: 'ws' }
const secs = (steps: Step[]) => (steps.reduce((s, x) => s + (x.ms ?? 0), 0) / 1000).toFixed(1)

type Props = {
  ai: AskState
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
export default function ChatPanel({ ai, messages, rooms, suggestions, busy, history, onSend, onClear, onSave, onClose, onFocus, onSelect }: Props) {
  const [text, setText] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [big, setBig] = useState<Chart | null>(null)
  const log = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const running = ai.status === 'running'
  const live = running || (ai.status === 'error' && messages.at(-1)?.role === 'user')

  useEffect(() => {
    const el = log.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [messages.length, ai.answer, ai.steps.length, ai.status])

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

      <div className="chat-log" ref={log} role="log" aria-live="polite" aria-busy={running}>
        {history === 'loading' && <SkBubbles />}
        {history !== 'loading' && messages.length === 0 && !live && (
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
        {messages.map((m) => (m.role === 'user'
          ? <div key={m.id} className={m.fresh ? 'msg me rise-in' : 'msg me'}><p>{m.text}</p></div>
          : <Assistant key={m.id} m={m} rooms={rooms} busy={busy} onSave={onSave} onClose={onClose} onFocus={onFocus} onSelect={onSelect} onExpand={setBig} />))}
        {live && (
          <div className="msg ai">
            <ThinkingPanel state={ai} />
          </div>
        )}
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

function Assistant({ m, rooms, busy, onSave, onClose, onFocus, onSelect, onExpand }: { m: ChatMsg; rooms: Room[]; busy: boolean; onExpand: (c: Chart) => void } & Pick<Props, 'onSave' | 'onClose' | 'onFocus' | 'onSelect'>) {
  const byId = new Map(rooms.map((r) => [r.id, r]))
  const targets = (m.highlight ?? []).map((id) => byId.get(id)).filter((r): r is Room => !!r)
  const d = m.draft
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
      {m.charts?.map((c, i) => <ChartView key={`${m.id}-${i}`} chart={c} onExpand={() => onExpand(c)} />)}
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
