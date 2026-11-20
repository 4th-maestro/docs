import { color, value } from './heat'
import type { Plan } from './floor-edit'
import type { Mode, Room } from './types'

// 3D 트윈(iframe) 연동 규약: docs/human/reference/twin-embed.md
export const TWIN_URL = import.meta.env.VITE_TWIN_URL as string | undefined
// 같은 서버의 /twin/digital-twin.html 같은 상대 주소도 허용
const twinOrigin = () => new URL(TWIN_URL as string, window.location.href).origin
// 화면 테마: 트윈 첫 표시는 주소의 theme, 이후 전환은 postTheme 메시지(트윈이 수신)
const theme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
export function postTheme(frame: HTMLIFrameElement | null) {
  if (TWIN_URL) frame?.contentWindow?.postMessage({ source: 'maestro', type: 'theme', theme: theme() }, twinOrigin())
}
// 트윈이 그릴 건물: 건물 id(트윈 data/buildings.json의 id)를 주소에 붙임
// - 목록에 없는 건물(서버 건물)은 트윈이 needBuilding으로 building.json을 요청
// - 주소에 theme이 들어가므로 화면은 첫 렌더링 값을 유지(테마 전환 시 iframe 다시 읽기 방지)
export function twinSrc(building: string) {
  const u = new URL(TWIN_URL as string, window.location.href)
  u.searchParams.set('building', building)
  u.searchParams.set('theme', theme())
  // 트윈이 첫 표시부터 앱 안 화면 모드(자체 도구·지표 숨김)로 시작
  u.searchParams.set('host', '1')
  return u.href
}

