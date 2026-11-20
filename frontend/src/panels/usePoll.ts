import { useCallback, useEffect, useState } from 'react'

// 패널 주기 조회
// - 첫 응답 전: data=null(스켈레톤)
// - 인자(층 등) 변경 후 응답 전: 이전 값 유지, stale=true(흐리게 표시해 레이아웃 이동 방지)
// - 실패: error 표시, 이전 값 유지
export function usePoll<A, T>(fn: (arg: A) => Promise<T>, arg: A, ms = 60_000) {
  const [state, setState] = useState<{ arg: A; data: T } | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    const run = () => fn(arg).then(
      (data) => { if (alive) { setState({ arg, data }); setError('') } },
      (e: Error) => { if (alive) setError(e.message) },
    )
    run()
    const id = setInterval(run, ms)
    return () => { alive = false; clearInterval(id) }
  }, [fn, arg, ms, tick])
  // reload는 고정 함수: 이벤트·타이머에 등록해도 렌더링마다 다시 등록되지 않음
  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { data: state?.data ?? null, stale: state !== null && state.arg !== arg, error, reload }
}

export const hhmm = (iso: string) => iso.slice(11, 16)
