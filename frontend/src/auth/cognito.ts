// Cognito 로그인(USER_PASSWORD_AUTH, 라이브러리 없이 cognito-idp HTTPS 직접 호출)
// - 계정: 판매사가 발급한 기업 코드로 자체 가입, 이메일 인증 코드 확인 후 사용. CLI 발급 계정은 첫 로그인에 비밀번호 변경
// - 비밀번호 재설정: 인증된 이메일로 코드 발송(ForgotPassword → ConfirmForgotPassword)
// - 토큰: 액세스 토큰을 API·WebSocket에 사용, 만료 60초 전 갱신 토큰으로 재발급
// - 보관: localStorage(하루 종일 사용, 새로고침 후 유지)
//   shortcut: XSS 발생 시 토큰 노출 위험, 사용자 입력 HTML을 표시하는 기능이 생기면 메모리 보관 + HttpOnly 쿠키 갱신으로 전환
const REGION = (import.meta.env.VITE_COGNITO_REGION as string | undefined) ?? 'ap-northeast-2'
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined
const KEY = 'maestro-auth'

// 클라이언트 ID가 없으면(로컬 목업 실행) 로그인 생략
export const AUTH_ON = !!CLIENT_ID

type Tokens = { idToken: string; accessToken: string; refreshToken: string; expiresAt: number }
type AuthResult = { IdToken: string; AccessToken: string; RefreshToken?: string; ExpiresIn: number }

export class AuthError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

let tokens: Tokens | null = load()
let refreshing: Promise<string | null> | null = null
const listeners = new Set<() => void>()

function load(): Tokens | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Tokens | null
  } catch {
    return null
  }
}

function save(t: Tokens | null) {
  tokens = t
  try {
    if (t) localStorage.setItem(KEY, JSON.stringify(t))
    else localStorage.removeItem(KEY)
  } catch { /* 저장 불가 브라우저: 이번 방문 메모리에만 유지 */ }
  listeners.forEach((f) => f())
}

async function idp<T>(target: string, body: object): Promise<T> {
  const res = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new AuthError(String(data.__type ?? 'Error').split('#').pop()!, data.message ?? '')
  return data as T
}

function keep(r: AuthResult, refreshToken?: string) {
  save({ idToken: r.IdToken, accessToken: r.AccessToken, refreshToken: r.RefreshToken ?? refreshToken ?? '', expiresAt: Date.now() + r.ExpiresIn * 1000 })
}

export async function signIn(email: string, password: string): Promise<{ challenge?: 'NEW_PASSWORD_REQUIRED'; session?: string }> {
  const r = await idp<{ AuthenticationResult?: AuthResult; ChallengeName?: string; Session?: string }>('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH', ClientId: CLIENT_ID, AuthParameters: { USERNAME: email, PASSWORD: password },
  })
  if (r.AuthenticationResult) { keep(r.AuthenticationResult); return {} }
  if (r.ChallengeName === 'NEW_PASSWORD_REQUIRED') return { challenge: 'NEW_PASSWORD_REQUIRED', session: r.Session }
  throw new AuthError('UnsupportedChallenge', r.ChallengeName ?? '')
}

export async function completeNewPassword(email: string, newPassword: string, session: string) {
  const r = await idp<{ AuthenticationResult?: AuthResult }>('RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED', ClientId: CLIENT_ID, Session: session,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
  })
  if (!r.AuthenticationResult) throw new AuthError('UnsupportedChallenge', '')
  keep(r.AuthenticationResult)
}

// 기업 코드: 가입 전 검사(PreSignUp)가 ClientMetadata로 받아 존재·만료·기업 상태 확인
export async function signUp(email: string, password: string, companyCode: string) {
  await idp('SignUp', { ClientId: CLIENT_ID, Username: email, Password: password, UserAttributes: [{ Name: 'email', Value: email }], ClientMetadata: { companyCode } })
}

export async function confirmSignUp(email: string, code: string) {
  await idp('ConfirmSignUp', { ClientId: CLIENT_ID, Username: email, ConfirmationCode: code })
}

