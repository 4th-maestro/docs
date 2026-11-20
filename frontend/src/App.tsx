import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarClock, Droplets, Info, Moon, RefreshCw, Sun, Zap } from 'lucide-react'
import AdminPage from './admin/AdminPage'
import ChatPanel, { type ChatMsg } from './ai/ChatPanel'
import type { AskResult } from './ai/types'
import { useAsk } from './ai/useAsk'
import { clearChat, getBuildings, getChat, getMe, getStatus, joinCompany, saveSchedule, SUSPENDED, type Me } from './api'
import LoginScreen, { NoCompany, Suspended } from './auth/LoginScreen'
import { AUTH_ON, currentEmail, isAdmin, onAuthChange, signedIn } from './auth/cognito'
import { ME_CHANGED, MeContext } from './auth/me'
import SettingsPage from './settings/SettingsPage'
import BuildingCompare from './energy/BuildingCompare'
import EnergyPage from './energy/EnergyPage'
import { SCALES } from './heat'
import { setRoomSetpoint, summarize } from './mock'
import AnomalyPanel from './panels/AnomalyPanel'
import PowerTrend from './panels/PowerTrend'
import RecommendPanel from './panels/RecommendPanel'
import ScheduleTimeline from './panels/ScheduleTimeline'
import SimPanel from './panels/SimPanel'
import ExperimentPanel from './panels/ExperimentPanel'
import { usePoll } from './panels/usePoll'
import Portfolio from './portfolio/Portfolio'
import { FloorList, Layout } from './shell/Shell'
import { href, parseRoute, type FloorSummary, type Tab } from './shell/route'
import { TWIN_URL, onNeedBuilding, onTwinControl, onRoomSelected, onTwinChange, postState, twinSrc, type TwinBuilding, type TwinData } from './twin'
import AddBuilding from './AddBuilding'
import { BUILDINGS_CHANGED, customBuilding, customOf, isCustom } from './custom'
import type { BuildingCard, Draft, Mode, Room, Status } from './types'
import { SkFloors, SkKpis, SkPlan } from './skeleton/Skeleton'
import CountUp from './motion/CountUp'

// three.js 청크(약 620kB)는 3D 영역 표시 시점에 로드
const Twin3D = lazy(() => import('./twin3d/Twin3D'))

const MODES: { id: Mode; label: string }[] = [
  { id: 'temp', label: '온도' },
  { id: 'powerKw', label: '전력' },
  { id: 'humidity', label: '습도' },
  { id: 'anomaly', label: '이상 감지' },
]
// 예시 질의 층: 건물의 맨 위층(교육관은 1F만 있음)
const scheduleExample = (floors: string[]) => `${floors.at(-1)?.replace('F', '층') ?? '건물 전체'} 13시 이후 미사용 회의실 냉방 OFF`
const ACTION = { off: '운전 OFF', on: '운전 ON', setpoint: '설정온도 변경' }
const hhmm = (iso: string) => iso.slice(11, 16)
// 상태 실시간 연동(목업): 5초 주기 재조회, 값은 Lambda·목업이 범위 안에서 변동. AI 질의만 WebSocket 사용
const LIVE_MS = 5_000
const NO_ROOMS: Room[] = []
const NO_IDS: string[] = []
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

const STOPPED = '서비스가 중지된 기업입니다. 판매사에 문의하십시오.'

