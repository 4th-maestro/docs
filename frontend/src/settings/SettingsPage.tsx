import { useContext, useEffect, useState } from 'react'
import { Building2, Copy, Pencil } from 'lucide-react'
import { getMyCompany, updateBuilding, updateMyCompany, type BuildingInput, type CompanyBuilding, type MyCompany } from '../api'
import { ME_CHANGED, MeContext } from '../auth/me'
import { buildingsChanged } from '../custom'
import { Seg } from '../energy/parts'
import { SkRows, SkWrap } from '../skeleton/Skeleton'
import { auditNames, EMPTY, FIELDS, formOk, forUpdate, msg, toForm, type Form } from '../admin/form'
import { Audit, Expiry, Fields, Members } from '../admin/parts'
import '../admin/admin.css'

// 운영 시간 표시: 0~24시, 두 자리
const hh = (h: number) => String(h).padStart(2, '0')
const HOURS = Array.from({ length: 25 }, (_, h) => h)
const WEEKEND: ['on' | 'off', string][] = [['on', '운영'], ['off', '휴무']]
// 사이드바 기업 이름·역할 갱신(App이 GET /me 다시 조회)
const meChanged = () => window.dispatchEvent(new Event(ME_CHANGED))

// 고객사 기업 설정(#/settings): 기업 정보, 건물, 구성원, 변경 이력
// - 고객사 관리자 판정: GET /company 응답의 members 포함 여부(서버가 관리자에게만 제공)
// - 고객사 관리자: 기업 정보 수정, 기업 코드 확인·복사, 건물 정보 수정, 구성원 역할 변경·제외
// - 운영자: 기업 정보·건물 조회, 변경 이력 조회
export default function SettingsPage() {
  const me = useContext(MeContext)
  const [data, setData] = useState<MyCompany | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState<Form>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<string | null>(null)
  const [out, setOut] = useState<{ at: string; text: string; bad?: boolean } | null>(null)

  // 입력칸은 첫 조회와 저장 후에만 채움(구성원 변경 후 다시 조회해도 입력 중인 값 유지)
  useEffect(() => { getMyCompany().then((d) => { setData(d); setForm(toForm(d.company)) }, (e) => setError(msg(e))) }, [])
  const reload = () => getMyCompany().then(setData, (e) => setError(msg(e)))

  async function saveInfo(e: React.FormEvent) {
    e.preventDefault()
    if (!data) return
    const patch = forUpdate(form, data.company)
    if (!formOk(form) || !Object.keys(patch).length) return
    setBusy(true); setOut(null)
    try {
      const r = await updateMyCompany(patch)
      setData({ ...data, company: { ...data.company, ...r.company } })
      setForm(toForm(r.company))
      setOut({ at: 'info', text: '기업 정보를 저장했습니다.' })
      meChanged()
    } catch (err) {
      setOut({ at: 'info', text: msg(err), bad: true })
    } finally {
      setBusy(false)
    }
  }

  // 클립보드: https·localhost에서만 사용 가능, 실패하면 직접 선택 안내(코드 글자는 누르면 전체 선택)
  function copy(code: string) {
    Promise.resolve().then(() => navigator.clipboard.writeText(code)).then(
      () => setOut({ at: 'code', text: '기업 코드를 복사했습니다.' }),
      () => setOut({ at: 'code', text: '복사하지 못했습니다. 코드를 직접 선택해 복사하십시오.', bad: true }),
    )
  }

  function saved(b: CompanyBuilding) {
    setEdit(null)
    setData((d) => d && { ...d, buildings: d.buildings.map((x) => (x.id === b.id ? b : x)) })
    setOut({ at: 'bld', text: `${b.name} 정보를 저장했습니다.` })
    // 상단 건물 선택 목록의 이름 갱신
    buildingsChanged()
  }

  const say = (at: string) => out?.at === at && <p key={out.text} className={out.bad ? 'adm-warn fade-in' : 'ok fade-in'} role={out.bad ? 'alert' : 'status'}>{out.text}</p>

  if (!data) {
    return (
      <main className="adm">
        <h1>기업 설정</h1>
        {error ? <p className="error adm-error" role="alert">기업 정보를 불러오지 못했습니다({error}).</p> : <SkWrap label="기업 정보를 불러오는 중입니다"><SkRows rows={4} /></SkWrap>}
      </main>
    )
  }

  const c = data.company
  const manager = !!data.members
  const patch = forUpdate(form, c)

  return (
    <main className="adm">
      <h1>기업 설정</h1>
      {error && <p className="error adm-error" role="alert">{error}</p>}

      <section className="card adm-card" aria-labelledby="set-info">
        <h2 id="set-info">기업 정보</h2>
        {c.code && (
          <>
            <span className="adm-label">기업 코드</span>
            <p className="adm-codebox">
              <span className="adm-codeval">{c.code}</span>
              {c.codeExpiresAt && <Expiry iso={c.codeExpiresAt} />}
            </p>
            <button className="secondary adm-btn" type="button" onClick={() => copy(c.code!)}><Copy size={18} aria-hidden />코드 복사</button>
            <p className="adm-help">새 구성원은 이 코드로 가입합니다. 코드 재발급은 판매사에 요청하십시오.</p>
            {say('code')}
          </>
        )}
        {manager ? (
          <form className="adm-stack" onSubmit={saveInfo}>
            <Fields value={form} onChange={setForm} />
            <button className="primary adm-btn" type="submit" disabled={busy || !formOk(form) || !Object.keys(patch).length}>저장</button>
          </form>
        ) : (
          <dl className="adm-dl">
            {FIELDS.map((f) => (
              <div key={f.key} className={f.key === 'address' ? 'wide' : undefined}>
                <dt>{f.label.replace('(필수)', '')}</dt>
                <dd>{c[f.key] || '없음'}</dd>
              </div>
            ))}
          </dl>
        )}
        {say('info')}
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
                {manager && edit !== b.id && (
                  <button className="adm-mini" type="button" onClick={() => { setEdit(b.id); setOut(null) }} aria-label={`${b.name} 정보 수정`}><Pencil size={16} aria-hidden />정보 수정</button>
                )}
                {edit === b.id && <BuildingForm b={b} onSaved={saved} onCancel={() => setEdit(null)} />}
              </li>
            ))}
          </ul>
        )}
        {say('bld')}
      </section>

      {data.members && <Members base="/company" members={data.members} self={me?.email} onChange={() => { reload(); meChanged() }} />}
      <Audit base="/company" at={data} names={auditNames(data)} />
    </main>
  )
}

