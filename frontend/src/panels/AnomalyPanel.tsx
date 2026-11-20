import { useCallback } from 'react'
import { AlertTriangle, LocateFixed } from 'lucide-react'
import { getAnomalies } from '../api'
import Panel from './Panel'
import type { Likelihood } from './types'
import { hhmm, usePoll } from './usePoll'
import { SkRows, SkTable } from '../skeleton/Skeleton'

const LIKELY: Record<Likelihood, string> = { high: '높음', medium: '보통', low: '낮음' }
const signed = (v: number) => `${v > 0 ? '+' : ''}${v}`
const duration = (m: number) => (m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`)

export default function AnomalyPanel({ building, floor, onLocate }: { building: string; floor: string; onLocate(roomId: string): void }) {
  const load = useCallback((f: string) => getAnomalies(f, building), [building])
  const { data, error, stale } = usePoll(load, floor)
  return (
    <Panel
      title="이상 감지" at={data?.generatedAt} mock={data?.mock} error={error} loading={!data && !error} skeleton={<><SkRows rows={1} tall /><SkTable rows={3} cols={2} /></>} stale={stale}
      empty={data?.items.length === 0 && `${floor}에 설정온도 미도달 HVAC이 없습니다.`}
    >
      {data && (
        <ol className="pn-list">
          {data.items.map((a, idx) => (
            <li key={a.roomId} className="rise-in" style={{ '--i': idx } as React.CSSProperties}>
              <div>
                <span className="pn-tagline bad"><AlertTriangle size={14} aria-hidden />설정온도 미도달</span>
                <p className="pn-name">{a.roomName}<span>HVAC {a.idu}</span></p>
              </div>
              <dl className="pn-kv">
                <dt>설정·현재</dt><dd>{a.setpoint}℃, {a.temp}℃(차이 {signed(a.gap)}℃)</dd>
                <dt>기대 온도</dt><dd>{a.expectedTemp}℃, 잔차 {signed(a.residual)}℃(정상 HVAC {a.peerCount}대 기준)</dd>
                <dt>지속</dt><dd>{duration(a.durationMin)}({hhmm(a.detectedAt)}부터)</dd>
              </dl>
              <h3>원인 후보{data.causeBasis === 'rule' ? '(규칙 기반 추정)' : ''}</h3>
              <ul className="pn-causes">
                {a.causes.map((c) => (
                  <li key={c.label}>
                    <span className={`pn-like ${c.likelihood}`}>{LIKELY[c.likelihood]}</span>
                    <span><b>{c.label}</b><small>{c.evidence}</small></span>
                  </li>
                ))}
              </ul>
              <button className="pn-btn" onClick={() => onLocate(a.roomId)}><LocateFixed size={16} aria-hidden />3D에서 보기</button>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}
