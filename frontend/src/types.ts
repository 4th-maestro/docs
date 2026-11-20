import type { OpsDraft } from './ops/types'
// Lambda 응답 형식(lambda/src/status.py, query.py, schedules.py와 같은 필드)
export type Room = {
  id: string
  idu: string
  name: string
  floor: string
  use: string
  areaM2: number
  occupants: number
  onOff: boolean
  mode: 'cooling' | 'heating'
  setpoint: number
  temp: number
  humidity: number
  powerKw: number
  anomaly: string | null
}

// 건물 정적 정보(lambda/src/buildings.py summary)
export type Building = {
  id: string
  name: string
  use: string
  virtual: boolean
  basis: string
  floors: string[]
  roomCount: number
  areaM2: number
}

export type Summary = { on: number; off: number; anomaly: number; powerKw: number }
export type WifiCounts = Record<string, number | { clients?: number; count?: number }>

export type Status = {
  generatedAt: string
  refreshSeconds: number
  virtual: boolean
  building: Building
  outdoorTemp: number
  floors: string[]
  summary: Summary
  rooms: Room[]
  wifi?: WifiCounts
  mock?: boolean
}

// 전체 현황(lambda/src/portfolio.py): alert 이상 1건 이상, warn 절감 가능량이 오늘 사용량의 10% 이상, ok 그 외
export type Level = 'alert' | 'warn' | 'ok'
// hasTwin: 서버에 트윈 도면(building.json)이 있는지. false면 운영 탭이 트윈 화면 대신 내장 3D 도면 사용(값이 없으면 트윈 요청 결과로 판단)
export type BuildingCard = Building & { now: Summary; todayKwh: number; savingKwh: number; level: Level; hasTwin?: boolean }
export type Portfolio = { generatedAt: string; virtual: boolean; buildings: BuildingCard[]; mock?: boolean }

export type Draft = {
  roomIds: string[]
  roomNames: string[]
  floor: string
  use: string
  action: 'off' | 'on' | 'setpoint'
  time: string
  condition: 'unused' | 'always'
  setpoint: number | null
  estimatedSavingKwh: number
  pick?: 'rooms' | 'group' // 대상 선택 방식: 호실 이름(rooms) 또는 층·용도(group)
}

// AI 답변 그래프(lambda/src/tools.py chart와 같은 형식): 숫자는 서버 도구 결과
export type BarChart = { kind: 'bar'; title: string; unit: string; items: { id?: string; label: string; sub?: string; value: number }[]; prefer?: 'table'; note?: string }
export type LineChart = { kind: 'line'; title: string; unit: string; labels: string[]; series: { name: string; role: 'current' | 'previous'; values: (number | null)[] }[]; prefer?: 'table'; note?: string }
export type Chart = BarChart | LineChart

// AI 답변 근거 문서(lambda 응답 sources): date는 시행일 또는 기준일, checked는 원문 확인일(YYYY-MM-DD)
export type Source = { title: string; url: string; date: string; checked?: string }

export type QueryResult = { opsDraft?: OpsDraft | null; answer: string; highlight: string[]; draft: Draft | null; charts?: Chart[]; sources?: Source[]; mock?: boolean }

export type Mode = 'temp' | 'powerKw' | 'humidity' | 'comfort' | 'anomaly'
