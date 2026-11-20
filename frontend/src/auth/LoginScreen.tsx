import { useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Circle, Eye, EyeOff } from 'lucide-react'
import logo from '../../assets/ege.svg'
import { authMessage, completeNewPassword, confirmForgotPassword, confirmSignUp, forgotPassword, resendCode, signIn, signUp, AuthError } from './cognito'
import './login.css'

// 비밀번호 조건: Cognito 사용자 풀 정책과 같은 값(lambda/template.yaml UserPool)
const RULES = [
  { label: '10자 이상', ok: (p: string) => p.length >= 10 },
  { label: '영문 소문자 포함', ok: (p: string) => /[a-z]/.test(p) },
  { label: '숫자 포함', ok: (p: string) => /\d/.test(p) },
]
const strong = (p: string) => RULES.every((r) => r.ok(p))

type Mode = 'login' | 'signup' | 'confirm' | 'forgot' | 'reset' | 'newPassword'
const TITLE: Record<Mode, string> = {
  login: '로그인', signup: '회원가입', confirm: '이메일 인증', forgot: '비밀번호 재설정', reset: '새 비밀번호 설정', newPassword: '새 비밀번호 설정',
}

// 로그인 화면: 로그인, 회원가입(허용 목록 이메일), 이메일 인증, 비밀번호 재설정, 첫 로그인 비밀번호 변경
// - 입력 중 조건 표시(넉터 가이드라인 13 실시간 검증), 비밀번호 보기 버튼
// - 인증 코드 확인·재설정 후 같은 비밀번호로 바로 로그인
export default function LoginScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [session, setSession] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mail = email.trim().toLowerCase()
  const newPw = mode === 'signup' || mode === 'reset' || mode === 'newPassword'
  const pwOk = strong(password) && password === confirm
  const ready = {
    login: !!mail && !!password, signup: !!mail && pwOk, confirm: /^\d{6}$/.test(code), forgot: !!mail,
    reset: /^\d{6}$/.test(code) && pwOk, newPassword: pwOk,
  }[mode]

  function go(m: Mode, msg = '') {
    setMode(m); setError(''); setNotice(msg); setCode('')
    if (m === 'login' || m === 'forgot') { setPassword(''); setConfirm('') }
  }

  async function login() {
    const r = await signIn(mail, password)
    if (r.challenge) { setSession(r.session!); setPassword(''); setConfirm(''); go('newPassword', '첫 로그인입니다. 임시 비밀번호를 새 비밀번호로 바꾸십시오.') } else onDone()
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true); setError('')
    try {
      if (mode === 'login') await login()
      else if (mode === 'signup') { await signUp(mail, password); go('confirm', `${mail}로 6자리 인증 코드를 보냈습니다. 메일이 없으면 스팸함을 확인하십시오.`) }
      else if (mode === 'confirm') { await confirmSignUp(mail, code); if (password) await login(); else go('login', '이메일 인증이 끝났습니다. 로그인하십시오.') }
      else if (mode === 'forgot') { await forgotPassword(mail); setPassword(''); setConfirm(''); go('reset', `${mail}로 6자리 재설정 코드를 보냈습니다. 가입하지 않은 이메일이면 메일이 오지 않습니다.`) }
      else if (mode === 'reset') { await confirmForgotPassword(mail, code, password); await login() }
      else if (mode === 'newPassword') { await completeNewPassword(mail, password, session); onDone() }
    } catch (err) {
      // 인증 전 로그인: 인증 코드 단계로 이동하고 코드 재발송
      if (mode === 'login' && err instanceof AuthError && err.code === 'UserNotConfirmedException') {
        resendCode(mail).catch(() => undefined)
        go('confirm', `이메일 인증이 끝나지 않았습니다. ${mail}로 인증 코드를 다시 보냈습니다.`)
      } else setError(authMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setError('')
    try {
      if (mode === 'confirm') await resendCode(mail); else await forgotPassword(mail)
      setNotice(`${mail}로 코드를 다시 보냈습니다.`)
    } catch (err) {
      setError(authMessage(err))
    }
  }

  const eye = (
    <button type="button" className="lg-eye" onClick={() => setShow(!show)} aria-label={show ? '비밀번호 숨기기' : '비밀번호 보기'} aria-pressed={show}>
      {show ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
    </button>
  )
  const field = (id: string, label: string, input: ReactNode) => (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="lg-field">{input}</div>
    </>
  )

  return (
    <main className="lg">
      <form className="lg-card" onSubmit={submit} noValidate>
        <div className="lg-brand"><img src={logo} alt="에게" /><span>에너지게이트</span></div>
        <h1>{TITLE[mode]}</h1>
        {notice && <p className="lg-help" role="status">{notice}</p>}

        {(mode === 'login' || mode === 'signup' || mode === 'forgot') &&
          field('lg-email', '이메일', <input id="lg-email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />)}
        {(mode === 'confirm' || mode === 'reset') && (
          <>
            <p className="lg-to">{mail}</p>
            {field('lg-code', '인증 코드 6자리', <input id="lg-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />)}
            <button type="button" className="lg-link" onClick={resend}>코드 다시 받기</button>
          </>
        )}
        {mode === 'login' && field('lg-password', '비밀번호', <><input id="lg-password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />{eye}</>)}
        {newPw && (
          <>
            {field('lg-new', mode === 'signup' ? '비밀번호' : '새 비밀번호', <><input id="lg-new" type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />{eye}</>)}
            <ul className="lg-rules" aria-label="비밀번호 조건">
              {RULES.map((r) => {
                const ok = r.ok(password)
                return <li key={r.label} className={ok ? 'ok' : ''}>{ok ? <Check size={16} aria-hidden /> : <Circle size={16} aria-hidden />}{r.label}<span className="lg-sr">{ok ? ' 충족' : ' 미충족'}</span></li>
              })}
            </ul>
            {field('lg-confirm', '비밀번호 확인', <input id="lg-confirm" type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={!!confirm && confirm !== password} />)}
            {!!confirm && confirm !== password && <p className="lg-error">두 비밀번호가 다릅니다.</p>}
          </>
        )}

        {error && <p className="lg-error" role="alert">{error}</p>}
        <button className="primary lg-submit" type="submit" disabled={busy || !ready}>
          {busy ? '확인 중' : { login: '로그인', signup: '인증 코드 받기', confirm: '인증하고 시작하기', forgot: '재설정 코드 받기', reset: '비밀번호 변경', newPassword: '비밀번호 변경' }[mode]}
        </button>

        <div className="lg-links">
          {mode === 'login' ? (
            <>
              <button type="button" className="lg-link" onClick={() => go('signup')}>회원가입</button>
              <button type="button" className="lg-link" onClick={() => go('forgot')}>비밀번호를 잊었습니다</button>
            </>
          ) : (
            <button type="button" className="lg-link" onClick={() => go('login')}>로그인 화면으로</button>
          )}
        </div>
        {mode === 'signup' && <p className="lg-note">관리자가 허용 목록에 등록한 이메일(또는 도메인)만 가입할 수 있습니다.</p>}
      </form>
    </main>
  )
}
