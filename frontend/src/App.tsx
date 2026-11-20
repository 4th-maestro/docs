import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, ArrowUp, BarChart3, CalendarClock, ChevronDown, Droplets, Info, LayoutDashboard, Moon, RefreshCw, Sun, Zap } from 'lucide-react'
import { ThinkingBadge, ThinkingPanel } from './ai/ThinkingPanel'
import type { AskResult } from './ai/types'
import { useAsk } from './ai/useAsk'
import { getBuildings, getStatus, saveSchedule } from './api'
import { ANOMALY, SCALES } from './heat'
import AnomalyPanel from './panels/AnomalyPanel'
import PowerTrend from './panels/PowerTrend'
import RecommendPanel from './panels/RecommendPanel'
import ScheduleTimeline from './panels/ScheduleTimeline'
import { usePoll } from './panels/usePoll'
import Portfolio from './portfolio/Portfolio'
import { TWIN_URL, onRoomSelected, postState } from './twin'
import type { BuildingCard, Draft, Mode, Room, Status } from './types'

// three.js 청크(약 620kB)는 3D 영역 표시 시점에 로드
const Twin3D = lazy(() => import('./twin3d/Twin3D'))

const MODES: { id: Mode; label: string }[] = [
  { id: 'temp', label: '온도' },
  { id: 'powerKw', label: '전력' },
  { id: 'humidity', label: '습도' },
  { id: 'anomaly', label: '이상 감지' },
]
// 예시 질의의 층: 건물의 맨 위층(교육관은 1F만 있음), 회의실은 모든 건물의 맨 위층에 있음
const scheduleExample = (floors: string[]) => `${floors[floors.length - 1].replace('F', '층')} 13시 이후 미사용 회의실 냉방 OFF`
const ACTION = { off: '운전 OFF', on: '운전 ON', setpoint: '설정온도 변경' }

const hhmm = (iso: string) => iso.slice(11, 16)
// 상태 실시간 연동(목업): 5초 주기 재조회, 값은 Lambda·목업이 범위 안에서 변동. AI 질의만 WebSocket 사용
const LIVE_MS = 5_000
const NO_ROOMS: Room[] = []
const NO_IDS: string[] = []

// 테마: index.html 인라인 스크립트가 첫 표시 전에 data-theme 지정, 여기서는 전환과 저장만 처리
type Theme = 'light' | 'dark'
function saveTheme(t: Theme) {
  document.documentElement.dataset.theme = t
  try { localStorage.setItem('maestro-theme', t) } catch { /* 저장 불가 브라우저는 이번 방문에만 적용 */ }
}

// 해시 경로(새 의존성 없이 뒤로·앞으로 이동 지원)
// - #/ 전체 현황, #/b/<id> 건물 운영 탭, #/b/<id>/energy 건물 전력 분석 탭
type Tab = 'ops' | 'energy'
type Route = { building: string | null; tab: Tab }
function parseRoute(hash: string): Route {
  const m = /^#\/b\/([\w-]+)(\/energy)?\/?$/.exec(hash)
  return m ? { building: m[1], tab: m[2] ? 'energy' : 'ops' } : { building: null, tab: 'ops' }
}
const href = (building: string, tab: Tab = 'ops') => `#/b/${building}${tab === 'energy' ? '/energy' : ''}`

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  // 건물 목록: 전체 현황 카드와 머리글 건물 선택에 공용, 60초마다 다시 조회
  const list = usePoll(getBuildings, 'all')
  const buildings = list.data?.buildings ?? []
  const known = buildings.find((b) => b.id === route.building)
  const themeButton = (
    <button className="icon" onClick={() => { const t = theme === 'dark' ? 'light' : 'dark'; setTheme(t); saveTheme(t) }} aria-label={theme === 'dark' ? '밝은 화면으로 전환' : '어두운 화면으로 전환'}>
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )

  // 목록 도착 전에는 주소의 건물을 그대로 표시, 목록에 없는 건물만 안내
  if (route.building && (!list.data || known)) {
    // 건물 변경 시 key로 다시 마운트: 층(첫 층), 상태, AI 결과, 초안, 선택 호실, 패널 값 초기화
    return <Dashboard key={route.building} building={route.building} info={known} tab={route.tab} buildings={buildings} themeButton={themeButton} dark={theme === 'dark'} />
  }
  return (
    <div className="page">
      <Header buildings={buildings} current={null}><div className="meta">{themeButton}</div></Header>
      {route.building
        ? <p className="error" role="alert">{route.building} 건물은 목록에 없습니다. 건물 선택에서 다시 고르십시오.</p>
        : <Portfolio data={list.data} error={list.error} />}
    </div>
  )
}

