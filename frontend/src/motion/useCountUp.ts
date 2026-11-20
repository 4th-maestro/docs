import { useEffect, useRef, useState } from 'react'

// 숫자 증가(넉터 design-system-motion.md 6.6 useCountUp): 이전 값에서 새 값까지 460ms, 첫 표시는 전달값 그대로
// - 적용 대상: 재조회로 같은 자리의 값만 바뀌는 지표(수치 카드, 패널 대표 수치, 층 전력). 표·목록 행 값은 고정 표시
// - 동작 줄이기 설정이면 바로 교체
export const SLOW_MS = 460
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const ease = (t: number) => 1 - (1 - t) ** 3

export function useCountUp(value: number, ms = SLOW_MS): number {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const raf = useRef(0)
  useEffect(() => {
    const start = from.current
    if (start === value || reduced()) {
      from.current = value
      raf.current = requestAnimationFrame(() => setShown(value))
      return () => cancelAnimationFrame(raf.current)
    }
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms)
      const v = start + (value - start) * ease(p)
      from.current = v
      setShown(v)
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [value, ms])
  return shown
}
