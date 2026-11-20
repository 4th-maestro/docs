import { useCallback, useState } from 'react'
import type { Period } from './api'

// 한국어 숫자 표기(천 단위 쉼표), 소수점 이하는 digits자리까지
export const fmt = (v: number, digits = 1) => v.toLocaleString('ko-KR', { maximumFractionDigits: digits })

// 이전 값 대비 증감률(%), 이전 값이 0이면 비교 불가
export const change = (cur: number, prev: number) => (prev > 0 ? Math.round((cur / prev - 1) * 1000) / 10 : null)

export const NAMES: Record<Period, { cur: string; prev: string; same: string }> = {
  day: { cur: '오늘', prev: '어제', same: '어제 같은 시각' },
  week: { cur: '이번 주', prev: '지난주', same: '지난주 같은 시점' },
  month: { cur: '이번 달', prev: '지난달', same: '지난달 같은 시점' },
}

// y축 눈금 간격: 최댓값의 1/4 이상인 1·1.5·2·2.5·3·4·5·10 × 10^n 중 최솟값(PowerTrend와 같은 규칙)
const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 10]
export function niceStep(max: number) {
  const raw = Math.max(max, 1) / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  return STEPS.find((s) => s * p >= raw)! * p
}

// 실제 픽셀 너비 측정: viewBox 확대·축소는 390px 화면에서 축 글자를 14px 미만으로 줄임
export function useWidth() {
  const [w, setW] = useState(0)
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [w, ref] as const
}

// 툴팁 가로 위치: 기준점 오른쪽, 넘치면 왼쪽
export const tipLeft = (x: number, w: number, tipW = 176) => Math.max(0, x + 12 + tipW > w ? x - 12 - tipW : x + 12)
