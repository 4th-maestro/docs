import type { Company, CompanyInput, Member } from '../api'

// 기업 정보 입력: 판매사 기업 관리(AdminPage)와 고객사 기업 설정(SettingsPage) 공용
// - 생성: 빈 칸 제외, 수정: 바뀐 칸만 전송(지운 칸은 빈 문자열)
export type Form = { name: string; contactName: string; contactEmail: string; phone: string; address: string }
type Info = Pick<Company, keyof Form>
export const EMPTY: Form = { name: '', contactName: '', contactEmail: '', phone: '', address: '' }
export const FIELDS: { key: keyof Form; label: string; max: number; type?: string }[] = [
  { key: 'name', label: '기업 이름(필수)', max: 60 },
  { key: 'contactName', label: '담당자', max: 40 },
  { key: 'contactEmail', label: '담당자 이메일', max: 100, type: 'email' },
  { key: 'phone', label: '연락처', max: 30, type: 'tel' },
  { key: 'address', label: '주소', max: 200 },
]
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i
export const toForm = (c: Info): Form => ({ name: c.name, contactName: c.contactName ?? '', contactEmail: c.contactEmail ?? '', phone: c.phone ?? '', address: c.address ?? '' })
const trimmed = (f: Form) => Object.entries(f).map(([k, v]) => [k, v.trim()] as [keyof Form, string])
export const forCreate = (f: Form) => Object.fromEntries(trimmed(f).filter(([, v]) => v)) as CompanyInput
export const forUpdate = (f: Form, c: Info) => { const base = toForm(c); return Object.fromEntries(trimmed(f).filter(([k, v]) => v !== base[k])) as CompanyInput }
export const badMail = (f: Form) => !!f.contactEmail.trim() && !EMAIL.test(f.contactEmail.trim())
export const formOk = (f: Form) => !!f.name.trim() && !badMail(f)

// 운영 시간 표시: 0~24시, 두 자리
export const hh = (h: number) => String(h).padStart(2, '0')

// 날짜 표시: 한국 시각 기준 YYYY-MM-DD
export const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) : '')
export const msg = (e: unknown) => (e as Error).message

// 변경 이력 대상 이름: 기업 id → 기업 이름, 건물 id → 건물 이름, 구성원 sub → 이메일
export const auditNames = (d: { company: { id: string; name: string }; buildings: { id: string; name: string }[]; members?: Member[] }): Record<string, string> =>
  Object.fromEntries([[d.company.id, d.company.name], ...d.buildings.map((b) => [b.id, b.name]), ...(d.members ?? []).map((m) => [m.sub, m.email])])
