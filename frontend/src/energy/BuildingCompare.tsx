import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import Panel from '../panels/Panel'
import { usePoll } from '../panels/usePoll'
import { getCompare, query } from './api'
import { Delta, Seg } from './parts'
import { NAMES, fmt } from './util'
import './energy.css'
import { Sk, SkBars } from '../skeleton/Skeleton'
import CountUp from '../motion/CountUp'

// 건물별 전력 사용량 비교: 가로 막대(이번 기간 kWh, 내림차순) + 지난 기간 같은 시점 눈금
// - 막대 두께 16px, 끝만 4px 라운드, 같은 색(파랑) 1종. 지난 기간은 회색 세로 눈금(비교 기준)
// - 값(kWh, 1㎡당 kWh, 전기요금, 증감)은 모두 막대 옆 글자로 표시해 툴팁 없이 읽음
// - 건물 행 전체가 버튼(높이 44px 이상), 누르면 onOpen(건물 id)
export default function BuildingCompare({ onOpen }: { onOpen(buildingId: string): void }) {
  const [period, setPeriod] = useState<'day' | 'month'>('day')
  const { data, error, stale } = usePoll(getCompare, query({ period }))
  const names = NAMES[data?.period ?? period]
  const items = [...(data?.items ?? [])].sort((a, b) => b.kwh - a.kwh)
  const max = Math.max(1, ...items.map((i) => Math.max(i.kwh, i.prevKwh)))
  const w = (v: number) => `${((v / max) * 100).toFixed(2)}%`

  return (
    <Panel title="건물별 전력 사용량" at={data?.generatedAt} mock={data?.mock} error={error} loading={!data && !error} skeleton={<><Sk w={240} h={44} /><SkBars rows={4} /></>} stale={stale}>
      <Seg label="비교 기간" options={[['day', '오늘'], ['month', '이번 달']]} value={period} onChange={setPeriod} />
      {data && (
        <>
          <div className="pn-keys">
            <span>
              <span className="pn-key"><i className="en-sw" style={{ background: 'var(--en-cur)' }} />{names.cur}</span>
              <span className="pn-key"><i className="en-tick" />{names.same}</span>
            </span>
            <span>단위 kWh, 가상 데이터</span>
          </div>
          <ul className="en-rows">
            {items.map((i) => (
              <li key={i.buildingId}>
                <button type="button" className="en-row" onClick={() => onOpen(i.buildingId)} aria-label={`${i.name} 상세 보기, ${names.cur} ${fmt(i.kwh)}kWh`}>
                  <span className="en-row-head"><b>{i.name}</b><strong><CountUp value={i.kwh} /><small>kWh</small></strong></span>
                  <svg className="en-bar" width="100%" height="24" aria-hidden>
                    <rect key={period} className="grow" x="0" y="4" width={w(i.kwh)} height="16" rx="4" fill="var(--en-cur)" />
                    <rect x="0" y="4" width={i.kwh > 0 ? 4 : 0} height="16" fill="var(--en-cur)" />
                    <line x1={w(i.prevKwh)} x2={w(i.prevKwh)} y1="0" y2="24" stroke="var(--en-prev)" strokeWidth="2" />
                  </svg>
                  <span className="en-row-sub">
                    <span>1㎡당 {fmt(i.kwhPerM2, 3)}kWh</span>
                    <span>전기요금 {fmt(i.costKrw, 0)}원</span>
                    <span><Delta cur={i.kwh} prev={i.prevKwh} /> {names.same} {fmt(i.prevKwh)}kWh 대비</span>
                  </span>
                  <ChevronRight className="en-chev" size={20} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          <p className="en-note">전기요금은 {fmt(data.unitPriceKrw)}원/kWh로 계산한 추정값입니다.<br />단가 기준: {data.priceBasis}</p>
          <details className="pn-table en-scroll">
            <summary>표로 보기</summary>
            <table>
              <thead><tr><th>건물</th><th>{names.cur}(kWh)</th><th>{names.same}(kWh)</th><th>1㎡당(kWh)</th><th>전기요금(원)</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.buildingId}><td>{i.name}</td><td>{fmt(i.kwh)}</td><td>{fmt(i.prevKwh)}</td><td>{fmt(i.kwhPerM2, 3)}</td><td>{fmt(i.costKrw, 0)}</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Panel>
  )
}
