import { demoStatus, kstNow } from '../mock'
import type { Draft, Room } from '../types'
import type { Anomalies, Anomaly, History, Recommendation, Recommendations, Schedule, Schedules } from './types'

// 운영 패널 목업(public/demo-status.json 기반, 난수 없음). API를 쓸 수 없을 때만 사용, 결과에는 mock 표시
// shortcut: 상태 스냅숏 1개로 판정(15·30분 전 재실, 최근 7일 운전 이력, 주말 구분 없음), Lambda 연결 시에는 사용되지 않음

const r1 = (v: number) => Math.round(v * 10) / 10
const nowParts = () => { const t = kstNow(); return { iso: t, h: Number(t.slice(11, 13)), m: Number(t.slice(14, 16)) } }

function draft(r: Room, action: Draft['action'], condition: Draft['condition'], setpoint: number | null, saving: number): Draft {
  return { roomIds: [r.id], roomNames: [r.name], floor: r.floor, use: r.use, action, time: '00:00', condition, setpoint, estimatedSavingKwh: saving }
}

// 절감량 가정: OFF는 재실 없는 운전 5시간/일, 설정온도 조정은 부하 10% 감소 9시간/일
export async function mockRecommendations(floor: string): Promise<Recommendations> {
  const { iso, h } = nowParts()
  const business = h >= 9 && h < 18
  const items: Recommendation[] = []
  for (const r of (await demoStatus()).rooms.filter((x) => x.floor === floor && x.onOff)) {
    const base = { roomId: r.id, roomName: r.name, idu: r.idu, floor: r.floor, use: r.use }
    if (r.occupants === 0) {
      const saving = r1(r.powerKw * 5)
      const rule = business ? 'idle' : 'after_hours'
      items.push({
        ...base, id: `${rule}-${r.id}`, rule, title: '재실 없을 때 운전 OFF', savingKwhDay: saving,
        reason: business ? `재실 0명 상태에서 ${r.powerKw}kW로 운전 중입니다.` : `운영 시간(09~18시) 밖에 재실 0명 상태에서 ${r.powerKw}kW로 운전 중입니다.`,
        draft: draft(r, 'off', 'unused', null, saving),
      })
      continue
    }
    const target = r.mode === 'heating' ? 20 : 26
    if (r.mode === 'heating' ? r.setpoint > target : r.setpoint < target) {
      const saving = r1(r.powerKw * 0.1 * 9)
      const diff = Math.abs(r.setpoint - target)
      items.push({
        ...base, id: `overset-${r.id}`, rule: 'overset', title: `설정온도 ${target}℃로 조정`, savingKwhDay: saving,
        reason: r.mode === 'heating' ? `난방 설정온도 ${r.setpoint}℃는 권고 상한 20℃보다 ${diff}℃ 높습니다.` : `냉방 설정온도 ${r.setpoint}℃는 권고 하한 26℃보다 ${diff}℃ 낮습니다.`,
        draft: draft(r, 'setpoint', 'always', target, saving),
      })
    }
  }
  items.sort((a, b) => b.savingKwhDay - a.savingKwhDay)
  return { generatedAt: iso, totalSavingKwh: r1(items.reduce((s, i) => s + i.savingKwhDay, 0)), items, mock: true }
}

