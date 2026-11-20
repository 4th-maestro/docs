// 해시 경로(새 의존성 없이 뒤로·앞으로 이동 지원)
// - #/ 전체 현황, #/b/<id> 건물 운영 탭, #/b/<id>/energy 건물 전력 분석 탭, #/admin 사용자 관리
export type Tab = 'ops' | 'energy'
export type Route = { building: string | null; tab: Tab; admin?: boolean }
export type FloorSummary = { floor: string; on: number; total: number; anomaly: number; powerKw: number }

export function parseRoute(hash: string): Route {
  if (/^#\/admin\/?$/.test(hash)) return { building: null, tab: 'ops', admin: true }
  const m = /^#\/b\/([\w-]+)(\/energy)?\/?$/.exec(hash)
  return m ? { building: m[1], tab: m[2] ? 'energy' : 'ops' } : { building: null, tab: 'ops' }
}

export const href = (building: string, tab: Tab = 'ops') => `#/b/${building}${tab === 'energy' ? '/energy' : ''}`
