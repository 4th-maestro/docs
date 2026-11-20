import { useState } from 'react'
import type { Period } from './api'
import BreakdownPanel from './BreakdownPanel'
import HeatmapPanel from './HeatmapPanel'
import { Seg } from './parts'
import TrendPanel from './TrendPanel'
import './energy.css'

// 건물 1개의 에너지 분석: 기간 선택(일·주·월)이 추이와 사용 구성에 함께 적용, 히트맵은 최근 4주 고정
export default function EnergyPage({ building }: { building: string }) {
  const [period, setPeriod] = useState<Period>('day')
  return (
    <div className="en-page">
      <div className="en-wide">
        <Seg label="분석 기간" options={[['day', '일'], ['week', '주'], ['month', '월']]} value={period} onChange={setPeriod} />
      </div>
      <div className="en-wide"><TrendPanel building={building} period={period} /></div>
      <BreakdownPanel building={building} period={period} />
      <HeatmapPanel building={building} />
    </div>
  )
}
