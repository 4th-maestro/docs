import { AlertTriangle, CalendarPlus, ChevronDown, ChevronUp, LocateFixed, Moon, Thermometer, UserX } from 'lucide-react'
import type { Draft } from '../types'
import type { Recommendations, Rule } from '../panels/types'
import { hhmm } from '../panels/usePoll'
import { Sk, SkRows, SkWrap } from '../skeleton/Skeleton'
import '../panels/panels.css'

// 규칙 3종(architecture.md 8절): 태그는 아이콘과 글자로 함께 표시
const RULES: Record<Rule, { label: string; Icon: typeof UserX }> = {
  idle: { label: '빈 공간 운전', Icon: UserX },
  after_hours: { label: '업무 외 운전', Icon: Moon },
  overset: { label: '과냉·과열 설정', Icon: Thermometer },
}

type Poll = { data: Recommendations | null; error: string; stale: boolean }

// 추천 배지: 대화 머리글, 누르면 대화 위에 목록 펼침
// - 건수: 조회 중·층 변경 직후는 같은 폭 회색 블록, 첫 조회 실패는 '-'
export function RecommendBadge({ poll, open, onToggle }: { poll: Poll; open: boolean; onToggle(): void }) {
  const n = poll.data && !poll.stale ? poll.data.items.length : null
  const Chevron = open ? ChevronUp : ChevronDown
  return (
    <button type="button" className="rec-toggle" aria-expanded={open} onClick={onToggle}
      aria-label={n == null ? '최적 제어 추천 불러오는 중' : `최적 제어 추천 ${n}건`}>
      <span className="ops-badge rec-badge">
        추천<span className="rec-n">{n ?? (poll.error ? '-' : <Sk w="2ch" h={14} r={4} />)}</span>
        <Chevron size={16} aria-hidden />
      </span>
    </button>
  )
}

// 추천 펼침 목록: 대화 위, 절감량 큰 순. 층 ''(건물 전체)이면 항목마다 층 이름 표시
export function RecommendList({ poll, floor, onDraft, onLocate }: { poll: Poll; floor: string; onDraft(draft: Draft): void; onLocate(roomId: string): void }) {
  const { data, error, stale } = poll
  const scope = floor || '건물 전체'
  const items = data ? [...data.items].sort((a, b) => b.savingKwhDay - a.savingKwhDay) : []
  return (
    <section className={stale ? 'chat-rec stale' : 'chat-rec'} aria-label={`${scope} 최적 제어 추천`} aria-busy={!data || stale}>
      {error && <p className="pn-error" role="alert"><AlertTriangle size={16} aria-hidden />{error}</p>}
      {!data ? (!error && <SkWrap><SkRows rows={2} action tall /></SkWrap>) : (
        <>
          <div className="rec-total">
            <strong>예상 절감 합계 {data.totalSavingKwh}kWh/일, {items.length}건</strong>
            <span className="pn-meta">
              시뮬레이터 적용 전후 비교(가상)
              {data.mock && <span className="pn-mock">목업</span>}
              <time dateTime={data.generatedAt}>기준 {hhmm(data.generatedAt)}</time>
            </span>
          </div>
          {items.length === 0 ? <p className="pn-empty">{scope}에서 낭비 규칙에 해당하는 HVAC이 없습니다.</p> : (
            <ol className="rec-list">
              {items.map((it, idx) => {
                const { label, Icon } = RULES[it.rule]
                const name = floor ? it.roomName : `${it.floor} ${it.roomName}`
                return (
                  <li key={it.id} className="rise-in" style={{ '--i': idx } as React.CSSProperties}>
                    <span className="pn-tagline"><Icon size={16} aria-hidden />{label}</span>
                    <p className="pn-name">{name}<span>HVAC {it.idu}</span></p>
                    <p className="pn-reason">{it.reason}</p>
                    <p className="pn-saving">{it.title}<strong>절감 {it.savingKwhDay}kWh/일</strong></p>
                    <div className="pn-btns">
                      <button type="button" className="pn-btn" onClick={() => onLocate(it.roomId)} aria-label={`${name} 3D에서 보기`}><LocateFixed size={16} aria-hidden />3D에서 보기</button>
                      <button type="button" className="pn-btn" onClick={() => onDraft(it.draft)} aria-label={`${name} 스케줄 초안 만들기`}><CalendarPlus size={16} aria-hidden />초안 만들기</button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </>
      )}
    </section>
  )
}
