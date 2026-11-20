// 운영 패널 API 응답 형식(lambda/src/recommend.py, anomalies.py, history.py, schedules.py와 같은 필드)
import type { Draft } from '../types'

export type Rule = 'idle' | 'after_hours' | 'overset'

export type Recommendation = {
  id: string
  roomId: string
  roomName: string
  idu: string
  floor: string
  use: string
  rule: Rule
  title: string
  reason: string
  savingKwhDay: number
  draft: Draft
}

export type Recommendations = { generatedAt: string; totalSavingKwh: number; items: Recommendation[]; mock?: boolean }

export type Likelihood = 'high' | 'medium' | 'low'

export type Anomaly = {
  roomId: string
  roomName: string
  idu: string
  floor: string
  use: string
  mode: 'cooling' | 'heating'
  setpoint: number
  temp: number
  gap: number
  expectedTemp: number
  residual: number
  peerCount: number
  powerKw: number
  occupants: number
  detectedAt: string
  durationMin: number
  causes: { label: string; likelihood: Likelihood; evidence: string }[]
}

// causeBasis: 원인 후보는 규칙 기반 추정
export type Anomalies = { generatedAt: string; causeBasis: 'rule'; items: Anomaly[]; mock?: boolean }

export type HourPoint = { hour: number; kw: number; kwh: number }

export type History = { generatedAt: string; floor: string; today: HourPoint[]; yesterday: HourPoint[]; mock?: boolean }

export type Schedule = {
  id: string
  buildingId?: string // 값이 없는 이전 항목은 main
  roomIds: string[]
  action: Draft['action']
  time: string
  condition: Draft['condition']
  setpoint?: number
  createdAt: string
  sourceText: string
}

export type Schedules = { schedules: Schedule[]; mock?: boolean }
