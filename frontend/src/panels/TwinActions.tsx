import { AlertCircle, AlertTriangle, Info, LocateFixed } from 'lucide-react'
import Panel from './Panel'
import type { TwinActions as Actions } from '../twin'

// 트윈 역할별 조치 목록(트윈 안 우측 패널을 앱 카드로 옮김). 역할은 3D 카드의 역할 버튼으로 바꿈
// - 에너지 총괄: 지금 바로 아낄 수 있는 전력, 현장 엔지니어: 쾌적 비율, 시설 관리자: 실내기 상태
const LV = [
  { icon: Info, cls: '' },
  { icon: AlertCircle, cls: 'warn' },
  { icon: AlertTriangle, cls: 'bad' },
]

export default function TwinActions({ actions, at, onLocate }: { actions: Actions; at?: string; onLocate(roomId: string): void }) {
  const { title, scope, hero, items } = actions
  return (
    <Panel title={title || '조치 목록'} at={at} error="" loading={false}>
      {hero && (
        <div className="tw-hero">
          <span>{hero.label}<small>{scope}</small></span>
          <b>{hero.value}</b>
          {hero.note && <small>{hero.note}</small>}
        </div>
      )}
      {items.length ? (
        <ol className="pn-list">
          {items.slice(0, 8).map((it) => {
            const { icon: Icon, cls } = LV[it.lv] ?? LV[0]
            return (
              <li key={`${it.room}-${it.title}`}>
                <span className={`pn-tagline ${cls}`}><Icon size={14} aria-hidden />{it.title}</span>
                <p className="pn-name">{it.floor}<span>{it.detail}</span></p>
                <button className="pn-btn" onClick={() => onLocate(it.room)}><LocateFixed size={16} aria-hidden />3D에서 보기</button>
              </li>
            )
          })}
        </ol>
      ) : <p className="pn-empty">지금 조치할 항목이 없습니다.</p>}
      <p className="muted tw-foot">{items.length}건{items.length > 8 ? ', 상위 8건 표시' : ''}</p>
    </Panel>
  )
}
