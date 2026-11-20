import { useState } from 'react'
import { Check, Circle, Eye, EyeOff } from 'lucide-react'
import { authMessage, completeNewPassword, signIn } from './cognito'
import './login.css'

// 비밀번호 조건: Cognito 사용자 풀 정책과 같은 값(lambda/template.yaml UserPool)
const RULES = [
  { label: '10자 이상', ok: (p: string) => p.length >= 10 },
  { label: '영문 소문자 포함', ok: (p: string) => /[a-z]/.test(p) },
  { label: '숫자 포함', ok: (p: string) => /\d/.test(p) },
]

// 로그인 화면: 이메일·비밀번호, 첫 로그인 시 새 비밀번호 설정
// - 입력 중 조건 표시(넉터 가이드라인 13 실시간 검증), 비밀번호 보기 버튼
export default function LoginScreen({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [session, setSession] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changing = !!session
  const nextOk = RULES.every((r) => r.ok(next)) && next === confirm

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (changing) {
        await completeNewPassword(email.trim(), next, session)
        onDone()
      } else {
        const r = await signIn(email.trim(), password)
        if (r.challenge) { setSession(r.session!); setPassword('') } else onDone()
      }
    } catch (err) {
      setError(authMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const Toggle = (
    <button type="button" className="lg-eye" onClick={() => setShow(!show)} aria-label={show ? '비밀번호 숨기기' : '비밀번호 보기'} aria-pressed={show}>
      {show ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
    </button>
  )

  return (
    <main className="lg">
      <form className="lg-card" onSubmit={submit} noValidate>
        <div className="lg-brand">Maestro</div>
        <h1>{changing ? '새 비밀번호 설정' : '로그인'}</h1>
        {changing ? (
          <>
            <p className="lg-help">첫 로그인입니다. 임시 비밀번호를 새 비밀번호로 바꾸십시오.</p>
            <label htmlFor="lg-next">새 비밀번호</label>
            <div className="lg-field">
              <input id="lg-next" type={show ? 'text' : 'password'} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} autoFocus />
              {Toggle}
            </div>
            <ul className="lg-rules" aria-label="비밀번호 조건">
              {RULES.map((r) => {
                const ok = r.ok(next)
                return <li key={r.label} className={ok ? 'ok' : ''}>{ok ? <Check size={16} aria-hidden /> : <Circle size={16} aria-hidden />}{r.label}<span className="lg-sr">{ok ? ' 충족' : ' 미충족'}</span></li>
              })}
            </ul>
            <label htmlFor="lg-confirm">새 비밀번호 확인</label>
            <div className="lg-field">
              <input id="lg-confirm" type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={!!confirm && confirm !== next} />
            </div>
            {!!confirm && confirm !== next && <p className="lg-error">두 비밀번호가 다릅니다.</p>}
          </>
        ) : (
          <>
            <label htmlFor="lg-email">이메일</label>
            <div className="lg-field">
              <input id="lg-email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </div>
            <label htmlFor="lg-password">비밀번호</label>
            <div className="lg-field">
              <input id="lg-password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              {Toggle}
            </div>
          </>
        )}
        {error && <p className="lg-error" role="alert">{error}</p>}
        <button className="primary lg-submit" type="submit" disabled={busy || (changing ? !nextOk : !email.trim() || !password)}>
          {busy ? '확인 중' : changing ? '비밀번호 변경' : '로그인'}
        </button>
        <p className="lg-note">계정은 관리자가 발급합니다. 비밀번호를 잊었으면 관리자에게 문의하십시오.</p>
      </form>
    </main>
  )
}
