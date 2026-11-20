import { useCallback, useEffect, useRef, useState } from 'react'
import { ask as askRest } from '../api'
import { getAccessToken } from '../auth/cognito'
import { STEP_ORDER, type AskResult, type AskState, type ServerEvent, type Step } from './types'

// AI 질의 실행 훅
// - 전송: VITE_WS_URL이 있으면 WebSocket으로 단계 이벤트 수신, 없거나 첫 이벤트 전에 연결이 실패하면 REST(api.ts, 실패 시 목업)
// - REST 대기 중: 서버 단계를 알 수 없으므로 '분석 중' 단계 1개만 표시, 완료 후 응답의 steps 표시
// - 제한: 45초 안에 done이 없으면 오류, 이전 요청의 requestId 이벤트는 무시
// - 건물: 질의마다 buildingId 전송(서버가 건물의 층·용도로 도구 인자 검증)
// - shortcut: 질의마다 새 연결(연결 수립 시간 추가), 연속 질의가 잦아지면 연결 재사용과 재연결 처리 추가
const WS_URL = import.meta.env.VITE_WS_URL as string | undefined
const TIMEOUT_MS = 45_000
const TICK_MS = 100
const IDLE: AskState = { status: 'idle', steps: [], answer: '', result: null, startedAt: 0, elapsedMs: 0, transport: WS_URL ? 'ws' : 'rest' }

const rank = (s: Step) => STEP_ORDER.indexOf(s.id as never)

function applyStep(s: AskState, { type: _t, requestId: _r, ...e }: Extract<ServerEvent, { type: 'step' }>): AskState {
  // 도구 호출 앞 텍스트는 답변이 아니므로 query 시작 시 답변 초기화(서버 기록과 같은 규칙)
  const reset = e.id === 'query' && e.status === 'active'
  const prev = s.steps.find((x) => x.id === e.id)
  const at = e.status === 'active' ? (prev?.status === 'active' ? prev.at : Date.now()) : prev?.at
  const steps = [...s.steps.filter((x) => x.id !== e.id && !(reset && x.id === 'answer')), { ...e, at }]
  return { ...s, steps: steps.sort((a, b) => rank(a) - rank(b)), answer: reset ? '' : s.answer }
}

export function useAsk(building: string) {
  const [state, setState] = useState<AskState>(IDLE)
  const cur = useRef<{ id: string; ws?: WebSocket; tick?: number; timeout?: number } | null>(null)

  const end = useCallback(() => {
    const c = cur.current
    if (!c) return
    cur.current = null
    clearInterval(c.tick)
    clearTimeout(c.timeout)
    c.ws?.close()
  }, [])
  useEffect(() => end, [end])

  const reset = useCallback(() => {
    end()
    setState(IDLE)
  }, [end])

  const ask = useCallback((text: string) => {
    end()
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    const c: NonNullable<typeof cur.current> = { id }
    cur.current = c
    const startedAt = Date.now()
    const update = (f: (s: AskState) => AskState) => {
      if (cur.current === c) setState(f)
    }
    const finish = (f: (s: AskState) => AskState) => {
      update((s) => ({ ...f(s), elapsedMs: Date.now() - startedAt }))
      end()
    }
    const fail = (error: string) => finish((s) => ({ ...s, status: 'error', error, steps: s.steps.map((x) => (x.status === 'active' ? { ...x, status: 'error' } : x)) }))
    const succeed = (result: AskResult, transport?: AskState['transport']) =>
      finish((s) => ({ ...s, status: 'done', result, answer: result.answer, steps: result.steps ?? s.steps, transport: transport ?? s.transport }))

    const rest = () => {
      update((s) => ({ ...s, transport: 'rest', steps: [{ id: 'wait', status: 'active', label: '분석 중', at: Date.now() }] }))
      askRest(text, building).then(
        (r: AskResult) => succeed({ ...r, steps: r.steps ?? [] }, r.mock ? 'mock' : 'rest'),
        (e: Error) => fail(e.message),
      )
    }

    setState({ ...IDLE, status: 'running', startedAt, transport: WS_URL ? 'ws' : 'rest' })
    c.tick = window.setInterval(() => update((s) => ({ ...s, elapsedMs: Date.now() - startedAt })), TICK_MS)
    c.timeout = window.setTimeout(() => fail('45초 안에 AI 응답을 받지 못했습니다. 다시 시도하십시오.'), TIMEOUT_MS)
    if (!WS_URL) return rest()
    // 로그인 토큰: 브라우저 WebSocket은 헤더 지정이 불가해 쿼리로 전달(lambda/src/auth.py에서 검증)
    getAccessToken().then((token) => { if (cur.current === c) connect(token) })

    const connect = (token: string | null) => {
      let received = false
      let ws: WebSocket
      try {
        ws = new WebSocket(token ? `${WS_URL}?token=${encodeURIComponent(token)}` : WS_URL!)
      } catch {
        return rest() // 잘못된 주소 형식
      }
      c.ws = ws
      ws.onopen = () => ws.send(JSON.stringify({ action: 'ask', requestId: id, text, buildingId: building }))
      ws.onmessage = (m) => {
        let e: ServerEvent
        try {
          e = JSON.parse(m.data)
        } catch {
          return
        }
        // API Gateway 자체 메시지(요청 시간 초과 등)는 requestId가 달라 무시
        if (e.requestId !== id) return
        received = true
        if (e.type === 'step') update((s) => applyStep(s, e))
        else if (e.type === 'delta') update((s) => ({ ...s, answer: s.answer + e.text }))
        else if (e.type === 'done') succeed(e.result)
        else if (e.type === 'error') fail(e.message)
      }
      // 첫 이벤트 전 실패는 REST로 대체, 진행 중 끊김은 모델 재호출 비용을 피하려고 오류 처리
      ws.onclose = () => {
        if (cur.current !== c) return
        c.ws = undefined
        if (received) fail('AI 연결이 끊어졌습니다. 다시 시도하십시오.')
        else rest()
      }
    }
  }, [end, building])

  return { state, ask, reset }
}
