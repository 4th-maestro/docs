import { applyOverrides, demoStatus, kstNow, live, mockAsk, summarize } from './mock'
import { mockAnomalies, mockBuildings, mockCancelSchedule, mockHistory, mockRecommendations, mockSaveSchedule, mockSchedules } from './panels/mock'
import type { Anomalies, History, Recommendations, Schedules } from './panels/types'
import { AUTH_ON, getAccessToken, signOut } from './auth/cognito'
import type { Step } from './ai/types'
import type { Chart, Draft, Portfolio, QueryResult, Source, Status } from './types'

export type ChatRecord = { sk: string; role: 'user' | 'assistant'; text: string; steps?: Step[]; highlight?: string[]; draft?: Draft | null; charts?: Chart[]; sources?: Source[] }

const BASE = import.meta.env.VITE_API_BASE_URL as string | undefined

// 로그인 만료: 로그아웃 처리 후 로그인 화면으로 전환(목업 대체 화면이 잠깐 보일 수 있으나 곧 해제됨)
export class AuthRequired extends Error {}
// 사용 중지 기업: 구성원의 건물·기업 API 403(code COMPANY_SUSPENDED) 시 발생, App이 중지 안내 화면으로 전환(detail: 서버 문구)
export const SUSPENDED = 'maestro:suspended'

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BASE) throw new Error('VITE_API_BASE_URL 없음')
  const token = await getAccessToken()
  if (AUTH_ON && !token) { signOut(); throw new AuthRequired('로그인이 필요합니다.') }
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
  if (res.status === 401) { signOut(); throw new AuthRequired('로그인이 필요합니다.') }
  // JSON이 아닌 오류 응답(게이트웨이 413 등)은 상태 코드 문구로 표시
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (data.code === 'COMPANY_SUSPENDED') window.dispatchEvent(new CustomEvent(SUSPENDED, { detail: data.error }))
    throw Object.assign(new Error(data.error ?? `요청 실패(${res.status})`), { status: res.status })
  }
  return data as T
}

// 건물 도면(내장 3D 형식): 도면 버킷 API(GET /buildings/{id}/plan), 실패하면 웹 번들의 public/floorplans(목업·API 없음)
// 판매사·고객사 구조 1단계(2026-11-20): 도면을 웹 번들 대신 서버에서 관리
export async function getPlan<T>(building: string): Promise<T> {
  try {
    return await call<T>(`/buildings/${encodeURIComponent(building)}/plan`)
  } catch (e) {
    if (e instanceof AuthRequired) throw e
    const r = await fetch(`/floorplans/${encodeURIComponent(building)}.json`)
    if (!r.ok) throw new Error(String(r.status))
    return r.json() as Promise<T>
  }
}

// 건물·층 쿼리: GET API는 building이 없으면 main(lambda/src/common.py)
const q = (building: string, floor?: string) => `?building=${encodeURIComponent(building)}${floor ? `&floor=${encodeURIComponent(floor)}` : ''}`

// Lambda 호출이 실패하면 목업으로 대체하고 mock 표시
export async function getStatus(floor: string, building: string): Promise<Status> {
  try {
    return await call<Status>(`/rooms/status${q(building, floor)}`)
  } catch {
    const data = await demoStatus(building)
    const rooms = live(applyOverrides(building, data.rooms.filter((r) => !floor || r.floor === floor)))
    return { ...data, generatedAt: kstNow(), rooms, summary: summarize(rooms), mock: true }
  }
}

// 대화 기록: 로그인 사용자·건물별 최근 30개(lambda/src/chat.py). API가 없으면 화면에만 기록
export const getChat = (building: string) =>
  call<{ messages: ChatRecord[] }>(`/chat${q(building)}`).then((r) => ({ ...r, server: true }), () => ({ messages: [] as ChatRecord[], server: false }))
export const clearChat = (building: string) => call<{ deleted: number }>(`/chat${q(building)}`, { method: 'DELETE' }).catch(() => ({ deleted: 0 }))

