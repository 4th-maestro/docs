import { AlertCircle, AlertTriangle, CheckCircle2, Clock, LocateFixed, Power, Undo2, type LucideIcon } from 'lucide-react'
import type { Decision, OpsAction, OpsSettings } from './types'
import './ops.css'

// 자동 운영 알림: AI 운영 도우미 대화 안에 AI가 보낸 알림 카드로 표시
// - 카드 본문은 서버 문구(message) 그대로. 버튼은 상태별(응답 대기: 수락·거절, 껐음: 되돌리기)
// - 처리 기록(거절, 되돌림, 만료)은 흐리게, 버튼 없음
const LOOK: Record<Decision['status'], { label: string; icon: LucideIcon; tone: string }> = {
  pending: { label: '제안', icon: AlertCircle, tone: 'caution' },
  applied: { label: '자동으로 끔', icon: Power, tone: 'ok' },
  accepted: { label: '수락해서 끔', icon: CheckCircle2, tone: 'ok' },
  alert: { label: '이상 알림', icon: AlertTriangle, tone: 'danger' },
  rejected: { label: '거절함', icon: Clock, tone: 'done' },
  reverted: { label: '되돌림', icon: Undo2, tone: 'done' },
  expired: { label: '만료됨', icon: Clock, tone: 'done' },
}
const JEV = { empty: '빈 방', occupied: '사용 중', uncertain: '확인 필요' }
const hhmm = (iso?: string | null) => (iso ? iso.slice(11, 16) : '')

// 근거 한 줄: AI(Jev) 판단, 운영 종료 후 경과, 빈 채 운전 시간, 마지막 재실, 이상 알림은 현재·설정 온도
function facts(d: Decision): string {
  const out: string[] = []
  if (d.jev) {
    const p = d.jev.probabilities?.[d.jev.choice] ?? d.jev.confidence
    out.push(`AI 판단 ${JEV[d.jev.choice]} ${Math.round(p * 100)}%`)
  }
  const f = d.evidence?.facts
  if (f?.minutesSinceClose != null && f.inOperatingHours === false) out.push(`운영 종료 후 ${f.minutesSinceClose}분`)
  if (f?.idleOnMinutes != null) out.push(`빈 채 운전 ${f.idleOnMinutes}분`)
  if (f?.lastOccupiedAt) out.push(`마지막 재실 ${f.lastOccupiedAt}`)
  if (d.evidence?.temp != null && d.evidence.setpoint != null) out.push(`현재 ${d.evidence.temp}℃, 설정 ${d.evidence.setpoint}℃`)
  return out.join(', ')
}

export function OpsCard({ d, now, busy, onAct, onLocate }: { d: Decision; now: number; busy: boolean; onAct(a: OpsAction): void; onLocate(id: string): void }) {
  const look = LOOK[d.status]
  const done = look.tone === 'done'
  const left = d.status === 'pending' && d.expiresAt ? Math.max(0, Math.ceil((Date.parse(d.expiresAt) - now) / 60_000)) : null
  const why = done ? '' : facts(d)
  return (
    <div className={`msg ai ops ops-${look.tone}`} role="article" aria-label={`자동 운영 ${look.label}, ${d.floor} ${d.roomName}`}>
      <div className="ops-head">
        <span className="ops-label"><look.icon size={16} aria-hidden />{look.label}</span>
        <span className="ops-time">{hhmm(d.createdAt)}{left != null && `, ${left}분 남음`}</span>
      </div>
      <p className="msg-text">{d.message}</p>
      {why && <p className="ops-why">{why}</p>}
      {d.roomId && !done && (
        <button className="chat-mini ops-locate" onClick={() => onLocate(d.roomId)}><LocateFixed size={16} aria-hidden />3D에서 {d.roomName} 보기</button>
      )}
      {d.status === 'pending' && (
        <div className="btns ops-btns">
          <button className="secondary" disabled={busy} onClick={() => onAct('reject')}>거절</button>
          <button className="primary" disabled={busy} onClick={() => onAct('accept')}>수락</button>
        </div>
      )}
      {(d.status === 'applied' || d.status === 'accepted') && (
        <div className="ops-btns one">
          <button className="secondary" disabled={busy} onClick={() => onAct('undo')}><Undo2 size={16} aria-hidden />되돌리기</button>
        </div>
      )}
    </div>
  )
}

// 대화 마지막 상태 메시지: 자동 운영 스위치(판매사·고객사 관리자만 변경), 응답 대기 수, 마지막 변경 시각
export function OpsStatusCard({ s, pending, canToggle, busy, notice, onToggle }: { s: OpsSettings; pending: number; canToggle: boolean; busy: boolean; notice: string; onToggle(v: boolean): void }) {
  return (
    <div className="msg ai ops ops-status" role="group" aria-label="자동 운영 설정">
      <div className="ops-head">
        <span className="ops-label">자동 운영</span>
        <button
          className={s.autoApply ? 'ops-switch on' : 'ops-switch'} role="switch" aria-checked={s.autoApply} aria-label="자동 운영"
          disabled={!canToggle || busy} onClick={() => onToggle(!s.autoApply)}
        >
          <span className="ops-switch-text">{s.autoApply ? 'ON' : 'OFF'}</span>
          <span className="ops-track" aria-hidden><i /></span>
        </button>
      </div>
      <p className="msg-text">{s.autoApply ? '확실한 빈 방은 자동으로 끕니다. 언제든 되돌릴 수 있습니다.' : '끄기 전에 제안으로 먼저 알려 드립니다.'}</p>
      <p className="ops-why">응답 대기 {pending}건{s.updatedAt ? `, 마지막 변경 ${hhmm(s.updatedAt)}` : ''}</p>
      {!canToggle && <p className="ops-why">자동 운영 설정은 판매사 관리자와 고객사 관리자만 바꿀 수 있습니다.</p>}
      {notice && <p className="ops-notice" role="status">{notice}</p>}
    </div>
  )
}