export async function resendCode(email: string) {
  await idp('ResendConfirmationCode', { ClientId: CLIENT_ID, Username: email })
}

export async function forgotPassword(email: string) {
  await idp('ForgotPassword', { ClientId: CLIENT_ID, Username: email })
}

export async function confirmForgotPassword(email: string, code: string, password: string) {
  await idp('ConfirmForgotPassword', { ClientId: CLIENT_ID, Username: email, ConfirmationCode: code, Password: password })
}

// API·WebSocket 호출 직전에 사용. 갱신 실패 시 로그아웃 처리 후 null
export async function getAccessToken(): Promise<string | null> {
  if (!AUTH_ON) return null
  if (!tokens) return null
  if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken
  refreshing ??= idp<{ AuthenticationResult: AuthResult }>('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: CLIENT_ID, AuthParameters: { REFRESH_TOKEN: tokens.refreshToken },
  })
    .then((r) => { keep(r.AuthenticationResult, tokens?.refreshToken); return tokens!.accessToken })
    .catch(() => { save(null); return null })
    .finally(() => { refreshing = null })
  return refreshing
}

export function signedIn() {
  return !AUTH_ON || !!tokens
}

export function signOut() {
  save(null)
}

export function onAuthChange(f: () => void) {
  listeners.add(f)
  return () => { listeners.delete(f) }
}

// 표시용 정보: ID 토큰 본문(서명 검증·권한 판정은 API 쪽에서 수행)
function idClaims(): Record<string, unknown> {
  try {
    const p = tokens!.idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p), (c) => c.charCodeAt(0))))
  } catch {
    return {}
  }
}

export const currentEmail = () => String(idClaims().email ?? '')
export const currentSub = () => String(idClaims().sub ?? '')
// 관리자 여부(토큰 발급 시점 값): GET /me 응답 전에만 사용, 실제 권한은 서버가 Cognito admin 그룹으로 판정
export const isAdmin = () => ((idClaims()['cognito:groups'] as string[] | undefined) ?? []).includes('admin')

export function authMessage(e: unknown): string {
  const code = e instanceof AuthError ? e.code : ''
  if (code === 'NotAuthorizedException' || code === 'UserNotFoundException') return '이메일 또는 비밀번호가 맞지 않습니다.'
  // 가입 전 검사 거부: Cognito가 'PreSignUp failed with error ...'로 감싼 메시지
  if (code === 'UserLambdaValidationException' && e instanceof AuthError && e.message.includes('기업 코드가 올바르지 않거나 만료')) return '기업 코드가 올바르지 않거나 만료되었습니다. 판매사에 새 기업 코드를 요청하십시오.'
  if (code === 'UserLambdaValidationException') return '가입 정보를 확인하지 못했습니다. 잠시 후 다시 시도하십시오.'
  if (code === 'UsernameExistsException') return '이미 가입한 이메일입니다. 로그인하거나 비밀번호를 재설정하십시오.'
  if (code === 'CodeMismatchException') return '인증 코드가 맞지 않습니다. 메일의 6자리 숫자를 다시 확인하십시오.'
  if (code === 'ExpiredCodeException') return '인증 코드가 만료되었습니다. 코드를 다시 받으십시오.'
  if (code === 'UserNotConfirmedException') return '이메일 인증이 끝나지 않았습니다. 메일로 받은 코드를 입력하십시오.'
  if (code === 'InvalidParameterException') return '입력값을 확인하십시오. 이메일 형식과 비밀번호 조건을 확인해야 합니다.'
  if (code === 'InvalidPasswordException') return '비밀번호 조건을 확인하십시오. 10자 이상, 영문 소문자와 숫자를 포함해야 합니다.'
  if (code === 'PasswordResetRequiredException') return '비밀번호 재설정이 필요합니다. 관리자에게 문의하십시오.'
  if (code === 'TooManyRequestsException' || code === 'LimitExceededException') return '시도 횟수가 많습니다. 잠시 후 다시 시도하십시오.'
  if (e instanceof TypeError) return '서버에 연결하지 못했습니다. 네트워크를 확인하십시오.'
  return '로그인하지 못했습니다. 잠시 후 다시 시도하십시오.'
}
