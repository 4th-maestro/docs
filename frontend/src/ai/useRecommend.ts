import { useCallback, useMemo } from 'react'
import { getRecommendations } from '../api'
import type { Draft } from '../types'
import { usePoll } from '../panels/usePoll'

// 대화 머리글 최적 제어 추천 입력(App 전달)
// - floor: 층 이름, ''이면 건물 전체(floor 파라미터 생략)
// - refreshKey: 스케줄 저장 후 App이 올리는 값
export type RecommendProps = { building: string; floor: string; refreshKey: number; onDraft(draft: Draft): void; onLocate(roomId: string): void }

// 최적 제어 추천 조회: 60초 주기, 층·refreshKey 변경 시 다시 조회하고 응답 전까지 이전 값 흐리게 유지(stale)
export function useRecommend({ building, floor, refreshKey }: RecommendProps) {
  const arg = useMemo(() => ({ floor, refreshKey }), [floor, refreshKey])
  const load = useCallback((a: { floor: string }) => getRecommendations(a.floor, building), [building])
  return usePoll(load, arg)
}