// 감지 시각은 오늘 09:00(업무 시작) 가정, 원인 후보 규칙은 lambda/src/anomalies.py와 같음
export async function mockAnomalies(floor: string): Promise<Anomalies> {
  const { iso, h, m } = nowParts()
  const rooms = (await demoStatus()).rooms
  const minutes = Math.max(0, (h - 9) * 60 + m)
  const items = rooms.filter((r) => r.floor === floor && r.anomaly).map((r): Anomaly => {
    const healthy = rooms.filter((p) => p.onOff && !p.anomaly && p.mode === r.mode)
    const same = healthy.filter((p) => p.use === r.use)
    const peers = same.length ? same : healthy
    const expected = r.setpoint + (peers.length ? peers.reduce((s, p) => s + p.temp - p.setpoint, 0) / peers.length : 0)
    const load = Math.min(1, r.powerKw / Math.max(1.5, r1(r.areaM2 * 0.1)))
    return {
      roomId: r.id, roomName: r.name, idu: r.idu, floor: r.floor, use: r.use, mode: r.mode, setpoint: r.setpoint, temp: r.temp,
      gap: r1(r.temp - r.setpoint), expectedTemp: r1(expected), residual: r1(r.temp - expected), peerCount: peers.length,
      powerKw: r.powerKw, occupants: r.occupants, detectedAt: `${iso.slice(0, 11)}09:00:00+09:00`, durationMin: minutes,
      causes: [
        { label: '압축기·냉매 계통 성능 저하', likelihood: load >= 0.9 ? 'high' : 'medium', evidence: `정격 대비 ${Math.round(load * 100)}% 출력으로 운전 중입니다.` },
        { label: '필터·열교환기 오염에 따른 풍량 저하', likelihood: minutes >= 60 ? 'medium' : 'low', evidence: `미도달 상태가 ${Math.floor(minutes / 60)}시간 ${minutes % 60}분 지속 중입니다.` },
        { label: '재실 인원 대비 용량 부족', likelihood: r.occupants / r.areaM2 >= 0.15 ? 'medium' : 'low', evidence: `재실 ${r.occupants}명, 면적 ${r.areaM2}㎡입니다.` },
      ],
    }
  })
  return { generatedAt: iso, causeBasis: 'rule', items, mock: true }
}

// 시간대 계수: 운영 시간 1, 아침 8시·저녁 18~20시 0.1(낭비 운전), 그 외 0. 어제는 ±5% 다른 곡선
const shape = (h: number) => (h >= 9 && h < 18 ? 1 : h === 8 || (h >= 18 && h < 21) ? 0.1 : 0)
export async function mockHistory(floor: string): Promise<History> {
  const { iso, h, m } = nowParts()
  const kw = (await demoStatus()).rooms.filter((r) => r.floor === floor).reduce((s, r) => s + r.powerKw, 0)
  const point = (hour: number, wave: number, part = 1) => {
    const v = r1(kw * shape(hour) * (1 + 0.05 * wave))
    return { hour, kw: v, kwh: r1(v * part) }
  }
  return {
    generatedAt: iso, floor,
    today: Array.from({ length: h + 1 }, (_, i) => point(i, Math.sin(i * 1.7), i === h ? m / 60 : 1)),
    yesterday: Array.from({ length: 24 }, (_, i) => point(i, Math.cos(i * 1.3))),
    mock: true,
  }
}

// 목업 스케줄 저장소: 예시 2건으로 시작, saveSchedule 목업 저장분 포함
// shortcut: 브라우저 메모리에만 보관해 새로고침하면 초기화, Lambda 연결 시에는 DynamoDB 사용
let store: Schedule[] | null = null
async function schedules() {
  if (store) return store
  const rooms = (await demoStatus()).rooms
  const at = `${kstNow().slice(0, 11)}08:00:00+09:00`
  const ids = (floor: string, use: string) => rooms.filter((r) => r.floor === floor && r.use === use).map((r) => r.id)
  store = [
    { id: 'mock-seed-1', roomIds: ids('2F', '회의실'), action: 'off' as const, time: '13:00', condition: 'unused' as const, createdAt: at, sourceText: '2층 13시 이후 미사용 회의실 냉방 OFF' },
    { id: 'mock-seed-2', roomIds: ids('1F', '진료실'), action: 'setpoint' as const, time: '18:00', condition: 'always' as const, setpoint: 20, createdAt: at, sourceText: '1층 진료실 18시 설정온도 20도' },
  ].filter((s) => s.roomIds.length)
  return store
}

export async function mockSchedules(): Promise<Schedules> {
  return { schedules: [...(await schedules())], mock: true }
}

export async function mockSaveSchedule(d: Draft, sourceText: string) {
  const id = `mock-${Date.now()}`
  ;(await schedules()).push({
    id, roomIds: d.roomIds, action: d.action, time: d.time, condition: d.condition, createdAt: kstNow(), sourceText,
    ...(d.action === 'setpoint' && d.setpoint !== null ? { setpoint: d.setpoint } : {}),
  })
  return { id, mock: true }
}

export async function mockCancelSchedule(id: string) {
  const list = await schedules()
  const i = list.findIndex((s) => s.id === id)
  if (i < 0) throw new Error('없는 스케줄')
  list.splice(i, 1)
  return { id, mock: true }
}
