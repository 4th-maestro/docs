import { demoStatus, kstNow, live, mockAsk, summarize } from './mock'
import { mockAnomalies, mockBuildings, mockCancelSchedule, mockHistory, mockRecommendations, mockSaveSchedule, mockSchedules } from './panels/mock'
import type { Anomalies, History, Recommendations, Schedules } from './panels/types'
import { AUTH_ON, getAccessToken, signOut } from './auth/cognito'
import type { Draft, Portfolio, QueryResult, Status } from './types'

const BASE = import.meta.env.VITE_API_BASE_URL as string | undefined

// 로그인 만료: 로그아웃 처리 후 로그인 화면으로 전환(목업 대체 화면이 잠깐 보일 수 있으나 곧 해제됨)
export class AuthRequired extends Error {}

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BASE) throw new Error('VITE_API_BASE_URL 없음')
  const token = await getAccessToken()
  if (AUTH_ON && !token) { signOut(); throw new AuthRequired('로그인이 필요합니다.') }
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
  if (res.status === 401) { signOut(); throw new AuthRequired('로그인이 필요합니다.') }
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `요청 실패(${res.status})`)
  return data as T
}

// 건물·층 쿼리: GET API는 building이 없으면 main(lambda/src/common.py)
const q = (building: string, floor?: string) => `?building=${encodeURIComponent(building)}${floor ? `&floor=${encodeURIComponent(floor)}` : ''}`

// Lambda 호출이 실패하면 목업으로 대체하고 mock 표시
export async function getStatus(floor: string, building: string): Promise<Status> {
  try {
    return await call<Status>(`/rooms/status${q(building, floor)}`)
  } catch {
    const data = await demoStatus(building)
    const rooms = live(data.rooms.filter((r) => r.floor === floor))
    return { ...data, generatedAt: kstNow(), rooms, summary: summarize(rooms), mock: true }
  }
}

export const getBuildings = () => call<Portfolio>('/buildings').catch(() => mockBuildings())

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
