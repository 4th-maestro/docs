import { useEffect, useState } from 'react'
import { ChevronDown, LocateFixed, Play } from 'lucide-react'
import { onTwinSim, sendTwin, type SimForm, type SimState } from '../twin'
import './panels.css'

// 운전 시뮬레이션(EnergyPlus)
// - 기간 기본값 '지금부터 N시간': 기준 = 현재 설정을 유지했을 때의 예측, 선택 = 그 구간만 설정온도 변경 (즉시 운영 판단)
// - '시간 지정': 시작·끝 시각, 사람 적은 시간 끄기, 사전 냉·난방 (운영 계획 검토), 기준 = 오늘 실제 운전(실측) 또는 기존 운전
// - 결과에는 실제 계산 구간을 항상 표시. 핵심(절감·실온)만 펼치고 나머지는 '자세히'에 접어 둠
// - 냉방(5~9월)·난방(그 밖) 모드는 트윈이 정해 보냄: 설정온도 범위·전력 이름·추운/더운 방 기준이 바뀜
// 계산은 3D 트윈이 계산 서버(npm run twin:sim)로 돌리고 결과만 여기 표시
const f1 = (v: number | null | undefined) => (v == null || !isFinite(v) ? '–' : v.toLocaleString('ko-KR', { maximumFractionDigits: 1 }))
const won = (v: number) => (Math.abs(v) >= 10000 ? `₩${f1(v / 10000)}만` : `₩${Math.round(v).toLocaleString('ko-KR')}`)
const sign = (v: number) => (v > 0 ? '+' : '') + f1(v)
type Row = [string, number | null | undefined, number | null | undefined, string]

function Table({ head, rows }: { head: [string, string]; rows: Row[] }) {
  return (
    <table className="sim-t">
      <thead><tr><th /><th>{head[0]}</th><th>{head[1]}</th></tr></thead>
      <tbody>
        {rows.map(([l, a, b, u]) => (
          <tr key={l}><th>{l}</th><td>{f1(a)}{u}</td><td className={a != null && b != null && b !== a ? (b < a ? 'up' : 'dn') : ''}>{f1(b)}{u}</td></tr>
        ))}
      </tbody>
    </table>
  )
}

