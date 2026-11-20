import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { CheckCircle2, Clock, LocateFixed, Power, PowerOff, Thermometer } from 'lucide-react'
import { cancelSchedule, listSchedules } from '../api'
import { Seg } from '../energy/parts'
import '../energy/energy.css'
import { kstNow } from '../mock'
import { SkTimetable } from '../skeleton/Skeleton'
import type { Room } from '../types'
import Panel from './Panel'
import type { Schedule } from './types'
import { usePoll } from './usePoll'

const ACTION = { off: '운전 OFF', on: '운전 ON', setpoint: '설정온도' }
const ICON = { off: PowerOff, on: Power, setpoint: Thermometer }
// 1시간 칸 높이(px): 16px 글자 2줄과 여백, 시간표 영역은 최대 520px에서 스크롤
const ROW = 36
const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
const act = (s: Schedule) => `${ACTION[s.action]}${s.action === 'setpoint' ? ` ${s.setpoint}℃` : ''}`

// 대상 요약: "2F 회의실 3곳"(층·용도가 여럿이면 "외"), 층 보기에서 일부 호실만 그 층이면 "2F 회의실 3곳(전체 5곳)"
function target(s: Schedule, byId: Map<string, Room>, ids = s.roomIds) {
  const rs = ids.map((id) => byId.get(id)).filter((r): r is Room => !!r)
  if (!rs.length) return `${ids.length}곳`
  const floors = [...new Set(rs.map((r) => r.floor))]
  const uses = [...new Set(rs.map((r) => r.use))]
  return `${floors.length > 2 ? `${floors[0]} 외` : floors.join(', ')} ${uses.length > 1 ? `${uses[0]} 외` : uses[0]} ${ids.length}곳${ids.length < s.roomIds.length ? `(전체 ${s.roomIds.length}곳)` : ''}`
}

