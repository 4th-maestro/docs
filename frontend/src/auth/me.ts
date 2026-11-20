import { createContext } from 'react'
import type { Me, Role } from '../api'

// 로그인 사용자 소속(GET /me): App이 로그인 후 조회, 화면 틀이 기업 이름과 관리자 메뉴 표시에 사용
// - null: 조회 전, 조회 실패(API 없음·목업), 로그인 생략
export const MeContext = createContext<Me | null>(null)

export const ROLE: Record<Role, string> = { admin: '판매사 관리자', manager: '고객사 관리자', operator: '운영자' }
// 소속 다시 조회 요청: 구성원 역할 변경·제외 후 App이 GET /me를 다시 호출(사이드바 역할 표시, 제외 시 소속 기업 없음 화면)
export const ME_CHANGED = 'maestro:me'
