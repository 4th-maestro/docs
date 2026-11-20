import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { change } from './util'

// 증감 표시: 화살표 아이콘 + 글자(색만으로 구분하지 않음)
export function Delta({ cur, prev }: { cur: number; prev: number }) {
  const d = change(cur, prev)
  if (d === null) return <span className="en-delta">비교 값 없음</span>
  const Icon = d > 0 ? ArrowUp : d < 0 ? ArrowDown : Minus
  return (
    <span className="en-delta">
      <Icon size={16} strokeWidth={2.5} aria-hidden />
      {d === 0 ? '변동 없음' : `${Math.abs(d)}% ${d > 0 ? '증가' : '감소'}`}
    </span>
  )
}

// 범례·툴팁의 선 표시: 이번 기간 실선, 지난 기간 점선
export function LineKey({ dashed }: { dashed?: boolean }) {
  return (
    <svg width="16" height="8" aria-hidden>
      <line x1="2" x2="14" y1="4" y2="4" stroke={dashed ? 'var(--en-prev)' : 'var(--en-cur)'} strokeWidth="2" strokeLinecap={dashed ? 'butt' : 'round'} strokeDasharray={dashed ? '4 4' : undefined} />
    </svg>
  )
}

// 같은 줄 선택 버튼: 높이 44px, 너비 1:1(energy.css .en-seg)
export function Seg<T extends string>({ label, options, value, onChange }: { label: string; options: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="en-seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  )
}