function Header({ buildings, current, tab = 'ops', children }: { buildings: BuildingCard[]; current: string | null; tab?: Tab; children?: ReactNode }) {
  return (
    <header className="nav">
      <div className="brand">Maestro</div>
      <div className="pick">
        <a className={current ? 'navlink' : 'navlink on'} href="#/" aria-current={current ? undefined : 'page'}><LayoutDashboard size={18} aria-hidden />전체 현황</a>
        <span className="bsel">
          <select aria-label="건물 선택" value={current ?? ''} onChange={(e) => { location.hash = href(e.target.value, tab) }}>
            {!current && <option value="" disabled>건물 선택</option>}
            {current && !buildings.some((b) => b.id === current) && <option value={current}>{current}</option>}
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}({b.use}{b.virtual ? ', 가상' : ''})</option>)}
          </select>
          <ChevronDown size={18} aria-hidden />
        </span>
      </div>
      {children}
    </header>
  )
}

type DashboardProps = { building: string; info?: BuildingCard; tab: Tab; buildings: BuildingCard[]; themeButton: ReactNode; dark: boolean; energy?: ReactNode }

function Dashboard({ building, info, tab, buildings, themeButton, dark, energy }: DashboardProps) {
  const ops = tab === 'ops'
  const [floor, setFloor] = useState(info?.floors[0] ?? '1F')
  const [mode, setMode] = useState<Mode>('temp')
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [asked, setAsked] = useState('')
  const [busy, setBusy] = useState(false)
  const { state: ai, ask, reset } = useAsk(building)
  const [seen, setSeen] = useState<AskResult | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  // 추천 초안의 대상 호실 강조(AI 결과 강조보다 우선)
  const [pinned, setPinned] = useState<string[] | null>(null)
  const [scheduleKey, setScheduleKey] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const [saved, setSaved] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)

  // 운영 탭에서만 5초 주기 조회, 층·건물 변경 후 도착한 이전 응답은 버림
  useEffect(() => {
    if (!ops) return
    let alive = true
    const run = () => getStatus(floor, building).then(
      (s) => { if (alive) { setStatus(s); setLoadedAt(Date.now()) } },
      (e: Error) => { if (alive) setError(e.message) },
    )
    run()
    const id = setInterval(run, LIVE_MS)
    return () => { alive = false; clearInterval(id) }
  }, [floor, building, ops, reloadKey])
  const load = () => setReloadKey((k) => k + 1)
  useEffect(() => onRoomSelected(setSelected), [])

  const floors = status?.floors ?? info?.floors ?? [floor]
  // 목록 도착 전 기본값 1F가 이 건물에 없으면 첫 층으로 이동(렌더 중 상태 조정 패턴)
  if (status && !status.floors.includes(floor)) setFloor(status.floors[0])
  // 새 AI 결과 수신 시 초안 표시, 초안 대상 층으로 이동
  if (ai.result !== seen) {
    setSeen(ai.result)
    setDraft(ai.result?.draft ?? null)
    if (ai.result?.draft && floors.includes(ai.result.draft.floor)) setFloor(ai.result.draft.floor)
  }
  const result = ai.result
  const rooms = status?.rooms ?? NO_ROOMS
  const highlight = pinned ?? result?.highlight ?? NO_IDS
  useEffect(() => postState(frame.current, building, floor, mode, rooms, highlight), [building, floor, mode, rooms, highlight])
  // 기준 시각이 갱신 주기의 2배를 초과하면 지연 표시(디자인 시스템 6절)
  const stale = status ? loadedAt - new Date(status.generatedAt).getTime() > status.refreshSeconds * 2000 : false
  const room = rooms.find((r) => r.id === selected)
  const watch = useMemo(() => {
    const ids = new Set(highlight)
    return rooms.filter((r) => ids.has(r.id)).slice(0, 8)
  }, [rooms, highlight])
  const example = scheduleExample(floors)
  const suggestions = [
    { icon: Zap, text: '현재 전력 사용량이 높은 공간은?' },
    { icon: CalendarClock, text: example },
    { icon: Droplets, text: '1층에서 습도가 높은 공간 5곳 알려줘' },
  ]

  // 패널의 위치 버튼: 3D에서 선택하고 3D 영역을 화면 안으로 이동
  function locate(id: string) {
    setSelected(id)
    document.querySelector('.twin')?.scrollIntoView({ block: 'nearest' })
  }

  // 추천 초안: 이전 AI 결과를 지우고 초안 카드로 표시
  function showDraft(d: Draft) {
    reset(); setSeen(null)
    setAsked(''); setSaved(''); setDraft(d); setPinned(d.roomIds)
  }

  function submit(q = text) {
    if (!q.trim() || ai.status === 'running') return
    setError(''); setSaved(''); setAsked(q); setDraft(null); setPinned(null)
    ask(q)
  }

  async function confirm(draft: Draft) {
    setBusy(true)
    try {
      const r = await saveSchedule(draft, asked, building)
      setSaved(r.mock ? `${draft.time} ${ACTION[draft.action]} 스케줄을 목업으로 저장했습니다. 서버에는 기록되지 않습니다.` : `${draft.time} ${ACTION[draft.action]} 스케줄을 저장했습니다. 시뮬레이션에만 반영됩니다.`)
      setDraft(null); setPinned(null)
      setScheduleKey((k) => k + 1)
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <Header buildings={buildings} current={building} tab={tab}>
        {ops && (
          <nav className="tabs" aria-label="층 선택">
            {floors.map((f) => (
              <button key={f} className={f === floor ? 'tab on' : 'tab'} aria-pressed={f === floor} onClick={() => setFloor(f)}>{f}</button>
            ))}
          </nav>
        )}
        <div className="meta">
          {ops && status && (
            <span className={stale ? 'live stale' : 'live'} title={`5초마다 갱신(실시간 목업)${status.virtual ? ', 가상 데이터' : ''}`}>
              <i aria-hidden />{stale ? '갱신 지연' : '실시간'} {status.generatedAt.slice(11, 19)}
            </span>
          )}
          {ops && <button className="icon" onClick={load} aria-label="새로고침"><RefreshCw size={18} /></button>}
          {themeButton}
        </div>
      </Header>
      <nav className="dtabs" aria-label="건물 화면">
        <a className="dtab" href={href(building)} aria-current={ops ? 'page' : undefined}><LayoutDashboard size={18} aria-hidden />운영</a>
        <a className="dtab" href={href(building, 'energy')} aria-current={ops ? undefined : 'page'}><BarChart3 size={18} aria-hidden />전력 분석</a>
      </nav>

      {!ops && (energy ?? <section className="card slot"><p>전력 분석 화면을 준비 중입니다.</p></section>)}
      {ops && (
        <>
          <form className="search" onSubmit={(e) => { e.preventDefault(); submit() }}>
            <label htmlFor="q">자연어 질의</label>
            <input id="q" value={text} onChange={(e) => setText(e.target.value)} placeholder={`예: ${example}`} maxLength={500} />
            <ThinkingBadge state={ai} />
            <button className="orb" type="submit" disabled={ai.status === 'running' || !text.trim()} aria-label="질의 보내기"><ArrowUp size={20} /></button>
          </form>
          <p className="hint">AI 해석은 틀릴 수 있습니다. 제어 요청은 확인 후에만 저장됩니다.</p>
          <div className="chips">
            {[suggestions[0].text, example].map((q) => <button key={q} className="chip" onClick={() => { setText(q); submit(q) }}>{q}</button>)}
          </div>
          {status?.virtual && (
            <div className="banner" role="note">
              <Info size={16} aria-hidden />
              <span>
                가상 데이터로 채운 화면입니다. 실제 설비 수치가 아닙니다.
                {status.building.virtual ? ` ${status.building.name}은 가상 건물이며 도면 출처는 ${status.building.basis}입니다.` : ''}
                {status.mock ? ' API에 연결하지 못해 목업 데이터를 표시합니다.' : ''}
              </span>
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          {status && (
            <section className="kpis" aria-label={`${floor} 요약`}>
              <Kpi label="운전 중 HVAC" value={status.summary.on} unit="대" sub={`${floor} 전체 ${status.rooms.length}대 중`} />
              <Kpi label="정지" value={status.summary.off} unit="대" sub="현재 OFF 상태" />
              <Kpi label="이상 감지" value={status.summary.anomaly} unit="건" sub="설정온도 미도달" bad={status.summary.anomaly > 0} />
              <Kpi label="현재 전력" value={status.summary.powerKw} unit="kW" sub={`외기 ${status.outdoorTemp}℃, ${hhmm(status.generatedAt)} 기준`} />
            </section>
          )}

          <main className="grid">
            <div className="main-col">
              <section className="card twin">
                <div className="twin-head">
                  <div className="modes" role="tablist">
                    {MODES.map((m) => (
                      <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'pill on' : 'pill'} onClick={() => setMode(m.id)}>{m.label}</button>
                    ))}
                  </div>
                </div>
                {TWIN_URL ? (
                  <iframe ref={frame} className="embed" src={TWIN_URL} title="3D 디지털트윈" onLoad={() => postState(frame.current, building, floor, mode, rooms, highlight)} />
                ) : (
                  <Suspense fallback={<div className="embed" aria-label="3D 도면 불러오는 중" />}>
                    <Twin3D building={building} floor={floor} mode={mode} rooms={rooms} highlight={highlight} selectedId={selected} onSelect={setSelected} dark={dark} />
                  </Suspense>
                )}
                <Legend mode={mode} status={status} />
                {room ? <RoomDetail r={room} /> : <p className="muted pick-hint">호실을 누르면 HVAC 상태가 여기에 표시됩니다.</p>}
              </section>
              <PowerTrend building={building} floor={floor} />
              <ScheduleTimeline building={building} refreshKey={scheduleKey} onLocate={locate} />
            </div>

            <aside className="rail">
              <section className="card">
                <h2>AI 응답</h2>
                {ai.status === 'idle' && !draft && (
                  <ul className="suggest">
                    {suggestions.map(({ icon: Icon, text: q }) => (
                      <li key={q}><button onClick={() => { setText(q); submit(q) }}><Icon size={18} aria-hidden />{q}</button></li>
                    ))}
                  </ul>
                )}
                {(result?.mock || (ai.transport === 'mock' && ai.status === 'done')) && <span className="tag">목업 응답</span>}
                <ThinkingPanel state={ai} query={asked} />
                {draft && <DraftCard d={draft} busy={busy} onCancel={() => { setDraft(null); setPinned(null) }} onSave={() => confirm(draft)} />}
                {saved && <p className="ok">{saved}</p>}
                {watch.length > 0 && (
                  <div className="watch">
                    <h3>대상 호실 {highlight.length}곳</h3>
                    <ul>
                      {watch.map((r) => (
                        <li key={r.id}>
                          <button onClick={() => setSelected(r.id)}>
                            <span className="name">{r.anomaly && <AlertTriangle size={16} color={ANOMALY} aria-label="이상" />}{r.name}</span>
                            <span className="num">{r.onOff ? `${r.powerKw}kW` : 'OFF'}</span>
                            <span className="muted">{r.use}, {r.idu}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
              <AnomalyPanel building={building} floor={floor} onLocate={(id) => { setMode('anomaly'); locate(id) }} />
              <RecommendPanel key={`${floor}-${scheduleKey}`} building={building} floor={floor} onDraft={showDraft} onLocate={locate} />
            </aside>
          </main>
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, unit, sub, bad }: { label: string; value: number; unit: string; sub: string; bad?: boolean }) {
  return (
    <div className="kpi">
      <span className="klabel">{label}</span>
      <span className={bad ? 'kval bad' : 'kval'}>{value}<small>{unit}</small></span>
      <span className="ksub">{sub}</span>
    </div>
  )
}

function Legend({ mode, status }: { mode: Mode; status: Status | null }) {
  return (
    <div className="legend">
      {mode === 'anomaly' ? (
        <span><i className="sw bad" />설정온도 미도달 HVAC, 회색은 정지</span>
      ) : (
        <span>
          {SCALES[mode].colors.map((c) => <i key={c} className="sw" style={{ background: c }} />)}
          {SCALES[mode].label} {SCALES[mode].min}~{SCALES[mode].max}{SCALES[mode].unit}
        </span>
      )}
      {status && <span>외기 {status.outdoorTemp}℃, 기준 {hhmm(status.generatedAt)}</span>}
    </div>
  )
}

function DraftCard({ d, busy, onCancel, onSave }: { d: Draft; busy: boolean; onCancel: () => void; onSave: () => void }) {
  return (
    <div className="draft">
      <h3>스케줄 초안</h3>
      <dl>
        <dt>대상</dt><dd>{d.roomIds.length}곳({d.floor === 'all' ? '전체 층' : d.floor}, {d.use === 'all' ? '전체 용도' : d.use})</dd>
        <dt>조건</dt><dd>{d.time} 이후{d.condition === 'unused' ? ', 재실 없음일 때' : ''}</dd>
        <dt>동작</dt><dd>{ACTION[d.action]}{d.setpoint ? ` ${d.setpoint}℃` : ''}</dd>
        <dt>예상 절감</dt><dd>{d.estimatedSavingKwh}kWh/일(가상)</dd>
      </dl>
      <p className="muted small">{d.roomNames.join(', ')}{d.roomIds.length > d.roomNames.length ? ' 외' : ''}</p>
      <div className="btns">
        <button className="secondary" onClick={onCancel} disabled={busy}>취소</button>
        <button className="primary" onClick={onSave} disabled={busy}>스케줄 생성</button>
      </div>
    </div>
  )
}

function RoomDetail({ r }: { r: Room }) {
  return (
    <div className="room">
      <div className="room-head">
        <h3>{r.name}</h3>
        <span className="muted">{r.floor}, {r.use}, {r.areaM2}㎡, HVAC {r.idu}</span>
      </div>
      {r.anomaly && <p className="bad-line"><AlertTriangle size={16} aria-hidden />설정온도 미도달: 운전 중 실내온도가 설정온도와 3℃ 이상 차이</p>}
      <dl className="kv">
        <dt>운전</dt><dd>{r.onOff ? `${r.mode === 'cooling' ? '냉방' : '난방'} 운전` : 'OFF'}</dd>
        <dt>설정온도</dt><dd>{r.setpoint}℃</dd>
        <dt>실내온도</dt><dd>{r.temp}℃</dd>
        <dt>습도</dt><dd>{r.humidity}%</dd>
        <dt>전력</dt><dd>{r.powerKw}kW</dd>
        <dt>재실</dt><dd>{r.occupants}명</dd>
      </dl>
    </div>
  )
}
