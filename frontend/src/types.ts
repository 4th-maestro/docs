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

export type Status = {
  generatedAt: string
  refreshSeconds: number
  virtual: boolean
  outdoorTemp: number
  floors: string[]
  summary: { on: number; off: number; anomaly: number; powerKw: number }
  rooms: Room[]
  mock?: boolean
}

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