// 트윈 준비 완료(twin:ready): 메시지 수신 준비 전에 보낸 테마·상태는 유실될 수 있어 이때 다시 보냄
export function onTwinReady(frame: () => HTMLIFrameElement | null, handler: () => void) {
  const listener = (e: MessageEvent) => {
    if (!TWIN_URL || e.origin !== twinOrigin() || e.data?.type !== 'twin:ready' || e.source !== frame()?.contentWindow) return
    handler()
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

// 편집 가능한 트윈 building.json 확인: schema, 건물 크기, 층별 실 목록
export function editablePlan(data: unknown): Plan {
  const plan = data as Partial<Plan> | null
  const size = plan?.building?.size
  if (plan?.schema !== 'twin.building/v1' || !size || !Number.isFinite(size.w) || !Number.isFinite(size.d) ||
    size.w <= 0 || size.d <= 0 || !plan.floors?.length || !plan.floors.every(f => Array.isArray(f.rooms))) {
    throw new Error('편집할 수 있는 평면도 형식이 아닙니다.')
  }
  return { ...(plan as Plan), idus: plan.idus ?? [] }
}

// data: 대시보드가 받은(또는 목업이 만든) 건물 전체 호실 상태 그대로. 트윈은 자체 생성 없이 이 값으로 그린다(화면 값 일치)
export type TwinData = { time: string; outdoorTemp: number; mock: boolean; rooms: Room[] }
export function postState(frame: HTMLIFrameElement | null, building: string, floor: string, mode: Mode, rooms: Room[], highlight: string[], data: TwinData | null) {
  if (!frame?.contentWindow || !TWIN_URL) return
  frame.contentWindow.postMessage(
    {
      source: 'maestro', type: 'state', building, floor, mode, highlight,
      rooms: rooms.map((r) => ({ id: r.id, color: color(mode, r), label: value(mode, r), onOff: r.onOff, anomaly: r.anomaly })),
      data,
    },
    twinOrigin(),
  )
}

export function onRoomSelected(handler: (roomId: string) => void) {
  const listener = (e: MessageEvent) => {
    if (!TWIN_URL || e.origin !== twinOrigin()) return
    if (e.data?.source === 'twin' && e.data.type === 'roomSelected') handler(String(e.data.roomId))
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

// 트윈에서 층·지표를 바꾸면 대시보드 버튼도 따라가게 (트윈 → {source:'twin', type:'floorSelected'|'modeSelected'})
// 트윈이 인식한 건물의 층 목록과 층별 요약 (도면에서 5개 층이 나오면 5개)
export type TwinFloor = { floor: string; on: number; total: number; anomaly: number; powerKw: number }
export type TwinBuilding = { id: string; name: string; floors: TwinFloor[] }

export function onTwinChange(handlers: { floor?: (floor: string) => void; mode?: (mode: Mode) => void; building?: (b: TwinBuilding) => void }) {
  const listener = (e: MessageEvent) => {
    if (!TWIN_URL || e.origin !== twinOrigin() || e.data?.source !== 'twin') return
    if (e.data.type === 'floorSelected' && handlers.floor) handlers.floor(String(e.data.floor))
    if (e.data.type === 'building' && handlers.building && Array.isArray(e.data.floors) && e.data.floors.length)
      handlers.building({ id: String(e.data.id), name: String(e.data.name), floors: e.data.floors as TwinFloor[] })
    if (e.data.type === 'modeSelected' && handlers.mode && ['temp', 'powerKw', 'humidity', 'comfort', 'anomaly'].includes(e.data.mode)) handlers.mode(e.data.mode as Mode)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

// 앱 임베드(2026-11-20): 트윈 안 버튼·칩·패널은 숨기고 앱 카드가 대신함
// - 트윈 → {source:'twin', type:'twinUi', ui, kpis, actions}: 화면 상태, 역할별 지표 칸, 조치 목록(바뀔 때만)
// - 앱 → {source:'maestro', type:'ui', action}: persona:<owner|engineer|facility|sim>, flow, pipes, back, rv:<vol|slice|hum|air>
// idu: 층 보기에서 지금 층의 실내기 유형(cls) 목록(범례용)
export type TwinUi = { view: 'building' | 'floor' | 'room'; persona: string; flow: boolean; pipes: boolean; rv: Record<string, boolean>; idu?: string[] }
export type TwinKpi = { key: string; label: string; value: string; unit: string; bad: boolean }
export type TwinActionItem = { room: string; floor: string; title: string; detail: string; lv: number }
export type TwinActions = { title: string; scope: string; hero: { label: string; value: string; note: string } | null; items: TwinActionItem[] }
// 데이터 흐름(트윈 보고, 흐름을 켰을 때만): 수집 데이터 → 트윈 정보(현재 값) → 받는 사람
export type TwinFlow = {
  sources: { key: string; org: string; label: string; name: string; what: string }[]
  infos: { id: string; label: string; value: string; src: string[]; to: string[] }[]
  personas: { key: string; name: string; why: string }[]
}
export type TwinReport = { ui: TwinUi; kpis: TwinKpi[]; actions: TwinActions | null; flow: TwinFlow | null }
export function onTwinReport(frame: () => HTMLIFrameElement | null, handler: (r: TwinReport) => void) {
  const listener = (e: MessageEvent) => {
    if (!TWIN_URL || e.origin !== twinOrigin() || e.data?.source !== 'twin' || e.data.type !== 'twinUi') return
    if (e.source !== frame()?.contentWindow || !e.data.ui) return
    handler({ ui: e.data.ui as TwinUi, kpis: (e.data.kpis ?? []) as TwinKpi[], actions: (e.data.actions ?? null) as TwinActions | null, flow: (e.data.flow ?? null) as TwinFlow | null })
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
export function postUi(frame: HTMLIFrameElement | null, action: string) {
  if (TWIN_URL) frame?.contentWindow?.postMessage({ source: 'maestro', type: 'ui', action }, twinOrigin())
}

// 서버 건물: 트윈 폴더에 도면이 없어서 트윈이 요청하면 서버 building.json(GET /buildings/{id}/twin)을 보냄, 없으면 null
export function onNeedBuilding(frame: () => HTMLIFrameElement | null, get: (id: string) => Promise<unknown>) {
  const listener = (e: MessageEvent) => {
    if (!TWIN_URL || e.origin !== twinOrigin() || e.data?.source !== 'twin' || e.data.type !== 'needBuilding') return
    const target = frame()?.contentWindow
    if (!target || e.source !== target) return
    const id = String(e.data.id)
    get(id).catch(() => null).then((data) => target.postMessage({ source: 'maestro', type: 'buildingData', id, data }, twinOrigin()))
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

// 트윈 파이프라인(도면 → building.json) 주소와 '트윈에서 렌더링' 결과 수신
export function pipelineSrc() {
  if (!TWIN_URL) return null
  const url = new URL('pipeline.html', new URL(TWIN_URL, window.location.href))
  url.searchParams.set('quick', '1')
  url.searchParams.set('theme', theme())
  return url.href
}
export function onBuildingRendered(handler: (building: unknown) => void) {
  const listener = (e: MessageEvent) => {
    if (!TWIN_URL || e.origin !== twinOrigin() || e.data?.source !== 'twin' || e.data.type !== 'buildingRendered' || !e.data.building) return
    handler(e.data.building)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

// 운전 시뮬레이션(EnergyPlus): 트윈이 계산하고 결과를 보내면 대시보드 패널에 그림 (트윈 안 패널은 작아서 옮김)
// period: 'now' = 지금부터 durH시간(기준 = 현재 설정 유지 예측), 'range' = 시작·끝 시각 지정(기준 = 오늘 실제 운전 또는 기존 운전)
export type SimForm = { mode?: 'cool' | 'heat'; coolSetpoint: number | string; start: string; end: string; offWhenEmpty: boolean; precoolMin: number | string; useLive: boolean; period: 'now' | 'range'; durH: number | string }
type WinSide = { kwh: number; won: number; avgT: number | null; maxT: number | null }
export type SimWindow = { from: number; to: number; hours: number; label: string; clipped: boolean; setpoint: number; base: WinSide; scenario: WinSide; savedKwh: number; savedWon: number; savedPct: number | null; afterSavedKwh: number }
type Kpi = { elecKwh: number; costWon: number; tdisKhPerZone: number; ppd: number; uncomfortPct: number; hottest?: { tempC: number; room: string } }
// coolSetpoint = 설정온도 (난방 모드면 난방 설정온도. 필드 이름은 트윈·서버와 호환을 위해 그대로)
export type SimMode = 'cool' | 'heat'
type Scen = { mode?: SimMode; coolSetpoint: number; hours: string[]; offWhenEmpty?: boolean; precoolMin?: number }
export type SimRoom = { id: string; name: string; floor: string; maxT: number; avgT: number; baseAvgT?: number; ppd: number; basePpd?: number; kwh: number; baseKwh?: number }
export type SimState = {
  mode?: SimMode; form: SimForm; base: Scen; hasLive: boolean; occ: string; busy: boolean; msg: string; scope: string
  result: null | {
    mode?: SimMode; window: SimWindow | null; baseName: string
    live: { date: string; day: string; now: number; weather: { min: number; max: number } } | null; weather: string; days: number; engine: string
    compare: { savedKwh: number; savedPct: number; savedWon: number; tdisChange: number; ppdChange: number }
    restOfDay: { fromHour: number; savedKwh: number; savedWon: number } | null
    calibration: { factor: number; hours: number; measuredKwh: number; cvrmsePct: number | null; cvrmseRawPct: number | null; note: string } | null
    comfort: { lower: number; upper: number } | null
    baseline: { kpi: Kpi; scenario: Scen; avgT: number | null }; scenario: { kpi: Kpi; scenario: Scen; avgT: number | null }; rooms: SimRoom[]
  }
}
export function onTwinSim(handler: (s: SimState) => void) {
  const listener = (e: MessageEvent) => {
    if (!TWIN_URL || e.origin !== twinOrigin() || e.data?.source !== 'twin' || e.data.type !== 'sim') return
    handler(e.data as SimState)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
// 채팅 what-if 결과: stage 'fast' = 5R1C 즉시 계산(브라우저, 수십 ms), 'final' = EnergyPlus 정밀 계산(서버) 또는 서버가 없을 때 5R1C 그대로(onlyFast)
// window = 계산 구간·절감·대상 호실 평균 실온, accuracy = 5R1C의 EnergyPlus 대비 검증 오차(tools/calibrate-5r1c.mjs)
export type SimAnswer = { id: string; ok: boolean; stage?: 'fast' | 'final'; error?: string; mode?: SimMode; window?: SimWindow; calibration?: number; engine?: string; seconds?: number | null; ms?: number
  accuracy?: { cvrmsePct: number | null; nmbePct: number | null; tempRmseC: number | null; pass: boolean } | null; fast?: { savedKwh: number; savedWon: number; ms: number } | null; onlyFast?: boolean; note?: string }
export function onTwinSimAnswer(handler: (a: SimAnswer) => void) {
  const listener = (e: MessageEvent) => {
    if (!TWIN_URL || e.origin !== twinOrigin() || e.data?.source !== 'twin' || e.data.type !== 'simAnswer') return
    handler(e.data as SimAnswer)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
export function sendTwin(frame: HTMLIFrameElement | null, msg: Record<string, unknown>) {
  if (TWIN_URL) frame?.contentWindow?.postMessage({ source: 'maestro', ...msg }, twinOrigin())
}

// 트윈에서 방 설정온도를 바꾸면(방 화면 '이 온도로 적용') 대시보드가 실행 (목업은 기준값에 반영)
export function onTwinControl(handler: (room: string, setTemp: number) => void) {
  const listener = (e: MessageEvent) => {
    if (!TWIN_URL || e.origin !== twinOrigin() || e.data?.source !== 'twin' || e.data.type !== 'control' || typeof e.data.setTemp !== 'number') return
    handler(String(e.data.room), e.data.setTemp)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
