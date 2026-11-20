import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowUp, CalendarClock, Droplets, Info, RefreshCw, Zap } from 'lucide-react'
import { ask, getStatus, saveSchedule } from './api'
import { ANOMALY, SCALES, color, ink, value } from './heat'
import { TWIN_URL, onRoomSelected, postState } from './twin'
import type { Draft, Mode, QueryResult, Room, Status } from './types'

const MODES: { id: Mode; label: string }[] = [
  { id: 'temp', label: '온도' },
  { id: 'powerKw', label: '전력' },
  { id: 'humidity', label: '습도' },
  { id: 'anomaly', label: '이상 감지' },
]
const EXAMPLES = ['현재 전력 사용량이 높은 공간은?', '2층 13시 이후 미사용 회의실 냉방 OFF']
// AI 패널 빈 상태의 추천 질의(채널톡 AI 패널 참고)
const SUGGESTIONS = [
  { icon: Zap, text: '현재 전력 사용량이 높은 공간은?' },
  { icon: CalendarClock, text: '2층 13시 이후 미사용 회의실 냉방 OFF' },
  { icon: Droplets, text: '1층에서 습도가 높은 공간 5곳 알려줘' },
]
const ACTION = { off: '운전 OFF', on: '운전 ON', setpoint: '설정온도 변경' }

const hhmm = (iso: string) => iso.slice(11, 16)
// 실시간 연동(목업): WebSocket 대신 5초 주기로 상태 재조회, 값은 Lambda·목업이 범위 안에서 변동
const LIVE_MS = 5_000
const NO_ROOMS: Room[] = []
const NO_IDS: string[] = []