// 테마: index.html 인라인 스크립트가 첫 표시 전에 data-theme 지정, 여기서는 전환과 저장만 처리
type Theme = 'light' | 'dark'
function saveTheme(t: Theme) {
  document.documentElement.dataset.theme = t
  try { localStorage.setItem('maestro-theme', t) } catch { /* 저장 불가 브라우저는 이번 방문에만 적용 */ }
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
  // 로그인 상태: 로그아웃·토큰 갱신 실패 시 로그인 화면으로 전환
  const [authed, setAuthed] = useState(signedIn)
  useEffect(() => onAuthChange(() => setAuthed(signedIn())), [])
  // 소속 확인: 로그인 후 GET /me, 구성원 변경(ME_CHANGED) 시 다시 조회, 로그아웃하면 초기화
  // - 조회 실패(API 없음·오류)는 확인을 생략하고 건물 화면 유지(목업 동작 보존)
  const [me, setMe] = useState<Me | null>(null)
  // 서비스 중지: API 403 COMPANY_SUSPENDED의 서버 문구
  const [stopped, setStopped] = useState('')
  useEffect(() => {
    if (!authed || !AUTH_ON) return
    let alive = true
    const load = () => getMe().then((m) => { if (alive) setMe(m) }, () => undefined)
    const stop = (e: Event) => setStopped((e as CustomEvent<string | undefined>).detail || STOPPED)
    load()
    window.addEventListener(ME_CHANGED, load)
    window.addEventListener(SUSPENDED, stop)
    return () => {
      alive = false; setMe(null); setStopped('')
      window.removeEventListener(ME_CHANGED, load)
      window.removeEventListener(SUSPENDED, stop)
    }
  }, [authed])
  if (!authed) return <LoginScreen onDone={() => setAuthed(true)} />
  // 판매사 관리자는 기업 상태와 무관하게 건물 화면·기업 관리 사용
  const vendor = me?.role === 'admin' || isAdmin()
  if (!vendor && (stopped || me?.company?.status === 'suspended')) {
    return <Suspended email={me?.email ?? currentEmail()} company={me?.company?.name} message={stopped || STOPPED} />
  }
  if (me && !me.role && !vendor) {
    // 연결 후 소속 다시 조회, 조회 실패·소속 미반영이면 연결 응답으로 진입
    const join = async (code: string) => {
      const r = await joinCompany(code)
      const m = await getMe().catch(() => null)
      setMe(m?.role ? m : { email: me.email, ...r })
    }
    return <NoCompany email={me.email} onJoin={join} />
  }
  const themeButton = (
    <button className="icon" onClick={() => { const t = theme === 'dark' ? 'light' : 'dark'; setTheme(t); saveTheme(t) }} aria-label={theme === 'dark' ? '밝은 화면으로 전환' : '어두운 화면으로 전환'}>
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
  return <MeContext value={me}><Shell themeButton={themeButton} dark={theme === 'dark'} /></MeContext>
}

function Shell({ themeButton, dark }: { themeButton: React.ReactNode; dark: boolean }) {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  // 건물 목록: 전체 현황 카드와 상단 건물 토글 공용, 60초마다 다시 조회
  const list = usePoll(getBuildings, 'all')
  const buildings = list.data?.buildings ?? []
  const known = buildings.find((b) => b.id === route.building)
  // 건물 추가·렌더링·취소 → 목록 다시 조회
  const { reload } = list
  useEffect(() => { window.addEventListener(BUILDINGS_CHANGED, reload); return () => window.removeEventListener(BUILDINGS_CHANGED, reload) }, [reload])
  // 추가만 하고 아직 렌더링하지 않은 건물: 도면 넣는 화면(데이터 생성 안 함)
  if (route.building && isCustom(route.building) && customOf(route.building)?.state === 'pending') {
    return (
      <Layout building={null} tab="ops" buildings={buildings} tools={themeButton}>
        <AddBuilding id={route.building} />
      </Layout>
    )
  }

  // 목록 도착 전에는 주소의 건물을 그대로 표시, 목록에 없는 건물만 안내
  if (route.building && (!list.data || known)) {
    // 건물 변경 시 key로 다시 마운트: 층, 상태, 대화, 초안, 선택 호실, 패널 값 초기화
    return <Dashboard key={route.building} building={route.building} info={known} tab={route.tab} buildings={buildings} themeButton={themeButton} dark={dark} />
  }
  if (route.admin) {
    return (
      <Layout building={null} tab="ops" buildings={buildings} tools={themeButton} admin>
        <div className="page"><AdminPage company={route.company} /></div>
      </Layout>
    )
  }
  if (route.settings) {
    return (
      <Layout building={null} tab="ops" buildings={buildings} tools={themeButton} settings>
        <div className="page"><SettingsPage /></div>
      </Layout>
    )
  }
  return (
    <Layout building={null} tab="ops" buildings={buildings} tools={themeButton}>
      <div className="page">
        {route.building
          ? <p className="error" role="alert">{route.building} 건물은 목록에 없습니다. 상단 건물 선택에서 다시 고르십시오.</p>
          : <Portfolio data={list.data} error={list.error} compare={<BuildingCompare onOpen={(id) => { location.hash = href(id, 'energy') }} />} />}
      </div>
    </Layout>
  )
}

type DashboardProps = { building: string; info?: BuildingCard; tab: Tab; buildings: BuildingCard[]; themeButton: React.ReactNode; dark: boolean }

function Dashboard({ building, info, tab, buildings, themeButton, dark }: DashboardProps) {
  const ops = tab === 'ops'
  // 내장 3D 도면은 층 단위로만 그리므로 트윈 화면(TWIN_URL)이 없으면 첫 층으로 시작, 트윈은 건물 전체('')로 시작
  const [floor, setFloor] = useState(TWIN_URL ? '' : (info?.floors[0] ?? '1F'))
  const [mode, setMode] = useState<Mode>('temp')
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { state: ai, ask, reset } = useAsk(building)
  const [seen, setSeen] = useState<AskResult | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [history, setHistory] = useState<'loading' | 'server' | 'local'>('loading')
  // 3D 강조 호실: 마지막 AI 결과, 추천 초안, 대화의 "3D에서 보기"
  const [focus, setFocus] = useState<string[]>(NO_IDS)
  const [scheduleKey, setScheduleKey] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)

  // 운영 탭에서만 5초 주기 조회. 건물 전체 호실을 받아 사이드바 층별 요약과 선택 층 화면에 함께 사용
  useEffect(() => {
    if (!ops) return
    let alive = true
    const run = () => getStatus('', building).then(
      (s) => { if (alive) { setStatus(s); setLoadedAt(Date.now()) } },
      (e: Error) => { if (alive) setError(e.message) },
    )
    run()
    const id = setInterval(run, LIVE_MS)
    return () => { alive = false; clearInterval(id) }
  }, [building, ops, reloadKey])
  const load = () => setReloadKey((k) => k + 1)
  useEffect(() => onRoomSelected(setSelected), [])
  useEffect(() => onNeedBuilding(() => frame.current, customBuilding), [])
  useEffect(() => onTwinControl((room, sp) => { setRoomSetpoint(building, room, sp); load() }), [building])

  // 대화 기록: 서버(로그인 사용자·건물별), 실패하면 이 화면에만 기록
  useEffect(() => {
    let alive = true
    getChat(building).then((r) => {
      if (!alive) return
      setMessages(r.messages.map((m) => ({ ...m, id: m.sk, draftState: m.draft ? 'closed' : undefined })))
      setHistory(r.server ? 'server' : 'local')
    })
    return () => { alive = false }
  }, [building])

  // 3D 트윈을 넣었으면 층 목록은 트윈이 도면에서 인식한 층을 따름 (도면에 5개 층이면 1F~5F)
  const [twin, setTwin] = useState<TwinBuilding | null>(null)
  const floors = useMemo(() => twin?.floors.map((f) => f.floor) ?? status?.floors ?? info?.floors ?? [], [twin, status, info])
  // 트윈에서 층·지표를 바꾸면 버튼도 따라감 (이 건물에 없는 층이면 무시)
  useEffect(() => onTwinChange({ mode: setMode, building: setTwin, floor: (f) => { if (!f || floors.includes(f)) { setFloor(f); setSelected(null) } } }), [floors])
  // 선택된 층이 현재 건물의 층 목록에서 사라지면 건물 보기로 돌아감
  if (status && floor && !floors.includes(floor)) setFloor('')
  // 트윈 화면이 없으면 빈 층(새로고침 직후 빈 도면) 대신 첫 층 표시
  if (!TWIN_URL && !floor && floors.length) setFloor(floors[0])
  // 새 AI 결과: 대화에 추가, 이전 초안 닫기, 대상 호실 강조, 초안 대상 층으로 이동
  if (ai.result !== seen) {
    setSeen(ai.result)
    const r = ai.result
    if (r) {
      setMessages((ms) => [...ms.map((m) => (m.draftState === 'pending' ? { ...m, draftState: 'closed' as const } : m)),
        { id: uid(), fresh: true, role: 'assistant', text: r.answer, steps: r.steps, highlight: r.highlight, draft: r.draft, draftState: r.draft ? 'pending' : undefined, mock: r.mock, charts: r.charts, sources: r.sources }])
      setFocus(r.highlight.length ? r.highlight : NO_IDS)
      if (r.draft && floors.includes(r.draft.floor)) setFloor(r.draft.floor)
    }
  }

  const all = status?.rooms ?? NO_ROOMS
  const rooms = useMemo(() => floor ? all.filter((r) => r.floor === floor) : all, [all, floor])
  const summary = useMemo(() => summarize(rooms), [rooms])
  const floorSummaries: FloorSummary[] = useMemo(() => floors.map((f) => {
    const t = twin?.floors.find((x) => x.floor === f)
    if (t) return t
    const rs = all.filter((r) => r.floor === f)
    return { floor: f, total: rs.length, ...summarize(rs) }
  }), [all, floors, twin])
  const scope = floor || '건물 전체'
  const highlight = focus
  const twinData: TwinData | null = useMemo(() => status && { time: status.generatedAt, outdoorTemp: status.outdoorTemp, mock: !!status.mock, rooms: status.rooms }, [status])
  useEffect(() => postState(frame.current, building, floor, mode, rooms, highlight, twinData), [building, floor, mode, rooms, highlight, twinData])
  // 기준 시각이 갱신 주기의 2배를 초과하면 지연 표시(디자인 시스템 6절)
  const stale = status ? loadedAt - new Date(status.generatedAt).getTime() > status.refreshSeconds * 2000 : false
  const room = rooms.find((r) => r.id === selected)
  const example = scheduleExample(floors)
  const suggestions = [
    { icon: Zap, text: '현재 전력 사용량이 높은 공간은?' },
    { icon: CalendarClock, text: example },
    { icon: Droplets, text: `${floor ? floor.replace('F', '층') : '건물 전체'}에서 습도가 높은 공간 5곳 알려줘` },
  ]

  // 패널의 위치 버튼: 3D에서 선택하고 3D 영역을 화면 안으로 이동, 다른 층 호실이면 그 층으로 전환
  function locate(id: string) {
    const r = all.find((x) => x.id === id)
    if (r && r.floor !== floor) setFloor(r.floor)
    setSelected(id)
    document.querySelector('.twin')?.scrollIntoView({ block: 'nearest' })
  }

  // 추천 초안: 대화에 초안 메시지로 추가(서버 기록 대상 아님)
  function showDraft(d: Draft) {
    reset(); setSeen(null)
    setMessages((ms) => [...ms.map((m) => (m.draftState === 'pending' ? { ...m, draftState: 'closed' as const } : m)),
      { id: uid(), fresh: true, role: 'assistant', text: `최적 제어 추천에서 만든 초안입니다. ${d.roomNames[0]}${d.roomIds.length > 1 ? ` 외 ${d.roomIds.length - 1}곳` : ''}이 대상입니다.`, draft: d, draftState: 'pending', highlight: d.roomIds }])
    setFocus(d.roomIds)
  }

  function send(q: string) {
    setError('')
    setMessages((ms) => [...ms, { id: uid(), fresh: true, role: 'user', text: q }])
    ask(q)
  }

  async function save(m: ChatMsg) {
    const d = m.draft!
    setBusy(true)
    try {
      const source = [...messages].reverse().find((x) => x.role === 'user')?.text ?? '최적 제어 추천'
      const r = await saveSchedule(d, source, building)
      setMessages((ms) => [...ms.map((x) => (x.id === m.id ? { ...x, draftState: 'saved' as const } : x)),
        { id: uid(), fresh: true, role: 'assistant', note: true, text: r.mock ? `${d.time} ${ACTION[d.action]} 스케줄을 목업으로 저장했습니다. 서버에는 기록되지 않습니다.` : `${d.time} ${ACTION[d.action]} 스케줄을 저장했습니다. 시뮬레이션에만 반영됩니다.` }])
      setFocus(NO_IDS)
      setScheduleKey((k) => k + 1)
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function clear() {
    reset(); setSeen(null); setMessages([]); setFocus(NO_IDS)
    clearChat(building)
  }

  const tools = (
    <>
      {ops && status && (
        <span className={stale ? 'live stale' : 'live'} title={`5초마다 갱신(실시간 목업)${status.virtual ? ', 가상 데이터' : ''}`}>
          <i aria-hidden />{stale ? '갱신 지연' : '실시간'} {status.generatedAt.slice(11, 19)}
        </span>
      )}
      {ops && <button className="icon" onClick={load} aria-label="새로고침"><RefreshCw size={18} /></button>}
      {themeButton}
    </>
  )

  return (
    <Layout building={building} tab={tab} buildings={buildings} tools={tools}
      side={ops && (status ? <FloorList floors={floorSummaries} floor={floor} onFloor={(f) => { setFloor(f); setSelected(null) }} /> : <SkFloors n={info?.floors.length ?? 2} />)}>
      <div className="page">
        {!ops && <EnergyPage building={building} />}
        {ops && (
          <>
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
            {!status && <SkKpis />}
            {status && (
              <section className="kpis" aria-label={`${scope} 요약`}>
                <Kpi label="운전 중 HVAC" value={summary.on} unit="대" sub={`${scope} ${rooms.length}대 중`} />
                <Kpi label="정지" value={summary.off} unit="대" sub="현재 OFF 상태" />
                <Kpi label="이상 감지" value={summary.anomaly} unit="건" sub="설정온도 미도달" bad={summary.anomaly > 0} />
                <Kpi label="현재 전력" value={summary.powerKw} unit="kW" sub={`외기 ${status.outdoorTemp}℃, ${hhmm(status.generatedAt)} 기준`} />
              </section>
            )}

            <main className="grid">
              <div className="main-col">
                <section className="card twin" aria-label={`${scope} 3D 도면`}>
                  <div className="twin-head">
                    <h2>{scope} 3D 도면</h2>
                    <div className="modes" role="tablist" aria-label="표시 지표">
                      {MODES.map((m) => (
                        <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'pill on' : 'pill'} onClick={() => setMode(m.id)}>{m.label}</button>
                      ))}
                    </div>
                  </div>
                  {TWIN_URL ? (
                    <iframe ref={frame} className="embed" src={twinSrc(building)} title="3D 디지털트윈" onLoad={() => postState(frame.current, building, floor, mode, rooms, highlight, twinData)} />
                  ) : floor ? (
                    <Suspense fallback={<div className="embed"><SkPlan /></div>}>
                      <Twin3D building={building} floor={floor} mode={mode} rooms={rooms} highlight={highlight} selectedId={selected} onSelect={setSelected} dark={dark} />
                    </Suspense>
                  ) : <div className="embed" />}
                  <Legend mode={mode} status={status} />
                  {room ? <RoomDetail r={room} /> : <p className="muted pick-hint">{floor ? '호실을 누르면 HVAC 상태가 여기에 표시됩니다.' : '층을 선택하면 평면도가 표시됩니다.'}</p>}
                </section>
                {floor && <PowerTrend building={building} floor={floor} />}
                {/* 트윈 건물은 층이 비어 있을 수 있음: 빈 층이면 시간표는 전체 층 보기(2026-11-20 결정) */}
                <ScheduleTimeline building={building} floor={floor || 'all'} floors={floors} refreshKey={scheduleKey} rooms={all} onLocate={locate} />
              </div>

              <aside className="rail">
                {/* 3D 트윈 안에 있던 운전 시뮬레이션: 임베딩 화면이 작아서 3D 도면 바로 옆 패널로 */}
                {TWIN_URL && <SimPanel frame={() => frame.current} onLocate={locate} />}
                {import.meta.env.DEV && building === 'eng6' && <ExperimentPanel />}
                <ChatPanel
                  ai={ai} messages={messages} rooms={rooms} suggestions={suggestions} busy={busy} history={history}
                  onSend={send} onClear={clear} onSave={save}
                  onClose={(m) => { setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, draftState: 'closed' as const } : x))); setFocus(NO_IDS) }}
                  onFocus={setFocus} onSelect={setSelected}
                />
                {floor && <AnomalyPanel building={building} floor={floor} onLocate={(id) => { setMode('anomaly'); locate(id) }} />}
                {floor && <RecommendPanel key={`${floor}-${scheduleKey}`} building={building} floor={floor} onDraft={showDraft} onLocate={locate} />}
              </aside>
            </main>
          </>
        )}
      </div>
    </Layout>
  )
}

function Kpi({ label, value, unit, sub, bad }: { label: string; value: number; unit: string; sub: string; bad?: boolean }) {
  return (
    <div className="kpi">
      <span className="klabel">{label}</span>
      <span className={bad ? 'kval bad' : 'kval'}><CountUp value={value} /><small>{unit}</small></span>
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
