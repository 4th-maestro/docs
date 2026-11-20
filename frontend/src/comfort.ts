import { pmvLabel, roomComfort, type Comfort } from '../twin/pipeline/comfort.js'
import type { Room } from './types'

// 쾌적도(FR-21): ISO 7730 PMV/PPD. 3D 트윈·EnergyPlus 시뮬레이션과 같은 계산(twin/pipeline/comfort.js)
// 복사온도 = 실내온도, 기류 운전 0.15·정지 0.1m/s, 옷은 계절(월), 활동량은 용도로 가정
const KIND: Record<string, string> = { 연구실: 'office', 사무실: 'admin', 강의실: 'lecture', 실험실: 'lab', 회의실: 'meeting', '대기·휴게': 'lounge', 식당: 'restaurant', 상점: 'retail' }
const monthKst = () => new Date(Date.now() + 9 * 3600_000).getUTCMonth() + 1

export const comfortOf = (r: Room): Comfort | null => roomComfort({ temp: r.temp, hum: r.humidity, kind: KIND[r.use], on: r.onOff }, monthKst())

const sign = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`
export const comfortText = (c: Comfort | null) => (c ? `PMV ${sign(c.pmv)} ${pmvLabel(c.pmv)}, 불만족 ${Math.round(c.ppd)}%` : '계산 불가')
