import { call, HAS_API } from '../api'
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

// 인자는 쿼리 문자열 1개(usePoll이 같은 값이면 다시 조회하지 않도록 문자열로 전달)
// - 공용 call 사용: 로그인 토큰 전송, 401 로그인 이동, 사용 중지 기업 처리
// - 목업은 API 주소가 없을 때만. API 오류를 목업으로 바꾸면 서버 건물(목업에 없음)이 "알 수 없는 건물"로 표시됨(2026-11-20 장애)
export const query = (q: Record<string, string>) => new URLSearchParams(q).toString()
const params = (q: string) => Object.fromEntries(new URLSearchParams(q))
const get = <T,>(path: string, mock: () => T | Promise<T>): Promise<T> => (HAS_API ? call<T>(path) : Promise.resolve().then(mock))
export const getCompare = (q: string) => get<Compare>(`/energy/compare?${q}`, () => mockCompare(params(q)))
export const getTrend = (q: string) => get<Trend>(`/energy/trend?${q}`, () => mockTrend(params(q)))
export const getHeatmap = (q: string) => get<Heatmap>(`/energy/heatmap?${q}`, () => mockHeatmap(params(q)))
export const getBreakdown = (q: string) => get<Breakdown>(`/energy/breakdown?${q}`, () => mockBreakdown(params(q)))
