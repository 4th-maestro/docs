// 해시 경로(새 의존성 없이 뒤로·앞으로 이동 지원)
// - #/ 전체 현황, #/b/<id> 건물 운영 탭, #/b/<id>/energy 건물 전력 분석 탭, #/b/<id>/sim 건물 운전 시뮬레이션 탭, #/settings 고객사 기업 설정(조회 전용)
// - #/admin 기업 관리, #/admin/<기업 id> 기업 상세
// - #/admin/<기업 id>/buildings/new 건물 추가(방법 선택), .../new/image 도면 이미지 단계, .../new/file 도면 파일(IFC, CAD, PDF) 단계
// - #/admin/<기업 id>/buildings/<건물 id>/replace 도면 교체(방법 선택), .../replace/image 도면 이미지 단계, .../plan 도면 편집
export type Tab = 'ops' | 'energy' | 'sim'
export type AdminSub = { kind: 'new' | 'replace' | 'plan'; building?: string; image: boolean; file?: boolean }
export type Route = { building: string | null; tab: Tab; admin?: boolean; company?: string; sub?: AdminSub; settings?: boolean }
export type FloorSummary = { floor: string; on: number; total: number; anomaly: number; powerKw: number }

export function parseRoute(hash: string): Route {
  const a = /^#\/admin(?:\/([\w-]+)(?:\/buildings\/(?:(new)|([\w-]+)\/(replace|plan))(\/image|\/file)?)?)?\/?$/.exec(hash)
  if (a) {
    const sub: AdminSub | undefined = a[2] || a[4] ? { kind: a[2] ? 'new' : (a[4] as 'replace' | 'plan'), building: a[3], image: a[5] === '/image', file: a[5] === '/file' } : undefined
    return { building: null, tab: 'ops', admin: true, company: a[1], sub }
  }
  if (/^#\/settings\/?$/.test(hash)) return { building: null, tab: 'ops', settings: true }
  const m = /^#\/b\/([\w-]+)(\/energy|\/sim)?\/?$/.exec(hash)
  return m ? { building: m[1], tab: m[2] ? (m[2].slice(1) as Tab) : 'ops' } : { building: null, tab: 'ops' }
}

export const href = (building: string, tab: Tab = 'ops') => `#/b/${building}${tab === 'ops' ? '' : `/${tab}`}`