export default function App() {
  const [floor, setFloor] = useState('1F')
  const [mode, setMode] = useState<Mode>('temp')
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [asked, setAsked] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [saved, setSaved] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)

  const load = () => getStatus(floor).then((s) => { setStatus(s); setLoadedAt(Date.now()) }).catch((e: Error) => setError(e.message))
  useEffect(() => {
    load()
    const id = setInterval(load, LIVE_MS)
    return () => clearInterval(id)
  }, [floor]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onRoomSelected(setSelected), [])

  const rooms = status?.rooms ?? NO_ROOMS
  const highlight = result?.highlight ?? NO_IDS
  useEffect(() => postState(frame.current, floor, mode, rooms, highlight), [floor, mode, rooms, highlight])
  // 기준 시각이 갱신 주기의 2배를 넘으면 지연 표시(디자인 시스템 6절)
  const stale = status ? loadedAt - new Date(status.generatedAt).getTime() > status.refreshSeconds * 2000 : false
  const room = rooms.find((r) => r.id === selected)
  const watch = useMemo(() => {
    const ids = new Set(highlight)
    const picked = rooms.filter((r) => ids.has(r.id) || r.anomaly)
    return (picked.length ? picked : [...rooms].sort((a, b) => b.powerKw - a.powerKw)).slice(0, 6)
  }, [rooms, highlight])

  async function submit(q = text) {
    if (!q.trim() || busy) return
    setBusy(true); setError(''); setSaved(''); setAsked(q)
    try {
      const r = await ask(q)
      setResult(r)
      if (r.draft && r.draft.floor !== 'all') setFloor(r.draft.floor)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function confirm(draft: Draft) {
    setBusy(true)
    try {
      const r = await saveSchedule(draft, asked)
      setSaved(r.mock ? `${draft.time} ${ACTION[draft.action]} 스케줄을 목업으로 저장했습니다. 서버에는 기록되지 않습니다.` : `${draft.time} ${ACTION[draft.action]} 스케줄을 저장했습니다. 시뮬레이션에만 반영됩니다.`)
      setResult((r) => (r ? { ...r, draft: null } : r))
      load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="nav">
        <div className="brand">Maestro<span>의원 건물(공개 IFC)</span></div>
        <nav className="tabs" aria-label="층 선택">
          {(status?.floors ?? ['1F', '2F']).map((f) => (
            <button key={f} className={f === floor ? 'tab on' : 'tab'} onClick={() => setFloor(f)}>{f}</button>
          ))}
        </nav>
        <div className="meta">
          {status && <span className={stale ? 'stale' : ''}>데이터 기준 {status.generatedAt.slice(11, 19)}, 5초 갱신(실시간 목업){status.virtual ? ', 가상 데이터' : ''}</span>}
          <button className="icon" onClick={load} aria-label="새로고침"><RefreshCw size={16} /></button>
        </div>
      </header>

      <form className="search" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <label htmlFor="q">자연어 질의</label>
        <input id="q" value={text} onChange={(e) => setText(e.target.value)} placeholder="예: 2층 13시 이후 미사용 회의실 냉방 OFF" maxLength={500} />
        <button className="orb" type="submit" disabled={busy || !text.trim()} aria-label="질의 보내기"><ArrowUp size={20} /></button>
      </form>
      <p className="hint">AI 해석은 틀릴 수 있습니다. 제어 요청은 확인 후에만 저장됩니다.</p>
      <div className="chips">
        {EXAMPLES.map((q) => <button key={q} className="chip" onClick={() => { setText(q); submit(q) }}>{q}</button>)}
      </div>
      {status?.virtual && (
        <div className="banner" role="note">
          <Info size={16} aria-hidden />
          <span>가상 데이터로 채운 화면입니다. 실제 설비 수치가 아닙니다.{status.mock ? ' API에 연결하지 못해 목업 데이터를 표시합니다.' : ''}</span>
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
        <section className="card twin">
          <div className="twin-head">
            <div className="modes" role="tablist">
              {MODES.map((m) => (
                <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'pill on' : 'pill'} onClick={() => setMode(m.id)}>{m.label}</button>
              ))}
            </div>
          </div>
          {TWIN_URL ? (
            <iframe ref={frame} className="embed" src={TWIN_URL} title="3D 디지털트윈" onLoad={() => postState(frame.current, floor, mode, rooms, highlight)} />
          ) : (
            <div className="tiles" aria-label="호실 상태(3D 트윈 연결 전 목록 보기)">
              {rooms.map((r) => <Tile key={r.id} r={r} mode={mode} hot={highlight.includes(r.id)} onClick={() => setSelected(r.id)} />)}
            </div>
          )}
          <Legend mode={mode} status={status} />
        </section>

        <aside className="rail">
          <section className="card">
            <h2>AI 응답</h2>
            {busy && <p className="muted">해석 중입니다.</p>}
            {!busy && !result && (
              <ul className="suggest">
                {SUGGESTIONS.map(({ icon: Icon, text: q }) => (
                  <li key={q}><button onClick={() => { setText(q); submit(q) }}><Icon size={16} aria-hidden />{q}</button></li>
                ))}
              </ul>
            )}
            {result?.mock && <span className="tag">목업 응답</span>}
            {result && <p className="answer">{result.answer}</p>}
            {result?.draft && <DraftCard d={result.draft} busy={busy} onCancel={() => setResult({ ...result, draft: null })} onSave={() => confirm(result.draft!)} />}
            {saved && <p className="ok">{saved}</p>}
          </section>
          {room && <RoomCard r={room} />}
        </aside>

        <section className="card watch">
          <h2>{highlight.length ? '질의 결과 호실' : '확인할 호실'}</h2>
          <ul>
            {watch.map((r) => (
              <li key={r.id}>
                <button onClick={() => setSelected(r.id)}>
                  <span className="name">{r.anomaly && <AlertTriangle size={14} color={ANOMALY} aria-label="이상" />}{r.name}</span>
                  <span className="num">{r.onOff ? `${r.powerKw}kW` : 'OFF'}</span>
                  <span className="muted">{r.use}, {r.idu}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>
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

function Tile({ r, mode, hot, onClick }: { r: Room; mode: Mode; hot: boolean; onClick: () => void }) {
  const style = { background: color(mode, r), color: ink(mode, r), outlineColor: r.anomaly && mode === 'anomaly' ? ANOMALY : undefined }
  return (
    <button className={`tile${hot ? ' hot' : ''}${r.anomaly && mode === 'anomaly' ? ' bad' : ''}`} style={style} onClick={onClick} title={r.name}>
      <span className="tname">{r.name}</span>
      <span className="tval">{value(mode, r)}</span>
      <span className="tidu">{r.onOff ? '운전' : 'OFF'}, {r.occupants}명</span>
    </button>
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

function RoomCard({ r }: { r: Room }) {
  return (
    <section className="card">
      <h2>{r.name}</h2>
      <p className="muted">{r.floor}, {r.use}, {r.areaM2}㎡, {r.idu}</p>
      <dl className="kv">
        <dt>운전</dt><dd>{r.onOff ? `${r.mode === 'cooling' ? '냉방' : '난방'} 운전` : 'OFF'}</dd>
        <dt>설정온도</dt><dd>{r.setpoint}℃</dd>
        <dt>실내온도</dt><dd>{r.temp}℃</dd>
        <dt>습도</dt><dd>{r.humidity}%</dd>
        <dt>전력</dt><dd>{r.powerKw}kW</dd>
        <dt>재실</dt><dd>{r.occupants}명</dd>
      </dl>
      {r.anomaly && <p className="bad-line"><AlertTriangle size={14} />설정온도 미도달: 운전 중 실내온도가 설정온도와 3℃ 이상 차이</p>}
    </section>
  )
}
