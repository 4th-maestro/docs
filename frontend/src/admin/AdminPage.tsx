import { useEffect, useState } from 'react'
import { AtSign, Mail, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { addAllow, listAllow, listUsers, removeAllow, type AllowEntry, type UserRow } from '../api'
import './admin.css'
import { SkRows, SkTable, SkWrap } from '../skeleton/Skeleton'

// 회원 상태: Cognito UserStatus → 운영자용 표현
const STATUS: Record<string, string> = {
  CONFIRMED: '사용 중', UNCONFIRMED: '이메일 인증 대기', FORCE_CHANGE_PASSWORD: '첫 로그인 대기', RESET_REQUIRED: '비밀번호 재설정 필요',
}
const day = (iso?: string) => (iso ? iso.slice(0, 10) : '')
const EMAIL = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/
const DOMAIN = /^@[a-z0-9.-]+\.[a-z]{2,}$/

// 사용자 관리(관리자 전용): 가입 허용 목록(이메일·@도메인)과 가입한 사용자
// - 권한 판정은 API(admin.py)가 수행, 관리자가 아니면 403 안내 표시
export default function AdminPage() {
  const [entries, setEntries] = useState<AllowEntry[] | null>(null)
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [error, setError] = useState('')
  const [input, setInput] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const value = input.trim().toLowerCase()
  const valid = EMAIL.test(value) || DOMAIN.test(value)

  const load = () => Promise.all([listAllow(), listUsers()]).then(
    ([a, u]) => { setEntries(a.entries); setUsers(u.users); setError('') },
    (e: Error) => setError(e.message),
  )
  useEffect(() => { load() }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    setBusy(true); setMsg('')
    try {
      await addAllow(value, note.trim())
      setMsg(`${value}을 허용 목록에 추가했습니다.`); setInput(''); setNote('')
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(entry: string) {
    setBusy(true); setMsg(''); setConfirmDel(null)
    try {
      await removeAllow(entry)
      setMsg(`${entry}을 허용 목록에서 삭제했습니다. 이미 가입한 계정은 그대로 사용할 수 있습니다.`)
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="adm">
      <h1>사용자 관리</h1>
      {error && <p className="error adm-error" role="alert">{error}</p>}

      <section className="card adm-card" aria-labelledby="adm-allow">
        <h2 id="adm-allow">가입 허용 목록</h2>
        <p className="adm-help">목록에 있는 이메일, 또는 도메인(@회사.com)에 속한 이메일만 회원가입할 수 있습니다.</p>
        <form className="adm-form" onSubmit={add}>
          <label htmlFor="adm-entry">이메일 또는 도메인</label>
          <input id="adm-entry" value={input} onChange={(e) => setInput(e.target.value)} placeholder="kim@company.com 또는 @company.com" aria-invalid={!!value && !valid} autoComplete="off" />
          <label htmlFor="adm-note">메모</label>
          <input id="adm-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} placeholder="예: 시설팀" autoComplete="off" />
          <button className="primary" type="submit" disabled={busy || !valid}><Plus size={18} aria-hidden />추가</button>
        </form>
        {!!value && !valid && <p className="adm-warn">이메일(kim@company.com) 또는 @로 시작하는 도메인(@company.com) 형식으로 입력하십시오.</p>}
        {msg && <p className="ok" role="status">{msg}</p>}
        {entries === null && !error && <SkWrap label="허용 목록을 불러오는 중입니다"><SkRows rows={3} action /></SkWrap>}
        {entries?.length === 0 && <p className="muted">허용 목록이 비어 있습니다. 지금은 아무도 회원가입할 수 없습니다.</p>}
        {!!entries?.length && (
          <ul className="adm-list">
            {entries.map((a, idx) => {
              const domain = a.entry.startsWith('@')
              return (
                <li key={a.entry} className="rise-in" style={{ '--i': idx } as React.CSSProperties}>
                  {domain ? <AtSign size={18} aria-hidden /> : <Mail size={18} aria-hidden />}
                  <span className="adm-entry">{a.entry}<small>{domain ? '도메인 전체' : '개별 이메일'}{a.note ? `, ${a.note}` : ''}{a.addedAt ? `, ${day(a.addedAt)} 추가` : ''}</small></span>
                  {confirmDel === a.entry ? (
                    <span className="adm-confirm">
                      <button className="chat-mini danger" onClick={() => remove(a.entry)} disabled={busy}>삭제</button>
                      <button className="chat-mini" onClick={() => setConfirmDel(null)}>취소</button>
                    </span>
                  ) : (
                    <button className="icon" onClick={() => setConfirmDel(a.entry)} aria-label={`${a.entry} 삭제`}><Trash2 size={18} /></button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="card adm-card" aria-labelledby="adm-users">
        <h2 id="adm-users">가입한 사용자 {users ? `${users.length}명` : ''}</h2>
        {users === null && !error && <SkWrap label="사용자 목록을 불러오는 중입니다"><SkTable rows={4} cols={3} /></SkWrap>}
        {!!users?.length && (
          <table className="adm-table">
            <thead><tr><th>이메일</th><th>상태</th><th>가입일</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.email}>
                  <td>{u.email}{u.admin && <span className="tag adm-tag"><ShieldCheck size={14} aria-hidden />관리자</span>}</td>
                  <td>{!u.enabled ? '사용 중지' : STATUS[u.status] ?? u.status}</td>
                  <td>{day(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}