export const getBuildings = () => call<Portfolio>('/buildings').catch(() => mockBuildings())
// 건물 목록 변경(판매사 건물 추가·수정·삭제·연결): 상단 건물 선택 목록 다시 조회
export const BUILDINGS_CHANGED = 'maestro:buildings'
export const buildingsChanged = () => window.dispatchEvent(new Event(BUILDINGS_CHANGED))
// 트윈 building.json(관리자 또는 소속 기업 구성원), 없으면 404
export const getTwin = (id: string) => call<unknown>(`/buildings/${encodeURIComponent(id)}/twin`)

export async function ask(text: string, building: string): Promise<QueryResult> {
  try {
    return await call<QueryResult>('/query', { method: 'POST', body: JSON.stringify({ text, buildingId: building }) })
  } catch {
    return mockAsk(text, building)
  }
}

export async function saveSchedule(draft: Draft, sourceText: string, building: string): Promise<{ id: string; mock?: boolean }> {
  try {
    return await call<{ id: string }>('/schedules', { method: 'POST', body: JSON.stringify({ ...draft, sourceText, buildingId: building }) })
  } catch {
    return mockSaveSchedule(draft, sourceText, building)
  }
}

// 운영 패널 조회: 실패하면 목업으로 대체하고 mock 표시
export const getRecommendations = (floor: string, building: string) => call<Recommendations>(`/recommendations${q(building, floor)}`).catch(() => mockRecommendations(floor, building))
export const getAnomalies = (floor: string, building: string) => call<Anomalies>(`/anomalies${q(building, floor)}`).catch(() => mockAnomalies(floor, building))
export const getHistory = (floor: string, building: string) => call<History>(`/rooms/history${q(building, floor)}`).catch(() => mockHistory(floor, building))
export const listSchedules = (building: string) => call<Schedules>(`/schedules${q(building)}`).catch(() => mockSchedules(building))

