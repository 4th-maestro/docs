import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, CirclePause, History, UserRound } from 'lucide-react'
import { listAudit, removeMember, setMemberRole, type AuditItem, type BuildingInput, type Company, type Member, type Role } from '../api'
import { ROLE } from '../auth/me'
import { Seg } from '../energy/parts'
import { SkRows, SkWrap } from '../skeleton/Skeleton'
import { badMail, day, FIELDS, hh, msg, type Form } from './form'

// 기업 화면 공용 컴포넌트: 판매사 기업 상세(AdminPage), 판매사 건물 화면(BuildingPages), 고객사 기업 정보(SettingsPage, 변경 이력만)

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

// 구성원(판매사 기업 상세): 역할 변경(고객사 관리자, 운영자 전환), 제외. 둘 다 재확인 후 실행
// - base: 판매사 co(기업 id)
// - 고객사 관리자 최소 인원 제한 없음(2026-11-20 해제). 서버 오류 문구는 그대로 표시
export function Members({ base, members, onChange }: { base: string; members: Member[]; onChange: () => void }) {
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
                  <span>{m.email}</span>
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
                        : `${m.email} 구성원의 역할을 ${ROLE[next]}로 바꿉니다.`}
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
// - names: 대상 id → 표시 이름(기업 이름, 건물 이름, 구성원 이메일). 없으면 detail.email, detail.name, 그다음 원래 값
const ACTION: Record<string, string> = {
  'company.create': '기업 생성', 'company.update': '기업 정보 수정', 'company.delete': '기업 삭제', 'company.code': '기업 코드 재발급',
  'building.assign': '건물 연결', 'building.update': '건물 정보 수정', 'building.create': '건물 추가', 'building.plan': '도면 교체', 'building.delete': '건물 삭제',
  'member.join': '구성원 가입', 'member.role': '역할 변경', 'member.remove': '구성원 제외',
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

  // 삭제된 건물은 목록에 없으므로 detail.name(building.delete) 사용
  const target = (a: AuditItem) => names[a.target] ?? [a.detail?.email, a.detail?.name].find((v): v is string => typeof v === 'string') ?? a.target
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

// 건물 정보 입력: 이름 1~40자, 용도 1~20자, 운영 시간(0~24시, 시작 < 종료), 주말 운영
// - diff: 바뀐 항목만 전송(정보 수정), 없으면 전체 전송(건물 추가 확인)
// - 저장 실패는 서버 문구를 폼 안에 표시(409 포함)
const HOURS = Array.from({ length: 25 }, (_, h) => h)
const WEEKEND: ['on' | 'off', string][] = [['on', '운영'], ['off', '휴무']]
export type BuildingInfo = Required<BuildingInput>
export function BuildingForm({ init, label, ok, cancel, diff, submit, onCancel }: {
  init: BuildingInfo; label: string; ok: string; cancel: string; diff?: boolean; submit: (body: BuildingInput) => Promise<unknown>; onCancel: () => void
}) {
  const [name, setName] = useState(init.name)
  const [use, setUse] = useState(init.use)
  const [start, setStart] = useState(init.hours[0])
  const [end, setEnd] = useState(init.hours[1])
  const [weekend, setWeekend] = useState(init.weekend)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const body: BuildingInfo = { name: name.trim(), use: use.trim(), hours: [start, end], weekend }
  const send = diff ? Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(init[k as keyof BuildingInfo]))) as BuildingInput : body
  const bad = !body.name ? '건물 이름을 입력하십시오.' : !body.use ? '용도를 입력하십시오.' : start >= end ? '운영 종료 시각은 시작 시각보다 늦어야 합니다.' : ''

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (bad || !Object.keys(send).length) return
    setBusy(true); setError('')
    try {
      await submit(send)
    } catch (err) {
      setError(msg(err))
    } finally {
      setBusy(false)
    }
  }

  const hour = (text: string, value: number, set: (h: number) => void, hours: number[]) => (
    <label>
      {text}
      <select value={value} onChange={(e) => set(Number(e.target.value))} aria-invalid={start >= end || undefined}>
        {hours.map((h) => <option key={h} value={h}>{hh(h)}시</option>)}
      </select>
    </label>
  )
  return (
    <form className="adm-ask fade-in" onSubmit={save} aria-label={label}>
      <div className="adm-fields">
        <label>건물 이름<input value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} aria-required aria-invalid={!body.name || undefined} /></label>
        <label>용도<input value={use} maxLength={20} autoComplete="off" onChange={(e) => setUse(e.target.value)} aria-required aria-invalid={!body.use || undefined} /></label>
        {hour('운영 시작', start, setStart, HOURS.slice(0, 24))}
        {hour('운영 종료', end, setEnd, HOURS.slice(1))}
      </div>
      <span className="adm-label" aria-hidden>주말 운영</span>
      <Seg label="주말 운영" options={WEEKEND} value={weekend ? 'on' : 'off'} onChange={(v) => setWeekend(v === 'on')} />
      {bad && <p className="adm-warn" role="alert">{bad}</p>}
      {error && <p key={error} className="adm-warn fade-in" role="alert">{error}</p>}
      <div className="adm-btns">
        <button className="adm-dark adm-btn" type="submit" disabled={busy || !!bad || !Object.keys(send).length}>{ok}</button>
        <button className="secondary adm-btn" type="button" onClick={onCancel}>{cancel}</button>
      </div>
    </form>
  )
}
