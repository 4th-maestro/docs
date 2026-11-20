import { kstNow } from '../mock'
import type { Decision, OpsAction, OpsOverview } from './types'

// API 없는 목업 모드: 건물별 메모리 저장(새로고침하면 초기화). 화면 확인용 제안·자동 조치·이상 알림 3건
const store = new Map<string, OpsOverview>()
const at = (minAgo: number) => `${new Date(Date.now() + 9 * 3600_000 - minAgo * 60_000).toISOString().slice(0, 19)}+09:00`

function seed(building: string): OpsOverview {
  const decisions: Decision[] = [
    { decisionId: 'mock-3', kind: 'idle', status: 'pending', roomId: '', roomName: '세미나실', floor: '1F', use: '회의실', message: '1F 세미나실: 1시간째 재실 0명인데 냉난방이 켜져 있어요(0.57kW). 끌까요?', createdAt: at(2), expiresAt: at(-28), autoApply: false, jev: { choice: 'empty', confidence: 0.92, probabilities: { empty: 0.95, occupied: 0.02, uncertain: 0.03 } }, evidence: { facts: { inOperatingHours: false, minutesSinceClose: 100, idleOnMinutes: 60, lastOccupiedAt: '17:45' } } },
    { decisionId: 'mock-2', kind: 'anomaly', status: 'alert', roomId: '', roomName: '강의실', floor: '2F', use: '강의실', message: '2F 강의실: 설정온도 24℃에 도달하지 못하고 있어요(현재 27.1℃). 실내기 점검이 필요해요.', createdAt: at(15), evidence: { temp: 27.1, setpoint: 24 } },
    { decisionId: 'mock-1', kind: 'idle', status: 'applied', roomId: '', roomName: '연구실', floor: '3F', use: '연구실', message: '3F 연구실: 빈 방이라 냉난방을 껐어요(0.8kW).', createdAt: at(40), autoApply: true, jev: { choice: 'empty', confidence: 0.97, probabilities: { empty: 0.97 } }, evidence: { facts: { idleOnMinutes: 45 } } },
  ]
  return { settings: { buildingId: building, autoApply: false, updatedAt: null, updatedBy: null }, decisions, pendingCount: 1, mock: true }
}

export function mockOps(building: string): OpsOverview {
  if (!store.has(building)) store.set(building, seed(building))
  return structuredClone(store.get(building)!)
}

export function mockOpsSettings(building: string, autoApply: boolean) {
  const o = store.get(building) ?? seed(building)
  o.settings = { ...o.settings, autoApply, updatedAt: kstNow(), updatedBy: '목업' }
  store.set(building, o)
  return o.settings
}

const NEXT: Record<OpsAction, Decision['status']> = { accept: 'accepted', reject: 'rejected', undo: 'reverted' }
export function mockOpsAct(building: string, id: string, action: OpsAction): Decision {
  const o = store.get(building) ?? seed(building)
  const d = o.decisions.find((x) => x.decisionId === id)
  if (!d) throw Object.assign(new Error('없는 제안입니다.'), { status: 404 })
  d.status = NEXT[action]
  d.decidedAt = kstNow()
  o.pendingCount = o.decisions.filter((x) => x.status === 'pending').length
  store.set(building, o)
  return structuredClone(d)
}
