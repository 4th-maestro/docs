import { useCallback } from 'react'
import { CalendarPlus, LocateFixed, Moon, Thermometer, UserX } from 'lucide-react'
import { getRecommendations } from '../api'
import type { Draft } from '../types'
import Panel from './Panel'
import type { Rule } from './types'
import { usePoll } from './usePoll'
import { SkFigure, SkRows } from '../skeleton/Skeleton'
import CountUp from '../motion/CountUp'

// 규칙 3종(architecture.md 8절): 태그는 아이콘과 글자로 함께 표시
const RULES: Record<Rule, { label: string; Icon: typeof UserX }> = {
  idle: { label: '빈 공간 운전', Icon: UserX },
  after_hours: { label: '업무 외 운전', Icon: Moon },
  overset: { label: '과냉·과열 설정', Icon: Thermometer },
}

// building 변경 시 App이 key로 다시 마운트(이전 건물 값이 새 건물 값처럼 보이지 않도록)
export default function RecommendPanel({ building, floor, onDraft, onLocate }: { building: string; floor: string; onDraft(draft: Draft): void; onLocate(roomId: string): void }) {
  const load = useCallback((f: string) => getRecommendations(f, building), [building])
  const { data, error, stale } = usePoll(load, floor)
  return (
    <Panel
      title="최적 제어 추천" at={data?.generatedAt} mock={data?.mock} error={error} loading={!data && !error} skeleton={<><SkFigure /><SkRows rows={3} action tall /></>} stale={stale}
      empty={data?.items.length === 0 && `${floor}에서 낭비 규칙에 해당하는 HVAC이 없습니다.`}
    >
      {data && (
        <>
          <div className="pn-stat">
            <span className="label">예상 절감 합계</span>
            <strong><CountUp value={data.totalSavingKwh} /><small>kWh/일</small></strong>
            <span className="sub">{floor} 추천 {data.items.length}건, 시뮬레이터 적용 전후 비교(가상)</span>
          </div>
          <ol className="pn-list">
            {data.items.map((it, idx) => {
              const { label, Icon } = RULES[it.rule]
              return (
                <li key={it.id} className="rise-in" style={{ '--i': idx } as React.CSSProperties}>
                  <div className="pn-row">
                    <div>
                      <span className="pn-tagline"><Icon size={14} aria-hidden />{label}</span>
                      <p className="pn-name">{it.roomName}<span>HVAC {it.idu}</span></p>
                    </div>
                    <button className="pn-icon" onClick={() => onLocate(it.roomId)} aria-label={`${it.roomName} 3D에서 보기`} title="3D에서 보기"><LocateFixed size={18} /></button>
                  </div>
                  <p className="pn-reason">{it.reason}</p>
                  <div className="pn-row">
                    <span className="pn-saving">{it.title}<strong>절감 {it.savingKwhDay}kWh/일</strong></span>
                    <button className="pn-btn" onClick={() => onDraft(it.draft)} aria-label={`${it.roomName} 스케줄 초안 만들기`}><CalendarPlus size={16} aria-hidden />초안 만들기</button>
                  </div>
                </li>
              )
            })}
          </ol>
        </>
      )}
    </Panel>
  )
}
