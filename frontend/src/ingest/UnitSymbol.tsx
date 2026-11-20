import { TYPES } from './units'

// 유형 기호: 같은 테두리(사각형)에 토출구 선(카세트), 흡입구 격자선(덕트), 얇은 본체(벽걸이), 원(스탠드)으로 구분. 오른쪽(x+)이 토출 방향
const MARK: Record<string, string> = {
  cassette_4way: 'M.55 -.6V.6M-.55 -.6V.6M-.6 .55H.6M-.6 -.55H.6',
  cassette_2way: 'M.55 -.6V.6M-.55 -.6V.6',
  cassette_1way: 'M.55 -.6V.6',
  ceiling_duct: 'M-.6 -.45H.3M-.6 0H.3M-.6 .45H.3M.6 -.7V.7',
  wall_mounted: 'M.15 -.8V.8',
}
export function UnitSymbol({ cls }: { cls: string }) {
  const wall = cls === 'wall_mounted'
  return <g className="sym">
    {wall ? <rect x="-.35" y="-1" width=".7" height="2" rx=".1" /> : <rect x="-1" y="-1" width="2" height="2" rx=".15" />}
    {MARK[cls] && <path d={MARK[cls]} />}
    {cls === 'floor_standing' && <circle r=".45" />}
    {cls === 'unknown' && <text textAnchor="middle" dominantBaseline="central" fontSize="1.4">?</text>}
  </g>
}
export const UnitIcon = ({ cls }: { cls: string }) => <svg className="sym-icon" viewBox="-1.4 -1.4 2.8 2.8" aria-hidden><UnitSymbol cls={cls} /></svg>

// 범례: 유형 6종, 확인 필요, 선택, 좌표 단위
export function UnitLegend() {
  return <ul className="unit-legend" aria-label="실내기 범례">
    {TYPES.map(t => <li key={t.class}><UnitIcon cls={t.class} />{t.name}</li>)}
    <li><svg className="sym-icon" viewBox="-1.4 -1.4 2.8 2.8" aria-hidden><rect className="sym-review" x="-1.2" y="-1.2" width="2.4" height="2.4" rx=".2" /></svg>확인 필요</li>
    <li><svg className="sym-icon" viewBox="-1.4 -1.4 2.8 2.8" aria-hidden><rect className="sym-selected" x="-1.2" y="-1.2" width="2.4" height="2.4" rx=".2" /></svg>선택</li>
    <li>좌표 단위 m</li>
  </ul>
}
