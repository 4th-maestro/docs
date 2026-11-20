import { useState } from 'react'
import { Play } from 'lucide-react'
import './panels.css'

type Engine = '5r1c' | 'energyplus' | 'both'
type Summary = { hvac_estimated_energy_Wh: number; occupied_out_of_range_room_minutes: number }
type Step = { timestamp: string; interval_end: string; interval_mean_indoor_temperature_c: number; applied_mode: string }
type Run = { summary: Summary; rows: Step[] }
type Report = { baseline: Run; candidate: Run }
type Result = { room: string; start: string; end: string; weather: string; results: Partial<Record<Exclude<Engine, 'both'>, Report>> }

const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const energy = (wh: number) => number.format(wh / 1000)
const clock = (timestamp: string) => timestamp.slice(11, 16)

export default function ExperimentPanel() {
  const [engine, setEngine] = useState<Engine>('5r1c')
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch('/api/experiment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine }),
      })
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new Error('실험은 로컬 개발 서버에서 실행할 수 있습니다.')
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '실험을 실행하지 못했습니다.')
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '실험을 실행하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card pn sim" aria-label="시나리오 실험" aria-busy={busy}>
      <div className="pn-head">
        <h2>시나리오 실험</h2>
        <span className="pn-meta">합성 데이터 · 15분 간격</span>
      </div>
      <div className="pn-body">
        <form className="sim-f" onSubmit={event => { event.preventDefault(); void run() }}>
          <p className="sim-note">제6공학관 예제 호실에서 상시 운전과 재실 기반 운전을 비교합니다.</p>
          <label>실험 엔진
            <select value={engine} disabled={busy} onChange={event => { setEngine(event.target.value as Engine); setResult(null); setError('') }}>
              <option value="5r1c">5R1C</option>
              <option value="energyplus">EnergyPlus</option>
              <option value="both">5R1C + EnergyPlus</option>
            </select>
          </label>
          <button className="primary" type="submit" disabled={busy}><Play size={16} aria-hidden />{busy ? '계산 중…' : '예제 실험 실행'}</button>
        </form>
        {error && <p className="sim-msg" role="alert">{error}</p>}
        {result && (
          <div aria-live="polite">
            <p className="sim-note">{result.room} · {result.start.slice(0, 10)} {clock(result.start)}–{clock(result.end)} · {result.weather}</p>
            {Object.entries(result.results).map(([id, report]) => (
              <div className="sim-more" key={id}>
                <h3>{id === '5r1c' ? '5R1C' : 'EnergyPlus'}</h3>
                <table className="sim-t">
                  <thead><tr><th scope="col">지표</th><th scope="col">상시 운전</th><th scope="col">재실 기반</th></tr></thead>
                  <tbody>
                    <tr><th scope="row">추정 소비전력량</th><td>{energy(report.baseline.summary.hvac_estimated_energy_Wh)} kWh</td><td>{energy(report.candidate.summary.hvac_estimated_energy_Wh)} kWh</td></tr>
                    <tr><th scope="row">재실 중 온도 범위 이탈</th><td>{report.baseline.summary.occupied_out_of_range_room_minutes}분</td><td>{report.candidate.summary.occupied_out_of_range_room_minutes}분</td></tr>
                  </tbody>
                </table>
                <details className="sim-more">
                  <summary>15분별 평균 실온</summary>
                  <table className="sim-t">
                    <thead><tr><th scope="col">시간</th><th scope="col">상시 운전</th><th scope="col">재실 기반</th></tr></thead>
                    <tbody>
                      {report.candidate.rows.map((row, i) => (
                        <tr key={row.timestamp}>
                          <th scope="row">{clock(row.timestamp)}–{clock(row.interval_end)}</th>
                          <td>{number.format(report.baseline.rows[i].interval_mean_indoor_temperature_c)}°C</td>
                          <td>{number.format(row.interval_mean_indoor_temperature_c)}°C{row.applied_mode === 'OFF' ? ' · 정지' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