// 스케줄 취소: 서버 스케줄의 실패는 목업으로 대체하지 않고 오류로 표시(취소되지 않은 스케줄을 취소로 표시하지 않기 위함)
export async function cancelSchedule(id: string): Promise<{ id: string; mock?: boolean }> {
  if (!BASE || id.startsWith('mock-')) return mockCancelSchedule(id)
  return call<{ id: string }>(`/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 로그인 사용자 소속(GET /me): role이 null이면 소속 기업 없음. 판매사 관리자는 admin
// - 사용 중지 기업 구성원도 조회 가능(company.status 'suspended')
export type Role = 'admin' | 'manager' | 'operator'
export type Me = { email: string; role: Role | null; company: { id: string; name: string; status: 'active' | 'suspended' } | null }
export const getMe = () => call<Me>('/me')

// 판매사 기업·사용자 관리(관리자 그룹 전용, lambda admin API): 목업 대체 없음, 실패는 화면에 오류 표시
export type Company = {
  id: string; name: string; contactName: string; contactEmail: string; phone: string; address: string
  status: 'active' | 'suspended'; code: string; codeExpiresAt: string; createdAt: string
}
export type CompanyRow = Company & { buildingCount: number; memberCount: number }
export type CompanyInput = Partial<Pick<Company, 'name' | 'contactName' | 'contactEmail' | 'phone' | 'address' | 'status'>>
export type Member = { sub: string; email: string; role: Role; joinedAt: string }
export type CompanyDetail = {
  company: Company
  buildings: CompanyBuilding[]
  members: Member[]
}
export type AdminBuilding = { id: string; name: string; companyId: string | null; companyName: string | null }
export type UserRow = { email: string; status: string; enabled: boolean; admin: boolean; createdAt: string }
const json = (method: string, body?: object): RequestInit => ({ method, body: body && JSON.stringify(body) })
export const co = (id: string) => `/admin/companies/${encodeURIComponent(id)}`
export const listCompanies = () => call<{ companies: CompanyRow[] }>('/admin/companies')
export const createCompany = (body: CompanyInput & { codeDays: number }) => call<{ company: Company }>('/admin/companies', json('POST', body))
export const getCompany = (id: string) => call<CompanyDetail>(co(id))
export const updateCompany = (id: string, body: CompanyInput) => call<{ company: Company }>(co(id), json('PATCH', body))
export const deleteCompany = (id: string) => call<{ deleted: boolean }>(co(id), json('DELETE'))
export const renewCode = (id: string, days: number) => call<{ company: Company }>(`${co(id)}/code`, json('POST', { days }))
export const listAdminBuildings = () => call<{ buildings: AdminBuilding[] }>('/admin/buildings')
export const assignBuilding = (buildingId: string, companyId: string | null) =>
  call<{ buildingId: string; companyId: string | null }>(`/admin/buildings/${encodeURIComponent(buildingId)}/company`, json('PUT', { companyId }))
export const listUsers = () => call<{ users: UserRow[] }>('/admin/users')

// 판매사 건물 관리: 추가(id는 브라우저 생성 b-xxxxxxxx), 정보 수정, 도면 교체·편집 저장, 영구 삭제
// - 도면 저장 경로: PUT /buildings/{id}/twin(도면 변환 규약 docs/human/reference/plan-ingest.md 4절과 공용, 판매사 권한은 서버 판정)
// - 도면 본문 한도 5MB(서버 413): 보내기 전에 확인
const LIMIT = 5 * 1024 * 1024
function upload(method: string, body: object): RequestInit {
  const text = JSON.stringify(body)
  if (new Blob([text]).size > LIMIT) throw new Error('도면 데이터가 5MB를 넘어 저장할 수 없습니다. 층 수나 도면 범위를 줄이십시오.')
  return { method, body: text }
}
export type TwinUpload = { twin: unknown; rooms: unknown[]; plan: unknown }
const adminBuilding = (id: string) => `/admin/buildings/${encodeURIComponent(id)}`
export const createBuilding = (companyId: string, body: Required<BuildingInput> & TwinUpload & { id: string }) =>
  call<{ building: CompanyBuilding }>(`${co(companyId)}/buildings`, upload('POST', body))
export const putTwin = (id: string, body: TwinUpload) => call<{ building: CompanyBuilding; version: number }>(`/buildings/${encodeURIComponent(id)}/twin`, upload('PUT', body))
export const patchBuilding = (id: string, body: BuildingInput) => call<{ building: CompanyBuilding }>(adminBuilding(id), json('PATCH', body))
export const deleteBuilding = (id: string) => call<{ deleted: boolean }>(adminBuilding(id), json('DELETE'))

// 기업 코드로 소속 연결(소속 기업 없음 화면): 400 코드 오류·만료, 409 이미 소속
export const joinCompany = (code: string) => call<{ company: NonNullable<Me['company']>; role: Role }>('/me/join', json('POST', { code }))

// 고객사 기업 설정(#/settings): 구성원 조회 전용(기업 코드·구성원 미포함), 수정은 판매사 관리 화면
// - hasTwin: 판매사 응답(GET /admin/companies/{id}, /admin/buildings)에만 포함, 트윈 building.json 저장 여부
export type CompanyBuilding = { id: string; name: string; use: string; floors: string[]; roomCount: number; hours: [number, number]; weekend: boolean; hasTwin?: boolean }
export type BuildingInput = Partial<Pick<CompanyBuilding, 'name' | 'use' | 'hours' | 'weekend'>>
export type MyCompany = {
  company: Omit<Company, 'code' | 'codeExpiresAt' | 'createdAt'>
  buildings: CompanyBuilding[]
}
export const getMyCompany = () => call<MyCompany>('/company')

// 구성원 역할·제외와 변경 이력: 판매사 co(기업 id), 고객사 변경 이력은 '/company'(조회만)
export type AuditItem = { at: string; actor: { email: string; role: string }; action: string; target: string; detail?: Record<string, unknown> }
const member = (base: string, sub: string) => `${base}/members/${encodeURIComponent(sub)}`
export const setMemberRole = (base: string, sub: string, role: Role) => call<{ member: Member }>(member(base, sub), json('PATCH', { role }))
export const removeMember = (base: string, sub: string) => call<{ deleted: boolean }>(member(base, sub), json('DELETE'))
export const listAudit = (base: string, limit = 50) => call<{ items: AuditItem[] }>(`${base}/audit?limit=${limit}`)
