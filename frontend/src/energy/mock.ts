import { kstNow } from '../mock'
import type { Breakdown, Compare, Heatmap, Period, Point, Trend } from './api'

// 에너지 분석 목업(난수 없음, 같은 시각이면 같은 값). API를 쓸 수 없을 때만 사용, 결과에는 mock 표시
// - 시간 전력: 운영 시간은 면적 1㎡당 0.06kW × 85~100%, 운영 전후(시작 1시간 전 ~ 종료 3시간 후)는 낭비율만큼, 그 밖은 0
// shortcut: 건물 id·이름·면적·층·용도·운영 프로필은 lambda/src/buildings.json, 전기요금 단가는 lambda/src/energy.py에서 복제, 건물 목록 API가 생기면 그 응답으로 교체
const BUILDINGS = [
  { id: 'main', name: '본관', areaM2: 2412.9, floors: ['1F', '2F'], uses: ['사무실', '진료실', '회의실', '대기·휴게', '기타'], hours: [9, 18], weekend: false, waste: 0.12 },
  { id: 'office', name: '업무동', areaM2: 3299.4, floors: ['1F', '2F', '3F'], uses: ['사무실', '회의실', '대기·휴게', '기타'], hours: [8, 19], weekend: false, waste: 0.18 },
  { id: 'edu', name: '교육관', areaM2: 1526.4, floors: ['1F'], uses: ['회의실', '대기·휴게'], hours: [9, 21], weekend: true, waste: 0.08 },
  { id: 'lab', name: '연구동', areaM2: 1773.0, floors: ['1F', '2F'], uses: ['사무실', '회의실', '대기·휴게', '기타'], hours: [7, 22], weekend: true, waste: 0.15 },
] as const
type B = (typeof BUILDINGS)[number]
const USE_SHARE: Record<string, number> = { 사무실: 0.4, 진료실: 0.2, 회의실: 0.2, '대기·휴게': 0.15, 기타: 0.05 }
const DAY = 86_400_000
const WEEKDAYS = '월화수목금토일'
const r1 = (v: number) => Math.round(v * 10) / 10
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

// 키별 고정 값(0~1)
const u = (n: number) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x) }

function building(id = 'main'): B {
  const b = BUILDINGS.find((x) => x.id === id)
  if (!b) throw new Error(`알 수 없는 건물: ${id}`)
  return b
}

// 날짜는 KST 0시를 UTC 0시로 옮긴 ms 값(getUTC* 함수로 KST 날짜·요일 계산)
const weekday = (day: number) => (new Date(day).getUTCDay() + 6) % 7
function kw(b: B, day: number, h: number) {
  const [h0, h1] = b.hours
  const open = weekday(day) < 5 || b.weekend
  if (open && h0 <= h && h < h1) return b.areaM2 * 0.06 * (0.85 + 0.15 * u(day / DAY + h + b.areaM2)) * (weekday(day) < 5 ? 1 : 0.5)
  return h0 - 1 <= h && h < h1 + 3 ? b.areaM2 * 0.06 * b.waste : 0
}
function now() {
  const iso = kstNow()
  const t = Date.parse(`${iso.slice(0, 19)}Z`)
  const today = t - (t % DAY)
  return { iso, today, h: new Date(t).getUTCHours(), frac: (t % 3_600_000) / 3_600_000 }
}
// 날짜 하루 kWh: 오늘은 현재 시각까지, upto가 있으면 그 시각까지(지난 기간의 같은 시점)
function dayKwh(b: B, day: number, upto?: { h: number; frac: number }) {
  const n = now()
  const lim = upto ?? (day === n.today ? n : { h: 24, frac: 0 })
  return sum(Array.from({ length: Math.min(24, lim.h + 1) }, (_, h) => kw(b, day, h) * (h < lim.h ? 1 : lim.frac)))
}
const span = (start: number, end: number) => Array.from({ length: Math.round((end - start) / DAY) + 1 }, (_, i) => start + i * DAY)
function periodDays(period: Period) {
  const { today } = now()
  const d = new Date(today)
  if (period === 'day') return { cur: [today], prev: [today - DAY] }
  if (period === 'week') {
    const mon = today - weekday(today) * DAY
    return { cur: span(mon, today), prev: span(mon - 7 * DAY, mon - DAY) }
  }
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const prevFirst = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)
  return { cur: span(first, today), prev: span(prevFirst, first - DAY) }
}
// 지난 기간의 같은 시점까지 kWh: 이번 기간 경과 일수만큼 전체 + 같은 위치 날짜는 같은 시각까지
function prevSame(b: B, period: Period) {
  const { cur, prev } = periodDays(period)
  const n = now()
  const i = cur.length - 1
  return sum(prev.slice(0, i).map((d) => dayKwh(b, d, { h: 24, frac: 0 }))) + (prev[i] !== undefined ? dayKwh(b, prev[i], n) : 0)
}