export default function SimPanel({ frame, onLocate }: { frame: () => HTMLIFrameElement | null; onLocate(id: string): void }) {
  const [s, setS] = useState<SimState | null>(null)
  const [form, setForm] = useState<SimForm | null>(null)
  useEffect(() => onTwinSim((x) => { setS(x); setForm((f) => (f && f.mode === x.form.mode ? f : { ...x.form, period: 'now', durH: x.form.durH ?? 2 })) }), [])
  const set = <K extends keyof SimForm>(k: K, v: SimForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const R = s?.result, W = R?.window
  const now = form?.period === 'now' && !!s?.hasLive
  const heat = (R?.mode ?? s?.mode) === 'heat', MK = heat ? '난방' : '냉방', [spLo, spHi] = (s?.mode === 'heat') ? [18, 26] : [22, 28]
  return (
    <section className="card pn sim" aria-label="운전 시뮬레이션" aria-busy={s?.busy}>
      <div className="pn-head">
        <h2>운전 시뮬레이션</h2>
        <span className="pn-meta">{s ? `${s.scope} · EnergyPlus` : '트윈 연결 대기'}</span>
      </div>
      {!s || !form ? <div className="pn-skel" aria-hidden><i /><i /><i /></div> : (
        <div className="pn-body">
          <form className="sim-f" onSubmit={(e) => { e.preventDefault(); sendTwin(frame(), { type: 'simRun', form: { ...form, period: now ? 'now' : 'range' } }) }}>
            <div className="sim-two">
              <label>기간
                <select value={now ? 'now' : 'range'} onChange={(e) => set('period', e.target.value as SimForm['period'])}>
                  <option value="now" disabled={!s.hasLive}>지금부터</option>
                  <option value="range">시간 지정</option>
                </select>
              </label>
              {now ? (
                <label>운전 시간
                  <select value={form.durH} onChange={(e) => set('durH', +e.target.value)}>
                    {[1, 2, 3, 4, 6, 8].map((h) => <option key={h} value={h}>{h}시간</option>)}
                  </select>
                </label>
              ) : (
                <label>{s.mode === 'heat' ? '난방' : '냉방'} 설정온도 <output>{(+form.coolSetpoint).toFixed(1)}°C</output>
                  <input type="range" min={spLo} max={spHi} step={0.5} value={form.coolSetpoint} onChange={(e) => set('coolSetpoint', +e.target.value)} />
                </label>
              )}
            </div>
            {now ? (
              <label className="sim-row">{s.mode === 'heat' ? '난방' : '냉방'} 설정온도 <output>{(+form.coolSetpoint).toFixed(1)}°C</output>
                <input type="range" min={spLo} max={spHi} step={0.5} value={form.coolSetpoint} onChange={(e) => set('coolSetpoint', +e.target.value)} />
              </label>
            ) : (
              <>
                <div className="sim-two">
                  <label>시작<input type="time" value={form.start} onChange={(e) => set('start', e.target.value)} /></label>
                  <label>끝<input type="time" value={form.end === '24:00' ? '23:59' : form.end} onChange={(e) => set('end', e.target.value === '23:59' ? '24:00' : e.target.value)} /></label>
                </div>
                <div className="sim-two">
                  <label className="sim-chk"><input type="checkbox" checked={form.offWhenEmpty} onChange={(e) => set('offWhenEmpty', e.target.checked)} />사람 적은 시간 끄기</label>
                  <label>사전 {s.mode === 'heat' ? '난방' : '냉방'}
                    <select value={form.precoolMin} onChange={(e) => set('precoolMin', +e.target.value)}>
                      <option value={0}>없음</option><option value={30}>30분</option><option value={60}>1시간</option><option value={120}>2시간</option>
                    </select>
                  </label>
                </div>
                {s.hasLive && <label className="sim-chk"><input type="checkbox" checked={form.useLive} onChange={(e) => set('useLive', e.target.checked)} />오늘 실측 기준(기준 = 오늘 실제 운전)</label>}
              </>
            )}
            <p className="sim-base">기준: {now ? <b>현재 설정 유지 시 예측</b> : form.useLive && s.hasLive ? <b>오늘 실제 운전</b> : <b>기존 운전 {s.base.coolSetpoint}°C · {s.base.hours.join('~')}</b>}</p>
            <button className="primary" type="submit" disabled={s.busy}><Play size={16} aria-hidden />{s.busy ? '계산 중…' : 'EnergyPlus로 계산'}</button>
            {s.msg && (s.busy || s.msg.startsWith('⚠')) && <p className="sim-msg" role="status">{s.msg}</p>}
          </form>

          {R ? (
            <>
              {/* 핵심: 계산 구간 · 절감 · 실온 */}
              <div className="pn-stat">
                <span className="label">
                  계산 구간 <b className="sim-range">{W ? W.label : R.scenario.scenario.hours.join('~')}</b>
                  {W ? ` · ${R.baseName} 대비` : R.live ? ` · 오늘(${R.live.date.slice(5).replace('-', '/')}) 실제 운전 대비` : ` · 기존 운전 대비 (${R.weather})`}
                </span>
                {W ? (
                  <>
                    <strong>{f1(W.savedKwh)}<small>kWh{W.savedPct != null && ` (${f1(W.savedPct)}%)`} · {won(W.savedWon)}</small></strong>
                    <span className="sub">켜진 방 평균 실온 {f1(W.base.avgT)} → <b>{f1(W.scenario.avgT)}°C</b>{!heat && ` · 최고 ${f1(W.scenario.maxT)}°C`}{W.clipped && ' · 오늘 24시까지만 계산'}</span>
                  </>
                ) : (
                  <>
                    <strong>{f1(R.compare.savedKwh)}<small>kWh ({f1(R.compare.savedPct)}%) · {won(R.compare.savedWon)}</small></strong>
                    <span className="sub">재실 평균 실온 {f1(R.baseline.avgT)} → <b>{f1(R.scenario.avgT)}°C</b> · 불만족 PPD {sign(R.compare.ppdChange)}%p</span>
                  </>
                )}
              </div>

              {/* 덜 중요한 정보는 접어 둠 */}
              <details className="sim-more">
                <summary><ChevronDown size={16} aria-hidden />자세히 (하루 전체 비교 · 보정 · 방별 결과)</summary>
                {W && (
                  <>
                    <Table head={[R.baseName, `${W.setpoint}°C`]} rows={[
                      ['구간 전력', W.base.kwh, W.scenario.kwh, 'kWh'], ['구간 요금', W.base.won, W.scenario.won, '원'],
                      ['구간 평균 실온', W.base.avgT, W.scenario.avgT, '°C'], ['구간 최고 실온', W.base.maxT, W.scenario.maxT, '°C'],
                    ]} />
                    <p className="sim-note">구간이 끝난 뒤 오늘 끝까지 {sign(W.afterSavedKwh)}kWh (설정을 되돌리면 실온을 다시 맞추느라 전력이 늘 수 있음)</p>
                  </>
                )}
                <Table head={[W ? '하루 전체 · 기준' : R.live ? '오늘 실제' : '기존', `선택 ${W ? W.setpoint : R.scenario.scenario.coolSetpoint}°C`]} rows={[
                  [`${MK} 전력`, R.baseline.kpi.elecKwh, R.scenario.kpi.elecKwh, 'kWh'], ['전기요금', R.baseline.kpi.costWon, R.scenario.kpi.costWon, '원'],
                  ['재실 평균 실온', R.baseline.avgT, R.scenario.avgT, '°C'], ...(heat ? [] : [['가장 더운 실', R.baseline.kpi.hottest?.tempC, R.scenario.kpi.hottest?.tempC, '°C'] as Row]),
                  ['열 불쾌도', R.baseline.kpi.tdisKhPerZone, R.scenario.kpi.tdisKhPerZone, 'K·h/실'], ['불만족 PPD', R.baseline.kpi.ppd, R.scenario.kpi.ppd, '%'],
                ]} />
                {!W && R.restOfDay && <p className="sim-note">지금({R.restOfDay.fromHour}시)부터 오늘 끝까지 {f1(R.restOfDay.savedKwh)}kWh · {won(R.restOfDay.savedWon)} 절감</p>}
                {R.calibration && (
                  <p className="sim-note" title={R.calibration.note}>실측 보정 ×{f1(R.calibration.factor)} · 지난 {R.calibration.hours}시간 실측{R.calibration.cvrmsePct != null && ` · CV(RMSE) ${f1(R.calibration.cvrmseRawPct)}% → ${f1(R.calibration.cvrmsePct)}%`}</p>
                )}
                {R.live && <p className="sim-note">기상: 외기 {f1(R.live.weather.min)}~{f1(R.live.weather.max)}°C (지난 시간 실측 · 이후 오늘 예보, 예보가 없으면 지금 외기 유지) · 재실: {s.occ}</p>}
                <ol className="pn-list sim-rooms">
                  {R.rooms.map((r) => (
                    <li key={r.id}>
                      <div className="pn-row">
                        <div>
                          <b>{r.name}</b> <small className="muted">{r.floor} · {heat ? `재실 평균 ${f1(r.avgT)}` : `최고 ${f1(r.maxT)}`}°C</small>
                          <p className="muted">재실 평균 {f1(r.baseAvgT)} → <b>{f1(r.avgT)}°C</b> · 전력 {f1(r.baseKwh)} → {f1(r.kwh)}kWh</p>
                        </div>
                        <button className="icon" aria-label={`${r.name} 3D에서 보기`} onClick={() => { sendTwin(frame(), { type: 'simRoom', room: r.id }); onLocate(r.id) }}><LocateFixed size={16} /></button>
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="sim-note">{s.msg} · {MK} 모드 · EnergyPlus 24.2 · ISO 7730 PMV/PPD · BOPTEST KPI · 한전 요금</p>
              </details>
            </>
          ) : <p className="pn-empty">기간과 설정온도를 고르고 <b>EnergyPlus로 계산</b>을 누르면 절감 전력·요금과 예상 실온이 여기 표시됩니다.</p>}
        </div>
      )}
    </section>
  )
}
