import type { QueryResult } from '../types'

// AI 질의 단계 이벤트 형식(lambda/src/query.py, ws.py와 같은 필드)
export const STEP_ORDER = ['understand', 'query', 'review', 'answer'] as const
export type StepId = (typeof STEP_ORDER)[number]

export type Step = {
  id: StepId | 'wait' // wait: REST 대기 중 단일 단계(서버 단계를 알 수 없음)
  status: 'active' | 'done' | 'error'
  label: string
  detail?: string
  chips?: string[]
  ms?: number
  at?: number // 화면에서 active를 받은 시각(Date.now), 진행 중 경과 초 계산용
}

export type AskResult = QueryResult & { steps?: Step[] }

export type ServerEvent = { requestId: string } & (
  | ({ type: 'step' } & Step)
  | { type: 'delta'; text: string }
  | { type: 'done'; result: AskResult; ms: number }
  | { type: 'error'; message: string }
)

export type AskState = {
  status: 'idle' | 'running' | 'done' | 'error'
  steps: Step[]
  answer: string
  result: AskResult | null
  startedAt: number
  elapsedMs: number
  transport: 'ws' | 'rest' | 'mock'
  error?: string
}
