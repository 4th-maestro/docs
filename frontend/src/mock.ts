import type { Draft, QueryResult, Room, Status } from './types'

// API를 쓸 수 없을 때 대신 쓰는 목업(건물별 데모 상태 JSON 기반). 결과에는 mock 표시가 붙음
// shortcut: 정규식 해석이라 예시 문장 형태만 처리, Bedrock 연결 후에는 사용되지 않음

// 건물별 public/demo/<id>.json(lambda/tools/demo_status.py 생성), 동시 요청이 한 번만 받도록 Promise 보관
const cache = new Map<string, Promise<Status>>()
export function demoStatus(building: string): Promise<Status> {
  let p = cache.get(building)
  if (!p) {
    p = fetch(`/demo/${encodeURIComponent(building)}.json`).then((r) => r.json() as Promise<Status>).catch(() => {
      cache.delete(building)
      throw new Error('데모 데이터를 불러오지 못했습니다.')
    })
    cache.set(building, p)
  }
  return p
}

export async function demoBuildingIds(): Promise<string[]> {
  return (await fetch('/demo/index.json')).json()
}

// 실시간 수신 목업: 조회할 때마다 범위 안에서 변동(온도 ±0.3℃, 습도 ±1.5%, 전력 ±8%), Lambda sim.py와 같은 범위
const vary = (v: number, d: number) => Math.round((v + (Math.random() * 2 - 1) * d) * 10) / 10
export function live(rooms: Room[]): Room[] {
  return rooms.map((r) => ({
    ...r,
    temp: vary(r.temp, 0.3),
    humidity: vary(r.humidity, 1.5),
    powerKw: r.onOff ? Math.round(r.powerKw * (1 + (Math.random() * 2 - 1) * 0.08) * 100) / 100 : 0,
  }))
}

// 설정온도 변경(3D 트윈의 '이 온도로 적용' 등): 목업 기준값에 덮어써서 다음 조회부터 웹·트윈 모두 반영
// 실온은 바꾼 만큼 따라가고(80%), 전력은 1℃당 8% 변함(냉방은 올리면 감소, 난방은 올리면 증가)
const overrides = new Map<string, number>()
export function setRoomSetpoint(building: string, roomId: string, setpoint: number) { overrides.set(`${building}/${roomId}`, setpoint) }
export function applyOverrides(building: string, rooms: Room[]): Room[] {
  return rooms.map((r) => {
    const sp = overrides.get(`${building}/${r.id}`)
    if (sp == null || sp === r.setpoint) return r
    const d = sp - r.setpoint
    return { ...r, setpoint: sp, temp: Math.round((r.temp + 0.8 * d) * 10) / 10, powerKw: r.onOff ? Math.max(0, Math.round(r.powerKw * (1 + (r.mode === 'cooling' ? -0.08 : 0.08) * d) * 100) / 100) : 0 }
  })
}

export function kstNow() {
  return `${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19)}+09:00`
}

export function summarize(rooms: Room[]) {
  return {
    on: rooms.filter((r) => r.onOff).length, off: rooms.filter((r) => !r.onOff).length,
    anomaly: rooms.filter((r) => r.anomaly).length, powerKw: Math.round(rooms.reduce((s, r) => s + r.powerKw, 0) * 10) / 10,
  }
}

const USES: [RegExp, string][] = [[/회의/, '회의실'], [/사무/, '사무실'], [/진료/, '진료실'], [/강의/, '강의실'], [/연구/, '연구실'], [/실험/, '실험실'], [/휴게|대기/, '대기·휴게']]
const METRICS: [RegExp, keyof Room, string, string][] = [
  [/습도/, 'humidity', '습도', '%'], [/온도/, 'temp', '실내온도', '℃'], [/./, 'powerKw', '전력', 'kW'],
]

export async function mockAsk(text: string, building: string): Promise<QueryResult & { mock: true }> {
  if (/기준|규정/.test(text)) return {
    answer: '이 답변은 근거 문서 표시를 보여 주는 가상 예시입니다.', highlight: [], draft: null, mock: true,
    sources: [{ title: '공공기관 에너지이용 합리화 추진에 관한 규정', url: 'https://www.law.go.kr', date: '2025-01-01', checked: '2026-11-20' }],
  }
  const all = (await demoStatus(building)).rooms
  const fl = text.match(/(\d+)\s*(층|F)/i)
  const floor = fl ? `${fl[1]}F` : 'all'
  const use = USES.find(([re]) => re.test(text))?.[1] ?? 'all'
  const rooms = all.filter((r) => (floor === 'all' || r.floor === floor) && (use === 'all' || r.use === use))
  const where = `${floor === 'all' ? '전체 층' : floor} ${use === 'all' ? '호실' : use}`
  if (!rooms.length) return { answer: `${where}에 해당하는 호실이 없습니다. 층과 용도를 다시 입력하십시오.`, highlight: [], draft: null, mock: true }

  const control = /off|on|끄|꺼|켜|정지/i.test(text)
  if (!control) {
    const [, key, label, unit] = METRICS.find(([re]) => re.test(text))!
    const n = Number(text.match(/(\d+)\s*(곳|개)/)?.[1] ?? 5)
    const asc = /낮은|적은/.test(text)
    const top = [...rooms].sort((a, b) => (asc ? 1 : -1) * ((a[key] as number) - (b[key] as number))).slice(0, n)
    const list = top.map((r) => `${r.name}(${r[key]}${unit})`).join(', ')
    const idle = top.filter((r) => r.onOff && r.occupants === 0).length
    return {
      answer: `${where} 중 ${label} ${asc ? '하위' : '상위'} ${top.length}곳은 ${list}입니다.${idle ? `\n이 중 ${idle}곳은 재실 없이 운전 중이므로 OFF 스케줄을 검토하십시오.` : ''}`,
      highlight: top.map((r) => r.id), draft: null, mock: true,
      charts: [{ kind: 'bar', title: `${where} ${label} ${asc ? '낮은' : '높은'} 순 ${top.length}곳`, unit, items: top.map((r) => ({ id: r.id, label: r.name, sub: `${r.floor}, ${r.use}`, value: r[key] as number })) }],
    }
  }

  const tm = text.match(/(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/)
  const time = tm ? `${tm[1].padStart(2, '0')}:${(tm[2] ?? '0').padStart(2, '0')}` : new Date().toTimeString().slice(0, 5)
  const sp = text.match(/(\d{2})\s*(도|℃)/)
  const action: Draft['action'] = sp ? 'setpoint' : /on|켜/i.test(text) ? 'on' : 'off'
  const condition: Draft['condition'] = /미사용|빈|안 쓰/.test(text) ? 'unused' : 'always'
  const hours = Math.max(0, 21 - Number(time.slice(0, 2)))
  const draft: Draft = {
    roomIds: rooms.map((r) => r.id), roomNames: rooms.slice(0, 10).map((r) => r.name), floor, use, action, time, condition,
    setpoint: sp ? Number(sp[1]) : null,
    estimatedSavingKwh: action === 'off' ? Math.round(rooms.reduce((s, r) => s + r.powerKw, 0) * hours * 0.5 * 10) / 10 : 0,
  }
  const act = action === 'off' ? '냉난방 OFF' : action === 'on' ? '냉난방 ON' : `설정온도 ${draft.setpoint}℃`
  return {
    answer: `${where} ${rooms.length}곳에 ${time} 이후${condition === 'unused' ? ' 재실이 없을 때' : ''} ${act} 스케줄 초안을 만들었습니다.`,
    highlight: draft.roomIds, draft, mock: true,
  }
}
