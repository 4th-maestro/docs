import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CirclePause, History, UserRound } from 'lucide-react'
import { listAudit, removeMember, setMemberRole, type AuditItem, type Company, type Member, type Role } from '../api'
import { ROLE } from '../auth/me'
import { SkRows, SkWrap } from '../skeleton/Skeleton'
import { badMail, day, FIELDS, msg, type Form } from './form'

// 기업 화면 공용 컴포넌트: 판매사 기업 상세(AdminPage)와 고객사 기업 설정(SettingsPage)

export function Fields({ value, onChange }: { value: Form; onChange: (f: Form) => void }) {
  const bad = badMail(value)
  return (
    <div className="adm-fields">
      {FIELDS.map((f) => (
        <label key={f.key} className={f.key === 'address' ? 'wide' : undefined}>
          {f.label}
          <input type={f.type ?? 'text'} value={value[f.key]} maxLength={f.max} autoComplete="off" onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
            aria-required={f.key === 'name' || undefined} aria-invalid={(f.key === 'contactEmail' && bad) || undefined} />
        </label>
      ))}
      {bad && <p className="adm-warn wide">담당자 이메일 형식을 확인하십시오. 예: kim@company.com</p>}
    </div>
  )
}

// 기업 상태: 아이콘 + 글자
export function State({ status }: { status: Company['status'] }) {
  return status === 'suspended'
    ? <span className="adm-st off"><CirclePause size={16} aria-hidden />사용 중지</span>
    : <span className="adm-st ok"><CheckCircle2 size={16} aria-hidden />사용 중</span>
}

// 코드 만료일: 남은 일수, 지나면 위험 색 + 아이콘 + 글자
export function Expiry({ iso }: { iso: string }) {
  const [now] = useState(Date.now)
  const left = Math.ceil((new Date(iso).getTime() - now) / 86_400_000)
  return left > 0
    ? <span className="adm-exp">{day(iso)}<small>{left}일 남음</small></span>
    : <span className="adm-st bad"><AlertTriangle size={16} aria-hidden />{day(iso)} 만료</span>
}

