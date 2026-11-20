import { useEffect, useRef, useState } from 'react'

// 도면 변환 진행률: 단계별 예상 시간(초) 합 기준 0~100%, 진행 중 단계는 경과 시간으로 채움(예상의 95%에서 멈춤)
// - 서버는 단계 이름만 알려 줌(진행률 없음). 예상 시간은 CloudWatch 실측(2026-11-21, 최근 3일):
//   파일 해석 IngestFunction 상위 10% 16.4초, 실내기 인식 DetectFunction 쪽당 중앙값 21.9초
// - 업로드는 파일 크기 기준(초당 4MB 가정)
export type ProgStep = { id: string; label: string; sec: number }
export default function ConvertProgress({ steps, at, state }: { steps: ProgStep[]; at: number; state: 'running' | 'done' | 'failed' }) {
  const start = useRef(0)
  const [el, setEl] = useState(0)
  useEffect(() => {
    start.current = performance.now()
    if (state !== 'running') return
    const id = setInterval(() => setEl((performance.now() - start.current) / 1000), 250)
    return () => { clearInterval(id); setEl(0) }
  }, [at, state])
  const total = steps.reduce((s, x) => s + x.sec, 0) || 1
  const done = steps.slice(0, Math.max(0, at)).reduce((s, x) => s + x.sec, 0)
  const cur = steps[at]?.sec ?? 0
  const pct = state === 'done' ? 100 : Math.min(97, ((done + cur * Math.min(cur ? el / cur : 0, 0.95)) / total) * 100)
  const left = Math.max(1, Math.round(total - done - Math.min(el, cur)))
  const label = steps[at]?.label
  const text = state === 'done' ? '완료' : state === 'failed' ? `${label ?? ''} 실패` : el > cur * 1.5 + 3 ? '예상보다 오래 걸리고 있습니다' : `약 ${left}초 남음`
  return (
    <div className={`ingest-prog ${state}`} role="progressbar" aria-label="도면 변환 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-valuetext={`${Math.round(pct)}%, ${label ?? ''} ${text}`}>
      <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      <div className="prog-meta"><b>{Math.round(pct)}%</b>{state === 'running' && label && <span>{label} 중</span>}<span>{text}</span></div>
    </div>
  )
}
