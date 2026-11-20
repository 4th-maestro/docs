// 해시 경로(새 의존성 없이 뒤로·앞으로 이동 지원)
// - #/ 전체 현황, #/b/<id> 건물 운영 탭, #/b/<id>/energy 건물 전력 분석 탭
export type Tab = 'ops' | 'energy'
export type Route = { building: string | null; tab: Tab }
export type FloorSummary = { floor: string; on: number; total: number; anomaly: number; powerKw: number }

export function parseRoute(hash: string): Route {
  const m = /^#\/b\/([\w-]+)(\/energy)?\/?$/.exec(hash)
  return m ? { building: m[1], tab: m[2] ? 'energy' : 'ops' } : { building: null, tab: 'ops' }
}

export const href = (building: string, tab: Tab = 'ops') => `#/b/${building}${tab === 'energy' ? '/energy' : ''}`
