import { webProfile, webStatus } from '../twin/pipeline/web-demo.js'
import type { BuildingCard, Portfolio, Status } from './types'

// '건물 추가'로 넣은 건물(이 브라우저에만 저장)
// - pending: 추가만 한 상태. 데이터를 만들지 않음(도면 이미지를 넣고 트윈에서 렌더링해야 시작)
// - ready: 트윈 파이프라인이 만든 building.json이 있음 → 기본 건물과 같은 코드(twin/pipeline/web-demo.js)로 데모 상태 생성
// shortcut: localStorage 보관(다른 브라우저·사용자에게는 안 보임), Lambda 연결 후에는 서버 저장으로 교체
export type Custom = { id: string; name: string; state: 'pending' | 'ready'; addedAt: string }
const LIST = 'maestro:custom-buildings'
const DOC = (id: string) => `maestro:custom-building:${id}`
export const isCustom = (id: string) => id.startsWith('new-')

const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } }
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); return true } catch { return false } }

export const customList = () => read<Custom[]>(LIST, [])
export const customOf = (id: string) => customList().find((c) => c.id === id)

export function addCustom(): string {
  const list = customList()
  const id = `new-${Date.now().toString(36)}`
  write(LIST, [...list, { id, name: `새 건물 ${list.length + 1}`, state: 'pending', addedAt: new Date().toISOString() }])
  return id
}

// 트윈 파이프라인의 '트윈에서 렌더링' → 도면 저장, 이때부터 데이터 생성
export function setRendered(id: string, building: { building?: { name?: string } }): boolean {
  if (!write(DOC(id), building)) return false
  write(LIST, customList().map((c) => (c.id === id ? { ...c, name: building.building?.name || c.name, state: 'ready' as const } : c)))
  statuses.delete(id)
  return true
}

export function removeCustom(id: string) {
  write(LIST, customList().filter((c) => c.id !== id))
  try { localStorage.removeItem(DOC(id)) } catch { /* 없음 */ }
}

export const customBuilding = (id: string) => read<unknown>(DOC(id), null)

const statuses = new Map<string, Status>()
export function customStatus(id: string): Status | null {
  const c = customOf(id)
  const B = c?.state === 'ready' ? customBuilding(id) : null
  if (!B) return null
  let s = statuses.get(id)
  if (!s) { s = webStatus(B, { id, use: '추가한 건물', basis: '건물 추가 (트윈 파이프라인)' }) as Status; statuses.set(id, s) }
  return s
}
export function customProfile(id: string) {
  const s = customStatus(id)
  return s ? webProfile(customBuilding(id), s) : null
}

// 전체 현황·건물 선택 목록 뒤에 추가한 건물을 붙임(렌더링 전 건물은 0으로)
export function withCustom(p: Portfolio): Portfolio {
  const cards: BuildingCard[] = customList().filter((c) => !p.buildings.some((b) => b.id === c.id)).map((c) => {
    const s = customStatus(c.id)
    const base = s?.building ?? { id: c.id, name: c.name, use: '도면 렌더링 전', virtual: false, basis: '', floors: [], roomCount: 0, areaM2: 0 }
    return { ...base, now: s?.summary ?? { on: 0, off: 0, anomaly: 0, powerKw: 0 }, todayKwh: 0, savingKwh: 0, level: s?.summary.anomaly ? 'alert' : 'ok' }
  })
  return { ...p, buildings: [...p.buildings, ...cards] }
}

// 목록이 바뀌면(추가·렌더링·취소) 화면이 목록을 다시 조회
export const BUILDINGS_CHANGED = 'maestro:buildings'
export const buildingsChanged = () => window.dispatchEvent(new Event(BUILDINGS_CHANGED))
