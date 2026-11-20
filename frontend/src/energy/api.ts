import { mockBreakdown, mockCompare, mockHeatmap, mockTrend } from './mock'

// 에너지 분석 API 응답 형식(lambda/src/energy.py와 같은 필드)
type Base = { generatedAt: string; virtual: boolean; mock?: boolean }
export type CompareItem = { buildingId: string; name: string; areaM2: number; kwh: number; prevKwh: number; kwhPerM2: number; costKrw: number }
export type Compare = Base & { period: 'day' | 'month'; unitPriceKrw: number; priceBasis: string; items: CompareItem[] }
export type Point = { label: string; kwh: number }
export type Trend = Base & {
  building: string; period: Period; unit: 'kWh'; current: Point[]; previous: Point[]
  totalKwh: number; prevTotalKwh: number; prevSameKwh: number
}
export type Heatmap = Base & { building: string; weeks: number; unit: 'kW'; cells: number[][]; max: number; hours: [number, number]; weekend: boolean }
export type Breakdown = Base & {
  building: string; name: string; period: Period; unit: 'kWh'; totalKwh: number
  floors: { floor: string; kwh: number; uses: { use: string; kwh: number }[] }[]
}
export type Period = 'day' | 'week' | 'month'

const BASE = import.meta.env.VITE_API_BASE_URL as string | undefined

async function call<T>(path: string): Promise<T> {
  if (!BASE) throw new Error('VITE_API_BASE_URL 없음')
  const res = await fetch(`${BASE}${path}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `요청 실패(${res.status})`)
  return data as T
}

// 인자는 쿼리 문자열 1개(usePoll이 같은 값이면 다시 조회하지 않도록 문자열로 전달). 실패하면 목업으로 대체하고 mock 표시
export const query = (q: Record<string, string>) => new URLSearchParams(q).toString()
const params = (q: string) => Object.fromEntries(new URLSearchParams(q))
export const getCompare = (q: string) => call<Compare>(`/energy/compare?${q}`).catch(() => mockCompare(params(q)))
export const getTrend = (q: string) => call<Trend>(`/energy/trend?${q}`).catch(() => mockTrend(params(q)))
export const getHeatmap = (q: string) => call<Heatmap>(`/energy/heatmap?${q}`).catch(() => mockHeatmap(params(q)))
export const getBreakdown = (q: string) => call<Breakdown>(`/energy/breakdown?${q}`).catch(() => mockBreakdown(params(q)))
