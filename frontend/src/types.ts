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

export type Status = {
  generatedAt: string
  refreshSeconds: number
  virtual: boolean
  building: Building
  outdoorTemp: number
  floors: string[]
  summary: Summary
  rooms: Room[]
  mock?: boolean
}

// 전체 현황(lambda/src/portfolio.py): alert 이상 1건 이상, warn 절감 가능량이 오늘 사용량의 10% 이상, ok 그 외
export type Level = 'alert' | 'warn' | 'ok'
export type BuildingCard = Building & { now: Summary; todayKwh: number; savingKwh: number; level: Level }
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
}

export type QueryResult = { answer: string; highlight: string[]; draft: Draft | null; mock?: boolean }

export type Mode = 'temp' | 'powerKw' | 'humidity' | 'anomaly'