// 오늘 스케줄(세로 시간표): 왼쪽 시각, 스케줄은 시작 시각부터 그날 끝까지 칸을 채움(스케줄은 매일 지정 시각부터 적용, lambda/src/sim.py)
// - 지금 선으로 현재 시각 표시, 지난 시간은 옅은 면
// - 칸을 누르면 아래 상세 카드에서 대상 호실, 3D 보기, 취소(2단계 확인)
export default function ScheduleTimeline({ building, floor, floors, refreshKey, rooms = [], onLocate }: { building: string; floor: string; floors: string[]; refreshKey: number; rooms?: Room[]; onLocate?(roomId: string): void }) {
  // refreshKey: 스케줄 저장 후 App이 올리는 값, 바뀌면 다시 조회
  const load = useCallback((_key: number) => listSchedules(building), [building])
  const { data, error, reload } = usePoll(load, refreshKey)
  const [picked, setPicked] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState({ ok: '', err: '' })
  // 층 보기: 기본은 왼쪽 목록의 선택 층, 그 층이 바뀌면 다시 맞춤
  // 렌더 중 상태 조정 패턴: key 재마운트는 재조회로 스켈레톤이 다시 표시됨
  const [view, setView] = useState(floor)
  const [lastFloor, setLastFloor] = useState(floor)
  if (floor !== lastFloor) { setLastFloor(floor); setView(floor); setConfirm(false) }
  const box = useRef<HTMLDivElement>(null)
  const now = kstNow().slice(11, 16)
  const nowMin = minutes(now)
  const byId = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms])
  // 층 보기의 대상 호실: 그 층 호실만, 호실 목록에 없는 호실은 '전체'에서만 표시
  const idsOf = useCallback((s: Schedule) => (view === 'all' ? s.roomIds : s.roomIds.filter((id) => byId.get(id)?.floor === view)), [view, byId])
  const items = useMemo(() => (data?.schedules ?? []).filter((s) => view === 'all' || idsOf(s).length).sort((a, b) => a.time.localeCompare(b.time)), [data, view, idsOf])
  // 표시 범위: 06시와 가장 이른 스케줄, 현재 시각 중 이른 시각부터 24시까지
  const startH = Math.min(6, Math.floor(nowMin / 60), ...items.map((s) => Math.floor(minutes(s.time) / 60)))
  const y = (m: number) => ((m - startH * 60) / 60) * ROW
  const hours = Array.from({ length: 24 - startH + 1 }, (_, i) => startH + i)
  const sel = items.find((s) => s.id === picked) ?? items.find((s) => s.time > now) ?? items[0]
  const selIds = sel ? idsOf(sel) : []

  // 처음 표시: 지금 선이 위에서 두 칸 아래에 오도록 스크롤
  const shown = !!data
  useEffect(() => {
    if (shown && box.current) box.current.scrollTop = Math.max(0, y(nowMin) - ROW * 2)
  }, [shown]) // eslint-disable-line react-hooks/exhaustive-deps

  async function cancel(s: Schedule) {
    setBusy(true)
    try {
      const r = await cancelSchedule(s.id)
      setMsg({ ok: `${s.time} ${act(s)} 스케줄을 취소했습니다.${r.mock ? ' 목업 스케줄이라 서버에는 기록되지 않습니다.' : ''}`, err: '' })
      setConfirm(false); setPicked(null)
      reload()
    } catch (e) {
      // 네트워크 실패(TypeError)와 서버 거절(400, 404)을 구분해 표시
      setMsg({ ok: '', err: e instanceof TypeError ? '서버에 연결하지 못해 스케줄을 취소하지 못했습니다.' : `스케줄을 취소하지 못했습니다(${(e as Error).message}).` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="오늘 스케줄" mock={data?.mock} error={error || msg.err} loading={!data && !error} skeleton={<SkTimetable />}>
      {data && (
        <>
          <div className="tt-floors">
            <Seg label="층별로 보기" options={[['all', '전체'], ...floors.map((f): [string, string] => [f, f])]} value={view} onChange={(v) => { setView(v); setConfirm(false) }} />
          </div>
          <div className="tt-sum">
            <span><b>{items.length}</b>건</span>
            <span className="tt-key"><i className="tt-sw on" />적용 중</span>
            <span className="tt-key"><i className="tt-sw next" />적용 예정</span>
            <span className="tt-key"><i className="tt-sw now" />지금 {now}</span>
          </div>
          <div className="tt" ref={box} tabIndex={0} aria-label={`오늘 스케줄 시간표${view === 'all' ? '' : `, ${view}`}, ${startH}시부터 24시까지, 스케줄 ${items.length}건`}>
            <div className="tt-grid" style={{ height: y(24 * 60) + 96 }}>
              <div className="tt-past" style={{ height: Math.max(0, y(nowMin)) }} aria-hidden />
              {hours.map((h) => (
                <div key={h} className="tt-hour" style={{ top: y(h * 60) }} aria-hidden><span>{String(h).padStart(2, '0')}시</span></div>
              ))}
              <ol className="tt-lanes" style={{ '--n': Math.max(1, items.length) } as CSSProperties}>
                {items.map((s, i) => {
                  const on = s.time <= now
                  const Icon = ICON[s.action]
                  const top = y(minutes(s.time))
                  return (
                    <li key={s.id} className="tt-lane">
                      <button
                        className={`tt-block a-${s.action} ${on ? 'live' : 'next'}${sel?.id === s.id ? ' sel' : ''} rise-in`}
                        style={{ top, height: y(24 * 60) - top, '--i': i } as CSSProperties}
                        onClick={() => { setPicked(s.id); setConfirm(false); setMsg({ ok: '', err: '' }) }}
                        aria-pressed={sel?.id === s.id}
                        aria-label={`${s.time}부터 ${act(s)}, ${target(s, byId, idsOf(s))}, ${s.condition === 'unused' ? '재실 없을 때만' : '항상'}, ${on ? '적용 중' : '적용 예정'}`}
                      >
                        {/* 글자 묶음은 시간표 스크롤 위치에 고정: 이른 시각에 시작한 긴 칸도 내용이 화면에 남음 */}
                        <span className="tt-in">
                          <span className="tt-time">{s.time}부터</span>
                          <span className="tt-act"><Icon size={18} aria-hidden />{act(s)}</span>
                          <span className="tt-target">{target(s, byId, idsOf(s))}</span>
                          <span className="tt-cond">{s.condition === 'unused' ? '재실 없을 때만' : '항상'}</span>
                          <span className="tt-state">{on ? <><CheckCircle2 size={16} aria-hidden />적용 중</> : <><Clock size={16} aria-hidden />예정</>}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ol>
              <div className="tt-now" style={{ top: y(nowMin) }} aria-hidden />
              <span className="tt-nowtag" style={{ top: y(nowMin) }} aria-hidden>지금 {now}</span>
              {items.length === 0 && <p className="tt-empty">{view === 'all' ? '오늘 저장된 스케줄이 없습니다. AI 운영 도우미나 최적 제어 추천에서 만들 수 있습니다.' : `${view}에 오늘 저장된 스케줄이 없습니다.`}</p>}
            </div>
          </div>
          {msg.ok && <p className="pn-ok" role="status">{msg.ok}</p>}
          {sel && (
            <div className="tt-detail fade-in" key={sel.id}>
              <div className="tt-detail-head">
                <b>{sel.time}부터 {act(sel)}</b>
                <span>{sel.time <= now ? '적용 중' : '적용 예정'}</span>
              </div>
              <p>{target(sel, byId, selIds)}, {sel.condition === 'unused' ? '재실이 없을 때만 적용' : '재실과 관계없이 적용'}</p>
              <p className="tt-rooms">{selIds.map((id) => byId.get(id)?.name).filter(Boolean).slice(0, 6).join(', ')}{selIds.length > 6 ? ` 외 ${selIds.length - 6}곳` : ''}</p>
              {!confirm ? (
                <div className="pn-btns">
                  {onLocate && <button className="pn-btn" onClick={() => onLocate(selIds[0])}><LocateFixed size={18} aria-hidden />3D에서 보기</button>}
                  <button className="pn-btn" onClick={() => setConfirm(true)}>스케줄 취소</button>
                </div>
              ) : (
                <div className="pn-confirm">
                  <p>{sel.time} {act(sel)} 스케줄을 취소하면 시뮬레이션에서 바로 제외됩니다.</p>
                  <div className="pn-btns">
                    <button className="pn-btn" onClick={() => setConfirm(false)} disabled={busy}>유지</button>
                    <button className="pn-btn ink" onClick={() => cancel(sel)} disabled={busy}>취소 실행</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  )
}
