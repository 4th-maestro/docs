import { useCallback, useState } from 'react'
import { LocateFixed, X } from 'lucide-react'
import { cancelSchedule, listSchedules } from '../api'
import { kstNow } from '../mock'
import Panel from './Panel'
import type { Schedule } from './types'
import { usePoll } from './usePoll'

const ACTION = { off: '운전 OFF', on: '운전 ON', setpoint: '설정온도' }
const TICKS = [0, 6, 12, 18, 24]
const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
const pct = (m: number) => `${(m / 1440) * 100}%`
const act = (s: Schedule) => `${ACTION[s.action]}${s.action === 'setpoint' ? ` ${s.setpoint}℃` : ''}`

export default function ScheduleTimeline({ building, refreshKey, onLocate }: { building: string; refreshKey: number; onLocate?(roomId: string): void }) {
  // refreshKey: 스케줄 저장 후 App이 올리는 값, 바뀌면 다시 조회
  const load = useCallback((_key: number) => listSchedules(building), [building])
  const { data, error, reload } = usePoll(load, refreshKey)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState({ ok: '', err: '' })
  // 스케줄은 매일 지정 시각부터 적용(lambda/src/sim.py), 현재 시각 이전이면 오늘 적용 중
  const now = kstNow().slice(11, 16)
  const items = [...(data?.schedules ?? [])].sort((a, b) => a.time.localeCompare(b.time))

  async function cancel(s: Schedule) {
    setBusy(true)
    try {
      const r = await cancelSchedule(s.id)
      setMsg({ ok: `${s.time} ${act(s)} 스케줄을 취소했습니다.${r.mock ? ' 목업 스케줄이라 서버에는 기록되지 않습니다.' : ''}`, err: '' })
      setConfirm(null)
      reload()
    } catch (e) {
      // 네트워크 실패(TypeError)와 서버 거절(400, 404)을 구분해 표시
      setMsg({ ok: '', err: e instanceof TypeError ? '서버에 연결하지 못해 스케줄을 취소하지 못했습니다.' : `스케줄을 취소하지 못했습니다(${(e as Error).message}).` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="오늘 스케줄" mock={data?.mock} error={error || msg.err} loading={!data && !error}>
      {data && (
        <>
          <div className="pn-axis" role="img" aria-label={`0시부터 24시까지 스케줄 ${items.length}건, 현재 ${now}`}>
            <div className="pn-track">
              {items.map((s) => <i key={s.id} className={s.time <= now ? 'pn-dot' : 'pn-dot next'} style={{ left: pct(minutes(s.time)) }} title={`${s.time} ${act(s)}`} />)}
              <i className="pn-nowline" style={{ left: pct(minutes(now)) }} />
            </div>
            <div className="pn-ticks">{TICKS.map((h) => <span key={h} style={{ left: pct(h * 60) }}>{h}시</span>)}</div>
          </div>
          <div className="pn-legend">
            <span><i className="pn-dot" />적용 중</span>
            <span><i className="pn-dot next" />적용 예정</span>
            <span><i className="pn-nowline" />지금 {now}</span>
          </div>
          {msg.ok && <p className="pn-ok" role="status">{msg.ok}</p>}
          {items.length === 0 ? (
            <p className="pn-empty">저장된 스케줄이 없습니다.</p>
          ) : (
            <ol className="pn-list">
              {items.map((s) => (
                <li key={s.id} className="pn-sched">
                  <span className="pn-time">{s.time}</span>
                  <span className="pn-sdesc">
                    <b>{act(s)}</b>
                    <span>{s.condition === 'unused' ? '재실 없을 때' : '항상'}, 대상 {s.roomIds.length}곳, {s.time <= now ? '적용 중' : '적용 예정'}</span>
                  </span>
                  {confirm !== s.id && (
                    <span className="pn-actions">
                      {onLocate && <button className="pn-icon" onClick={() => onLocate(s.roomIds[0])} aria-label={`${s.time} 스케줄 대상 3D에서 보기`} title="3D에서 보기"><LocateFixed size={18} /></button>}
                      <button className="pn-icon" onClick={() => { setConfirm(s.id); setMsg({ ok: '', err: '' }) }} aria-label={`${s.time} ${act(s)} 스케줄 취소`} title="스케줄 취소"><X size={18} /></button>
                    </span>
                  )}
                  {confirm === s.id && (
                    <div className="pn-confirm">
                      <p>{s.time} {act(s)} 스케줄을 취소하면 시뮬레이션에서 바로 제외됩니다.</p>
                      <div className="pn-btns">
                        <button className="pn-btn" onClick={() => setConfirm(null)} disabled={busy}>유지</button>
                        <button className="pn-btn ink" onClick={() => cancel(s)} disabled={busy}>취소 실행</button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Panel>
  )
}
