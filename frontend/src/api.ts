import { demoStatus, kstNow, live, mockAsk, summarize } from './mock'
import type { Draft, QueryResult, Status } from './types'

const BASE = import.meta.env.VITE_API_BASE_URL as string | undefined

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BASE) throw new Error('VITE_API_BASE_URL 없음')
  const res = await fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' }, ...init })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `요청 실패(${res.status})`)
  return data as T
}

// Lambda 호출이 실패하면 목업으로 대체하고 mock 표시
export async function getStatus(floor: string): Promise<Status> {
  try {
    return await call<Status>(`/rooms/status?floor=${encodeURIComponent(floor)}`)
  } catch {
    const data = await demoStatus()
    const rooms = live(data.rooms.filter((r) => r.floor === floor))
    return { ...data, generatedAt: kstNow(), rooms, summary: summarize(rooms), mock: true }
  }
}

export async function ask(text: string): Promise<QueryResult> {
  try {
    return await call<QueryResult>('/query', { method: 'POST', body: JSON.stringify({ text }) })
  } catch {
    return mockAsk(text)
  }
}

export async function saveSchedule(draft: Draft, sourceText: string): Promise<{ id: string; mock?: boolean }> {
  try {
    return await call<{ id: string }>('/schedules', { method: 'POST', body: JSON.stringify({ ...draft, sourceText }) })
  } catch {
    return { id: `mock-${Date.now()}`, mock: true }
  }
}