// 구성원: 역할 변경(고객사 관리자, 운영자 전환), 제외. 둘 다 재확인 후 실행
// - base: 고객사 관리자 '/company', 판매사 co(기업 id)
// - 마지막 고객사 관리자의 변경·제외는 서버 409 문구 표시
// - self: 로그인 사용자 이메일, 해당 행에 "나" 표시
export function Members({ base, members, self, onChange }: { base: string; members: Member[]; self?: string; onChange: () => void }) {
  const [ask, setAsk] = useState<{ sub: string; remove: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<{ text: string; bad?: boolean } | null>(null)
  const nextRole = (m: Member): Role => (m.role === 'manager' ? 'operator' : 'manager')

  async function run(m: Member, remove: boolean) {
    const next = nextRole(m)
    setBusy(true); setAsk(null); setOut(null)
    try {
      if (remove) await removeMember(base, m.sub)
      else await setMemberRole(base, m.sub, next)
      setOut({ text: remove ? `${m.email} 구성원을 기업에서 제외했습니다.` : `${m.email} 구성원의 역할을 ${ROLE[next]}로 바꿨습니다.` })
      onChange()
    } catch (e) {
      setOut({ text: msg(e), bad: true })
    } finally {
      setBusy(false)
    }
  }

  const toggle = (sub: string, remove: boolean) => setAsk(ask?.sub === sub && ask.remove === remove ? null : { sub, remove })

  return (
    <section className="card adm-card" aria-labelledby="adm-mem">
      <h2 id="adm-mem">구성원 {members.length}명</h2>
      {members.length === 0 && <p className="muted">가입한 구성원이 없습니다. 기업 코드로 처음 가입한 사람이 고객사 관리자가 됩니다.</p>}
      {!!members.length && (
        <ul className="adm-list">
          {members.map((m) => {
            const next = nextRole(m)
            const open = ask?.sub === m.sub ? ask : null
            return (
              <li key={m.sub} className="adm-mem">
                <UserRound size={18} aria-hidden />
                <span className="adm-entry">
                  <span>{m.email}{m.email === self && <span className="tag adm-tag">나</span>}</span>
                  <small>{ROLE[m.role] ?? m.role}, {day(m.joinedAt)} 가입</small>
                </span>
                <span className="adm-confirm adm-acts">
                  <button className="adm-mini" type="button" disabled={busy} onClick={() => toggle(m.sub, false)} aria-expanded={!!open && !open.remove} aria-label={`${m.email} 역할을 ${ROLE[next]}로 변경`}>
                    {next === 'operator' ? '운영자로 변경' : '관리자로 변경'}
                  </button>
                  <button className="adm-mini" type="button" disabled={busy} onClick={() => toggle(m.sub, true)} aria-expanded={!!open?.remove} aria-label={`${m.email} 제외`}>제외</button>
                </span>
                {open && (
                  <div className="adm-ask fade-in">
                    <p className="adm-help">
                      {open.remove
                        ? `${m.email} 구성원을 기업에서 제외합니다. 제외한 구성원은 이 기업의 건물을 볼 수 없습니다. 다시 참여하려면 기업 코드가 필요합니다.`
                        : `${m.email} 구성원의 역할을 ${ROLE[next]}로 바꿉니다. ${next === 'operator' ? '운영자는 기업 정보, 건물 정보, 구성원을 수정할 수 없습니다.' : '고객사 관리자는 기업 정보, 건물 정보, 구성원을 수정할 수 있습니다.'}`}
                    </p>
                    <div className="adm-btns">
                      <button className={open.remove ? 'adm-danger adm-btn' : 'adm-dark adm-btn'} type="button" disabled={busy} onClick={() => run(m, open.remove)}>{open.remove ? '제외' : '변경'}</button>
                      <button className="secondary adm-btn" type="button" onClick={() => setAsk(null)}>취소</button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {out && <p key={out.text} className={out.bad ? 'adm-warn fade-in' : 'ok fade-in'} role={out.bad ? 'alert' : 'status'}>{out.text}</p>}
    </section>
  )
}

// 변경 이력: 서버 순서(최신순) 50건, 동작·대상, 시각(한국 시각)·사용자
// - at: 부모 데이터 객체. 바뀔 때마다 다시 조회(같은 화면에서 한 변경 반영)
// - names: 대상 id → 표시 이름(기업 이름, 건물 이름, 구성원 이메일). 없으면 detail.email, 그다음 원래 값
const ACTION: Record<string, string> = {
  'company.create': '기업 생성', 'company.update': '기업 정보 수정', 'company.delete': '기업 삭제', 'company.code': '기업 코드 재발급',
  'building.assign': '건물 연결', 'building.update': '건물 정보 수정', 'member.join': '구성원 가입', 'member.role': '역할 변경', 'member.remove': '구성원 제외',
}
// 기록 시각: 서버 정렬 키(시각#uuid) 형식도 허용
const iso = (at: string) => at.split('#')[0]
const when = (at: string) => new Date(iso(at)).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export function Audit({ base, at, names }: { base: string; at: unknown; names: Record<string, string> }) {
  const [items, setItems] = useState<AuditItem[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    listAudit(base).then((r) => { if (alive) { setItems(r.items); setError('') } }, (e) => { if (alive) setError(msg(e)) })
    return () => { alive = false }
  }, [base, at])

  const target = (a: AuditItem) => names[a.target] ?? (typeof a.detail?.email === 'string' ? a.detail.email : a.target)
  return (
    <section className="card adm-card" aria-labelledby="adm-log">
      <h2 id="adm-log">변경 이력</h2>
      {error && <p className="adm-warn" role="alert">변경 이력을 불러오지 못했습니다({error}).</p>}
      {items === null && !error && <SkWrap label="변경 이력을 불러오는 중입니다"><SkRows rows={3} /></SkWrap>}
      {items?.length === 0 && <p className="muted">기록된 변경이 없습니다.</p>}
      {!!items?.length && (
        <ul className="adm-list">
          {items.map((a, i) => (
            <li key={`${a.at}-${i}`} className="adm-log">
              <History size={18} aria-hidden />
              <span className="adm-entry">{ACTION[a.action] ?? a.action}<small>대상 {target(a)}</small></span>
              <span className="adm-when">
                <time dateTime={iso(a.at)}>{when(a.at)}</time>
                <small>{a.actor.email}{a.actor.role === 'admin' ? ', 판매사 관리자' : ''}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
