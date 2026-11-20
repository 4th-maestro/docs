import { scopeOf } from './mock'
import type { SimAnswer } from './twin'
import type { Draft, Room } from './types'

// 채팅 what-if: "3층 강의실 18도로 낮추면?" · "5층 회의실 26℃로 올리면 얼마나 아껴?" · "2층 연구실 22도로 3시간 바꾸면?"
// → 트윈이 그 방들만 지금부터 N시간 설정온도를 바꿔 계산 (기준 = 현재 설정 유지 예측, 오늘 실측 기준)
//   5R1C로 즉시 답하고(브라우저, 수십 ms) 계산 서버가 있으면 EnergyPlus 정밀 값(실측 전력 보정)으로 바꿈
// 서버 AI(Bedrock)가 아직 what-if 도구가 없어서 화면에서 바로 처리. 결과에는 그대로 저장할 수 있는 설정온도 스케줄 초안을 붙임
export type WhatIf = { id: string; roomIds: string[]; names: string[]; floor: string; use: string; where: string; setpoint: number; hours: number }

const SP = /(\d{2}(?:\.\d)?)\s*(?:도|℃|°C?)/
const ASK = /(?:하면|으?면)\s*(?:\?|$|어떻|얼마|몇|전력|요금|절감)|어떻게\s*(?:돼|되)|얼마나|예상|what.?if/i

export function parseWhatIf(text: string, all: Room[], uid: () => string): WhatIf | null {
  const sp = text.match(SP)
  if (!sp || !ASK.test(text)) return null
  const setpoint = Number(sp[1])
  if (setpoint < 16 || setpoint > 30) return null
  const { floor, use, rooms, where } = scopeOf(text, all)
  const hours = Math.min(8, Math.max(1, Number(text.match(/(\d)\s*시간/)?.[1] ?? 2)))
  return { id: uid(), roomIds: rooms.map((r) => r.id), names: rooms.slice(0, 10).map((r) => r.name), floor, use, where, setpoint, hours }
}

const f1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : v.toLocaleString('ko-KR', { maximumFractionDigits: 1 }))
const won = (v: number) => `₩${Math.round(Math.abs(v)).toLocaleString('ko-KR')}`

export const pendingText = (w: WhatIf) =>
  `${w.where} ${w.roomIds.length}곳의 설정온도를 지금부터 ${w.hours}시간 ${w.setpoint}℃로 바꾸는 경우를 계산하고 있습니다.`

// 출처 문구: 즉시 = 5R1C(EnergyPlus 대비 검증 오차), 정밀 = EnergyPlus(+ 즉시 값과 차이), 서버 없음 = 5R1C만
function sourceText(a: SimAnswer) {
  const acc = a.accuracy ? ` · EnergyPlus 대비 검증 오차 CV(RMSE) ${f1(a.accuracy.cvrmsePct)}%, NMBE ${f1(a.accuracy.nmbePct)}%` : ' · 보정 전 기본 계수'
  if (a.stage === 'fast') return `5R1C 즉시 계산 ${a.ms ?? 0}ms${acc} — EnergyPlus 정밀 계산 중…`
  if (a.onlyFast) return `5R1C 즉시 계산${acc} · EnergyPlus 정밀 계산은 생략(${a.note ?? '계산 서버 없음'})`
  const cal = a.calibration && a.calibration !== 1 ? ` · 실측 보정 ×${f1(a.calibration)}` : ''
  const fast = a.fast ? ` · 5R1C 즉시 값 ${f1(a.fast.savedKwh)}kWh` : ''
  return `EnergyPlus 정밀 계산 ${f1(a.seconds)}초${cal}${fast}`
}

export function answerText(w: WhatIf, a: SimAnswer) {
  if (!a.ok || !a.window) return `계산하지 못했습니다. ${a.error ?? ''}`
  const W = a.window, mk = a.mode === 'heat' ? '난방' : '냉방', d = W.savedKwh
  const power = Math.abs(d) < 0.05 ? '전력 차이는 거의 없고' : d > 0 ? `전력 ${f1(d)}kWh(${won(W.savedWon)}) 절감,` : `전력 ${f1(-d)}kWh(${won(W.savedWon)}) 증가,`
  const temp = W.base.avgT != null && W.scenario.avgT != null ? ` 대상 호실 평균 실온은 ${f1(W.base.avgT)} → ${f1(W.scenario.avgT)}℃로 예상됩니다.` : ' 계산 구간에 운전 중인 대상 호실이 없어 실온 변화는 없습니다.'
  return `${w.where} ${w.roomIds.length}곳 ${mk} 설정을 ${W.label} 동안 ${w.setpoint}℃로 바꾸면, 현재 설정 유지 대비 ${power}${temp}${W.clipped ? ' (오늘 24시까지만 계산)' : ''} 이대로 적용하려면 아래 초안을 저장하십시오. (${sourceText(a)} · 오늘 실측 기준)`
}

export function draftOf(w: WhatIf, a: SimAnswer): Draft {
  const t = new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16)
  return { roomIds: w.roomIds, roomNames: w.names, floor: w.floor, use: w.use, action: 'setpoint', time: t, condition: 'always', setpoint: w.setpoint,
    estimatedSavingKwh: Math.max(0, Math.round((a.window?.savedKwh ?? 0) * 10) / 10) }
}