// 건물 정보 수정: 이름 1~40자, 용도 1~20자, 운영 시간(0~24시, 시작 < 종료), 주말 운영
// - 바뀐 항목만 전송, 저장 결과(서버 응답)를 목록에 반영
function BuildingForm({ b, onSaved, onCancel }: { b: CompanyBuilding; onSaved: (b: CompanyBuilding) => void; onCancel: () => void }) {
  const [name, setName] = useState(b.name)
  const [use, setUse] = useState(b.use)
  const [start, setStart] = useState(b.hours[0])
  const [end, setEnd] = useState(b.hours[1])
  const [weekend, setWeekend] = useState(b.weekend)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const body: Required<BuildingInput> = { name: name.trim(), use: use.trim(), hours: [start, end], weekend }
  const patch = Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(b[k as keyof BuildingInput]))) as BuildingInput
  const bad = !body.name ? '건물 이름을 입력하십시오.' : !body.use ? '용도를 입력하십시오.' : start >= end ? '운영 종료 시각은 시작 시각보다 늦어야 합니다.' : ''

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (bad || !Object.keys(patch).length) return
    setBusy(true); setError('')
    try {
      const r = await updateBuilding(b.id, patch)
      onSaved({ ...b, ...r.building })
    } catch (err) {
      setError(msg(err))
      setBusy(false)
    }
  }

  const hour = (label: string, value: number, set: (h: number) => void, hours: number[]) => (
    <label>
      {label}
      <select value={value} onChange={(e) => set(Number(e.target.value))} aria-invalid={start >= end || undefined}>
        {hours.map((h) => <option key={h} value={h}>{hh(h)}시</option>)}
      </select>
    </label>
  )
  return (
    <form className="adm-ask fade-in" onSubmit={save} aria-label={`${b.name} 정보 수정`}>
      <div className="adm-fields">
        <label>건물 이름<input value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} aria-required aria-invalid={!body.name || undefined} /></label>
        <label>용도<input value={use} maxLength={20} autoComplete="off" onChange={(e) => setUse(e.target.value)} aria-required aria-invalid={!body.use || undefined} /></label>
        {hour('운영 시작', start, setStart, HOURS.slice(0, 24))}
        {hour('운영 종료', end, setEnd, HOURS.slice(1))}
      </div>
      <span className="adm-label" aria-hidden>주말 운영</span>
      <Seg label="주말 운영" options={WEEKEND} value={weekend ? 'on' : 'off'} onChange={(v) => setWeekend(v === 'on')} />
      {bad && <p className="adm-warn" role="alert">{bad}</p>}
      {error && <p key={error} className="adm-warn fade-in" role="alert">{error}</p>}
      <div className="adm-btns">
        <button className="adm-dark adm-btn" type="submit" disabled={busy || !!bad || !Object.keys(patch).length}>저장</button>
        <button className="secondary adm-btn" type="button" onClick={onCancel}>취소</button>
      </div>
    </form>
  )
}
