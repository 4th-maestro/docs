import { useEffect, useState } from 'react'
import { Building2 } from 'lucide-react'
import { getMyCompany, type MyCompany } from '../api'
import { SkRows, SkWrap } from '../skeleton/Skeleton'
import { auditNames, FIELDS, hh, msg } from '../admin/form'
import { Audit } from '../admin/parts'
import '../admin/admin.css'

// 고객사 기업 정보(#/settings, 조회 전용): 기본 정보, 건물(운영 시간·주말 운영), 변경 이력
// - 기업 정보·건물·구성원 수정은 판매사 기업 관리(#/admin)에서만 수행
export default function SettingsPage() {
  const [data, setData] = useState<MyCompany | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getMyCompany().then(setData, (e) => setError(msg(e))) }, [])

  if (!data) {
    return (
      <main className="adm">
        <h1>기업 정보</h1>
        {error ? <p className="error adm-error" role="alert">기업 정보를 불러오지 못했습니다({error}).</p> : <SkWrap label="기업 정보를 불러오는 중입니다"><SkRows rows={4} /></SkWrap>}
      </main>
    )
  }

  const c = data.company
  return (
    <main className="adm">
      <h1>기업 정보</h1>

      <section className="card adm-card" aria-labelledby="set-info">
        <h2 id="set-info">기본 정보</h2>
        <dl className="adm-dl">
          {FIELDS.map((f) => (
            <div key={f.key} className={f.key === 'address' ? 'wide' : undefined}>
              <dt>{f.label.replace('(필수)', '')}</dt>
              <dd>{c[f.key] || '없음'}</dd>
            </div>
          ))}
        </dl>
        <p className="adm-help">기업 정보, 건물, 구성원 변경은 판매사에 요청하십시오.</p>
      </section>

      <section className="card adm-card" aria-labelledby="set-bld">
        <h2 id="set-bld">건물 {data.buildings.length}개</h2>
        {data.buildings.length === 0 && <p className="muted">연결된 건물이 없습니다. 건물 연결은 판매사에 요청하십시오.</p>}
        {!!data.buildings.length && (
          <ul className="adm-list">
            {data.buildings.map((b) => (
              <li key={b.id} className="adm-mem">
                <Building2 size={18} aria-hidden />
                <span className="adm-entry">
                  {b.name}
                  <small>{b.use}, {b.floors.length}개 층, 호실 {b.roomCount}개</small>
                  <small>운영 {hh(b.hours[0])}~{hh(b.hours[1])}시, 주말 {b.weekend ? '운영' : '휴무'}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Audit base="/company" at={data} names={auditNames(data)} />
    </main>
  )
}
