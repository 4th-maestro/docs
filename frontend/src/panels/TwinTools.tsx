import { ArrowLeft, BarChart3, Box, Droplets, Layers, Route, SlidersHorizontal, Wind, Workflow, Wrench } from 'lucide-react'
import type { TwinUi } from '../twin'

// 트윈 안에 있던 버튼을 3D 카드 도구 줄로 옮김(앱 → 트윈 ui 동작 메시지). 눌림 표시는 트윈 보고(twinUi) 기준
// - 건물·층 보기: 역할 3종, 데이터 흐름, 설비 연결(건물 보기만)
// - 호실 보기: 평면도로, 온도장, 바닥 등온선, 습도, 기류
const ROLES = [
  { id: 'owner', label: '에너지 총괄', icon: BarChart3 },
  { id: 'engineer', label: '현장 엔지니어', icon: SlidersHorizontal },
  { id: 'facility', label: '시설 관리자', icon: Wrench },
]
const ROOM_VIEWS = [
  { id: 'vol', label: '온도장', icon: Box },
  { id: 'slice', label: '바닥 등온선', icon: Layers },
  { id: 'hum', label: '습도', icon: Droplets },
  { id: 'air', label: '기류', icon: Wind },
]

export default function TwinTools({ ui, onAction }: { ui: TwinUi; onAction(action: string): void }) {
  if (ui.view === 'room') {
    return (
      <div className="tw-tools" role="toolbar" aria-label="호실 보기 도구">
        <button className="pill" onClick={() => onAction('back')}><ArrowLeft size={16} aria-hidden />평면도로</button>
        {ROOM_VIEWS.map((v) => (
          <button key={v.id} className={ui.rv[v.id] ? 'pill on' : 'pill'} aria-pressed={!!ui.rv[v.id]} onClick={() => onAction(`rv:${v.id}`)}>
            <v.icon size={16} aria-hidden />{v.label}
          </button>
        ))}
      </div>
    )
  }
  return (
    <div className="tw-tools" role="toolbar" aria-label="3D 보기 도구">
      {ROLES.map((r) => (
        <button key={r.id} className={ui.persona === r.id ? 'pill on' : 'pill'} aria-pressed={ui.persona === r.id} onClick={() => onAction(`persona:${r.id}`)}>
          <r.icon size={16} aria-hidden />{r.label}
        </button>
      ))}
      <button className={ui.flow ? 'pill on' : 'pill'} aria-pressed={ui.flow} onClick={() => onAction('flow')}><Workflow size={16} aria-hidden />데이터 흐름</button>
      {ui.view === 'building' && (
        <button className={ui.pipes ? 'pill on' : 'pill'} aria-pressed={ui.pipes} onClick={() => onAction('pipes')}><Route size={16} aria-hidden />설비 연결</button>
      )}
    </div>
  )
}