export async function mockCompare(q: Record<string, string>): Promise<Compare> {
  const period = q.period === 'month' ? 'month' : 'day'
  const price = 134.2
  const items = BUILDINGS.map((b) => {
    const kwh = r1(sum(periodDays(period).cur.map((d) => dayKwh(b, d))))
    return { buildingId: b.id, name: b.name, areaM2: b.areaM2, kwh, prevKwh: r1(prevSame(b, period)), kwhPerM2: Math.round((kwh / b.areaM2) * 1000) / 1000, costKrw: Math.round(kwh * price) }
  })
  return { generatedAt: now().iso, virtual: true, mock: true, period, unitPriceKrw: price, priceBasis: '일반용(갑)I 고압A 선택I 전력량요금 연평균 120.2원 + 기후환경요금 9.0원 + 연료비조정요금 5.0원, 기본요금·부가가치세·전력산업기반기금 제외', items }
}

export async function mockTrend(q: Record<string, string>): Promise<Trend> {
  const b = building(q.building)
  const period = (q.period ?? 'day') as Period
  const { cur, prev } = periodDays(period)
  const n = now()
  const label = (d: number) => (period === 'week' ? WEEKDAYS[weekday(d)] : `${new Date(d).getUTCDate()}일`)
  let current: Point[]
  let previous: Point[]
  if (period === 'day') {
    current = Array.from({ length: n.h + 1 }, (_, h) => ({ label: `${h}시`, kwh: r1(kw(b, n.today, h) * (h < n.h ? 1 : n.frac)) }))
    previous = Array.from({ length: 24 }, (_, h) => ({ label: `${h}시`, kwh: r1(kw(b, prev[0], h)) }))
  } else {
    current = cur.map((d) => ({ label: label(d), kwh: r1(dayKwh(b, d)) }))
    previous = prev.map((d) => ({ label: label(d), kwh: r1(dayKwh(b, d)) }))
  }
  return {
    generatedAt: n.iso, virtual: true, mock: true, building: b.id, period, unit: 'kWh', current, previous,
    totalKwh: r1(sum(current.map((p) => p.kwh))), prevTotalKwh: r1(sum(previous.map((p) => p.kwh))), prevSameKwh: r1(prevSame(b, period)),
  }
}

export async function mockHeatmap(q: Record<string, string>): Promise<Heatmap> {
  const b = building(q.building)
  const weeks = Number(q.weeks ?? 4)
  const { today, iso } = now()
  const cells = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  for (let i = 1; i <= weeks * 7; i++) {
    const d = today - i * DAY
    for (let h = 0; h < 24; h++) cells[weekday(d)][h] += kw(b, d, h) / weeks
  }
  const out = cells.map((row) => row.map(r1))
  return { generatedAt: iso, virtual: true, mock: true, building: b.id, weeks, unit: 'kW', cells: out, max: Math.max(...out.flat()), hours: [b.hours[0], b.hours[1]], weekend: b.weekend }
}

export async function mockBreakdown(q: Record<string, string>): Promise<Breakdown> {
  const b = building(q.building)
  const period = (q.period ?? 'day') as Period
  const total = sum(periodDays(period).cur.map((d) => dayKwh(b, d)))
  const fw = b.floors.map((_, i) => [1, 0.8, 0.7][i])
  const uw = b.uses.map((x) => USE_SHARE[x])
  const floors = b.floors.map((floor, i) => {
    const fk = (total * fw[i]) / sum(fw)
    return { floor, kwh: r1(fk), uses: b.uses.map((use, j) => ({ use, kwh: r1((fk * uw[j]) / sum(uw)) })) }
  })
  return { generatedAt: now().iso, virtual: true, mock: true, building: b.id, name: b.name, period, unit: 'kWh', totalKwh: r1(total), floors }
}
