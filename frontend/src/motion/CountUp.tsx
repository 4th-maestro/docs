import { useCountUp } from './useCountUp'

// 숫자 증가 표시: 소수 자릿수는 목표 값 기준(93.6 → 1자리), 한국어 천 단위 쉼표
const decimals = (v: number) => (Number.isInteger(v) ? 0 : Math.min(3, String(v).split('.')[1]?.length ?? 0))

export default function CountUp({ value, digits }: { value: number; digits?: number }) {
  const shown = useCountUp(value)
  const d = digits ?? decimals(value)
  return <>{shown.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d })}</>
}
