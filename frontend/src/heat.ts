import { comfortOf, comfortText } from './comfort'
import type { Mode, Room } from './types'

// 순차 색: 지표별 단일 색상 5단계(밝음→어두움). 주 색상 #ff385c는 사용하지 않음
export const SCALES: Record<Exclude<Mode, 'anomaly' | 'comfort'>, { label: string; unit: string; min: number; max: number; colors: string[] }> = {
  temp: { label: '온도', unit: '℃', min: 16, max: 28, colors: ['#FFF1E0', '#FFD3A1', '#F9A65A', '#E5762A', '#B45309'] },
  powerKw: { label: '전력', unit: 'kW', min: 0, max: 6, colors: ['#E8F0FE', '#BFD4FB', '#7FA8F2', '#3F7AE0', '#1E4FB0'] },
  humidity: { label: '습도', unit: '%', min: 30, max: 70, colors: ['#E6F7F5', '#B4E8E2', '#6ECFC4', '#2BA89B', '#0F766E'] },
}

// 쾌적도(PMV): 발산 색 5단계, 가운데(|PMV| < 0.5 쾌적)가 가장 밝음. 경계 −1.5, −0.5, +0.5, +1.5
export const COMFORT = { edges: [-1.5, -0.5, 0.5, 1.5], colors: ['#1E4FB0', '#9CC0F5', '#F4F4F4', '#F9A65A', '#B45309'] }

export const ANOMALY = '#B91C1C'

const comfortIndex = (room: Room) => {
  const c = comfortOf(room)
  return c ? COMFORT.edges.filter((e) => c.pmv >= e).length : -1
}

export function color(mode: Mode, room: Room): string {
  if (mode === 'anomaly') return room.anomaly ? '#FDECEC' : room.onOff ? '#F7F7F7' : '#EBEBEB'
  if (mode === 'comfort') { const i = comfortIndex(room); return i < 0 ? '#EBEBEB' : COMFORT.colors[i] }
  const s = SCALES[mode]
  const i = Math.round(((room[mode] - s.min) / (s.max - s.min)) * (s.colors.length - 1))
  return s.colors[Math.min(s.colors.length - 1, Math.max(0, i))]
}

// 배경이 어두운 단계는 흰 글자
export function ink(mode: Mode, room: Room): string {
  if (mode === 'anomaly') return '#222222'
  if (mode === 'comfort') { const i = comfortIndex(room); return i === 0 || i === 4 ? '#FFFFFF' : '#222222' }
  return SCALES[mode].colors.indexOf(color(mode, room)) >= 3 ? '#FFFFFF' : '#222222'
}

export function value(mode: Mode, room: Room): string {
  if (mode === 'anomaly') return room.anomaly ? '설정온도 미도달' : room.onOff ? '정상' : '정지'
  if (mode === 'comfort') return comfortText(comfortOf(room))
  return `${room[mode]}${SCALES[mode].unit}`
}
