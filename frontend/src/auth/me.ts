import { createContext } from 'react'
import type { Me, Role } from '../api'

// 로그인 사용자 소속(GET /me): App이 로그인 후 조회, 화면 틀이 기업 이름과 관리자 메뉴 표시에 사용
// - null: 조회 전, 조회 실패(API 없음·목업), 로그인 생략
export const MeContext = createContext<Me | null>(null)

export const ROLE: Record<Role, string> = { admin: '판매사 관리자', manager: '고객사 관리자', operator: '운영자' }
