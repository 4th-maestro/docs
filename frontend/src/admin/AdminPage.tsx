import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Building2, Copy, FileImage, Link2, Pencil, PencilRuler, Plus, RefreshCw, ShieldCheck, Trash2, Unlink } from 'lucide-react'
import {
  assignBuilding, buildingsChanged, co, createCompany, deleteBuilding, deleteCompany, getCompany, listAdminBuildings, listCompanies, listUsers, patchBuilding, renewCode, updateCompany,
  type AdminBuilding, type Company, type CompanyDetail, type CompanyRow, type UserRow,
} from '../api'
import type { AdminSub } from '../shell/route'
import { Seg } from '../energy/parts'
import { SkRows, SkTable, SkWrap } from '../skeleton/Skeleton'
import BuildingPage from './BuildingPages'
import { auditNames, day, EMPTY, forCreate, formOk, forUpdate, hh, msg, toForm, type Form } from './form'
import { Audit, BuildingForm, Expiry, Fields, Members, State } from './parts'
import './admin.css'

// 회원 상태: Cognito UserStatus → 운영자용 표현
const STATUS: Record<string, string> = {
  CONFIRMED: '사용 중', UNCONFIRMED: '이메일 인증 대기', FORCE_CHANGE_PASSWORD: '첫 로그인 대기', RESET_REQUIRED: '비밀번호 재설정 필요',
}
// 기업 코드 유효 기간: API 허용 1~365일, 기본 30일
const DAYS: [string, string][] = [['7', '7일'], ['30', '30일'], ['90', '90일'], ['365', '1년']]
const STATES: [Company['status'], string][] = [['active', '사용 중'], ['suspended', '사용 중지']]

// 판매사 기업 관리(관리자 전용): #/admin 기업 목록·추가·가입한 사용자, #/admin/<기업 id> 기업 상세, 하위 건물 화면(BuildingPages)
// - 권한 판정은 API(admin API)가 수행, 관리자가 아니면 403 안내 표시
export default function AdminPage({ company, sub }: { company?: string; sub?: AdminSub }) {
  if (company && sub) return <BuildingPage company={company} sub={sub} />
  return company ? <CompanyView key={company} id={company} /> : <CompanyList />
}

function CompanyList() {
  const [rows, setRows] = useState<CompanyRow[] | null>(null)
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState<Form>(EMPTY)
  const [days, setDays] = useState('30')
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState('')

  useEffect(() => {
    listCompanies().then((r) => setRows(r.companies), (e) => setError(msg(e)))
    listUsers().then((r) => setUsers(r.users), (e) => setError(msg(e)))
  }, [])

  // 생성 후 상세로 이동: 기업 코드 복사·건물 연결을 바로 진행
  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (!formOk(form)) return
    setBusy(true); setFail('')
    try {
      const r = await createCompany({ ...forCreate(form), codeDays: Number(days) })
      location.hash = `#/admin/${r.company.id}`
    } catch (err) {
      setFail(msg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="adm">
      <h1>기업 관리</h1>
      {error && <p className="error adm-error" role="alert">{error}</p>}

      <section className="card adm-card" aria-labelledby="adm-cos">
        <h2 id="adm-cos">기업 {rows ? `${rows.length}곳` : ''}</h2>
        {rows === null && !error && <SkWrap label="기업 목록을 불러오는 중입니다"><SkTable rows={3} cols={6} /></SkWrap>}
        {rows?.length === 0 && <p className="muted">등록한 기업이 없습니다. 아래 기업 추가에서 만드십시오.</p>}
        {!!rows?.length && (
          <table className="adm-table adm-cos">
            <thead><tr><th>기업 이름</th><th>기업 코드</th><th>코드 만료일</th><th>건물</th><th>구성원</th><th>상태</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td><a className="adm-name" href={`#/admin/${c.id}`}>{c.name}</a></td>
                  <td className="adm-mono">{c.code}</td>
                  <td><Expiry iso={c.codeExpiresAt} /></td>
                  <td>{c.buildingCount}개</td>
                  <td>{c.memberCount}명</td>
                  <td><State status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card adm-card" aria-labelledby="adm-new">
        <h2 id="adm-new">기업 추가</h2>
        <form className="adm-stack" onSubmit={create}>
          <Fields value={form} onChange={setForm} />
          <span className="adm-label" aria-hidden>기업 코드 유효 기간</span>
          <Seg label="기업 코드 유효 기간" options={DAYS} value={days} onChange={setDays} />
          <button className="primary adm-btn" type="submit" disabled={busy || !formOk(form)}><Plus size={18} aria-hidden />기업 만들기</button>
          {fail && <p className="adm-warn" role="alert">{fail}</p>}
        </form>
      </section>

      <section className="card adm-card" aria-labelledby="adm-users">
        <h2 id="adm-users">가입한 사용자 {users ? `${users.length}명` : ''}</h2>
        {users === null && !error && <SkWrap label="사용자 목록을 불러오는 중입니다"><SkTable rows={4} cols={3} /></SkWrap>}
        {!!users?.length && (
          <table className="adm-table">
            <thead><tr><th>이메일</th><th>상태</th><th>가입일</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.email}>
                  <td>{u.email}{u.admin && <span className="tag adm-tag"><ShieldCheck size={14} aria-hidden />관리자</span>}</td>
                  <td>{!u.enabled ? '사용 중지' : STATUS[u.status] ?? u.status}</td>
                  <td>{day(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}

// 기업 상세: 기업 코드(복사, 재발급), 기업 정보·사용 상태, 건물(추가, 정보 수정, 도면 편집·교체, 연결·해제, 영구 삭제), 구성원(역할 변경, 제외), 변경 이력, 삭제
// - 재확인: 코드 재발급, 건물 연결 해제·삭제, 구성원 역할 변경·제외, 기업 삭제(DESIGN.md 비가역 동작)
// - 결과 문구는 동작한 카드 안에 표시
function CompanyView({ id }: { id: string }) {
  const [data, setData] = useState<CompanyDetail | null>(null)
  const [all, setAll] = useState<AdminBuilding[]>([])
  const [error, setError] = useState('')
  const [form, setForm] = useState<Form>(EMPTY)
  const [days, setDays] = useState('30')
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<string | null>(null)
  const [out, setOut] = useState<{ at: string; text: string; bad?: boolean } | null>(null)

  const load = useCallback(() => Promise.all([getCompany(id), listAdminBuildings()]).then(([d, b]) => { setData(d); setAll(b.buildings); return d }), [id])
  useEffect(() => { load().then((d) => setForm(toForm(d.company)), (e) => setError(msg(e))) }, [load])

  async function run(at: string, work: () => Promise<unknown>, done: string) {
    setBusy(true); setAsk(null); setOut(null)
    try {
      await work()
      setOut({ at, text: done })
      await load().catch((e) => setError(msg(e)))
    } catch (e) {
      setOut({ at, text: msg(e), bad: true })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true); setAsk(null); setOut(null)
    try {
      await deleteCompany(id)
      location.hash = '#/admin'
    } catch (e) {
      // 건물이 남아 있으면 409와 서버 안내 문구
      setOut({ at: 'del', text: msg(e), bad: true })
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

  const say = (at: string) => out?.at === at && <p key={out.text} className={out.bad ? 'adm-warn fade-in' : 'ok fade-in'} role={out.bad ? 'alert' : 'status'}>{out.text}</p>
  const back = <a className="adm-back" href="#/admin"><ArrowLeft size={18} aria-hidden />기업 목록</a>

  if (!data) {
    return (
      <main className="adm">
        {back}
        {error ? <p className="error adm-error" role="alert">{error}</p> : <SkWrap label="기업 정보를 불러오는 중입니다"><SkRows rows={4} /></SkWrap>}
      </main>
    )
  }

  const c = data.company
  const patch = forUpdate(form, c)
  const mine = new Set(data.buildings.map((b) => b.id))
  const free = all.filter((b) => !mine.has(b.id) && !b.companyId)
  const taken = all.filter((b) => !mine.has(b.id) && b.companyId)
  const picked = all.find((b) => b.id === pick)

  return (
    <main className="adm">
      {back}
      <div className="adm-title"><h1>{c.name}</h1><State status={c.status} /></div>
      {error && <p className="error adm-error" role="alert">{error}</p>}

      <section className="card adm-card" aria-labelledby="adm-code">
        <h2 id="adm-code">기업 코드</h2>
        <p className="adm-codebox">
          <span className="adm-codeval">{c.code}</span>
          <Expiry iso={c.codeExpiresAt} />
        </p>
        <div className="adm-btns">
          <button className="secondary adm-btn" type="button" onClick={() => copy(c.code)}><Copy size={18} aria-hidden />코드 복사</button>
          <button className="secondary adm-btn" type="button" onClick={() => setAsk(ask === 'code' ? null : 'code')} aria-expanded={ask === 'code'}><RefreshCw size={18} aria-hidden />코드 재발급</button>
        </div>
        {ask === 'code' && (
          <div className="adm-ask fade-in">
            <span className="adm-label" aria-hidden>새 코드 유효 기간</span>
            <Seg label="새 코드 유효 기간" options={DAYS} value={days} onChange={setDays} />
            <p className="adm-help">새 코드를 발급하면 지금 코드로는 가입할 수 없습니다. 이미 가입한 구성원은 그대로 유지됩니다.</p>
            <div className="adm-btns">
              <button className="adm-dark adm-btn" type="button" disabled={busy} onClick={() => run('code', () => renewCode(id, Number(days)), '새 기업 코드를 발급했습니다. 이전 코드는 사용할 수 없습니다.')}>새 코드 발급</button>
              <button className="secondary adm-btn" type="button" onClick={() => setAsk(null)}>취소</button>
            </div>
          </div>
        )}
        {say('code')}
      </section>

      <section className="card adm-card" aria-labelledby="adm-info">
        <h2 id="adm-info">기업 정보</h2>
        <form className="adm-stack" onSubmit={(e) => { e.preventDefault(); if (formOk(form) && Object.keys(patch).length) run('info', () => updateCompany(id, patch).then((r) => setForm(toForm(r.company))), '기업 정보를 저장했습니다.') }}>
          <Fields value={form} onChange={setForm} />
          <button className="primary adm-btn" type="submit" disabled={busy || !formOk(form) || !Object.keys(patch).length}>저장</button>
        </form>
        <span className="adm-label" aria-hidden>사용 상태</span>
        <Seg label="사용 상태" options={STATES} value={c.status} onChange={(s) => { if (s !== c.status && !busy) run('info', () => updateCompany(id, { status: s }), s === 'active' ? '사용 중으로 바꿨습니다.' : '사용 중지로 바꿨습니다. 이 기업의 코드로는 가입할 수 없습니다.') }} />
        {say('info')}
      </section>

      <section className="card adm-card" aria-labelledby="adm-bld">
        <h2 id="adm-bld">건물 {data.buildings.length}개</h2>
        {data.buildings.length === 0 && <p className="muted">연결한 건물이 없습니다. 구성원에게 표시할 건물이 없습니다.</p>}
        {!!data.buildings.length && (
          <ul className="adm-list">
            {data.buildings.map((b) => {
              const open = (k: string) => setAsk(ask === `${k}:${b.id}` ? null : `${k}:${b.id}`)
              const plan = `#/admin/${id}/buildings/${b.id}`
              return (
                <li key={b.id} className="adm-mem">
                  <Building2 size={18} aria-hidden />
                  <span className="adm-entry">
                    {b.name}
                    <small>{b.use}, {b.floors.length}개 층, 호실 {b.roomCount}개</small>
                    {b.hours && <small>운영 {hh(b.hours[0])}~{hh(b.hours[1])}시, 주말 {b.weekend ? '운영' : '휴무'}</small>}
                    {b.hasTwin === false && <small id={`nt-${b.id}`}>트윈 도면 없음, 도면 교체 후 편집 가능</small>}
                  </span>
                  <span className="adm-bacts">
                    <button className="adm-mini" type="button" disabled={busy || !b.hours} onClick={() => open('edit')} aria-expanded={ask === `edit:${b.id}`} aria-label={`${b.name} 정보 수정`}><Pencil size={16} aria-hidden />정보 수정</button>
                    {b.hasTwin === false
                      ? <button className="adm-mini" type="button" disabled aria-describedby={`nt-${b.id}`}><PencilRuler size={16} aria-hidden />도면 편집</button>
                      : <a className="adm-mini" href={`${plan}/plan`} aria-label={`${b.name} 도면 편집`}><PencilRuler size={16} aria-hidden />도면 편집</a>}
                    <a className="adm-mini" href={`${plan}/replace`} aria-label={`${b.name} 도면 교체`}><FileImage size={16} aria-hidden />도면 교체</a>
                    <button className="adm-mini" type="button" disabled={busy} onClick={() => open('un')} aria-expanded={ask === `un:${b.id}`} aria-label={`${b.name} 연결 해제`}><Unlink size={16} aria-hidden />연결 해제</button>
                    <button className="adm-mini danger" type="button" disabled={busy} onClick={() => open('del')} aria-expanded={ask === `del:${b.id}`} aria-label={`${b.name} 삭제`}><Trash2 size={16} aria-hidden />삭제</button>
                  </span>
                  {ask === `edit:${b.id}` && b.hours && (
                    <BuildingForm init={b} label={`${b.name} 정보 수정`} ok="저장" cancel="취소" diff onCancel={() => setAsk(null)}
                      submit={async (body) => { await patchBuilding(b.id, body); setAsk(null); setOut({ at: 'bld', text: `${b.name} 정보를 저장했습니다.` }); buildingsChanged(); await load().catch((e) => setError(msg(e))) }} />
                  )}
                  {(ask === `un:${b.id}` || ask === `del:${b.id}`) && (
                    <div className="adm-ask fade-in">
                      <p className="adm-help">
                        {ask === `un:${b.id}`
                          ? `${b.name} 건물 연결을 해제합니다. ${c.name} 구성원은 이 건물을 볼 수 없게 됩니다. 건물 데이터는 유지됩니다.`
                          : `${b.name} 건물을 영구 삭제합니다. 건물 정보, 도면, 호실 목록이 삭제되며 되돌릴 수 없습니다.`}
                      </p>
                      <div className="adm-btns">
                        {ask === `un:${b.id}`
                          ? <button className="adm-dark adm-btn" type="button" disabled={busy} onClick={() => run('bld', () => assignBuilding(b.id, null).then(buildingsChanged), `${b.name} 연결을 해제했습니다.`)}><Unlink size={18} aria-hidden />연결 해제</button>
                          : <button className="adm-danger adm-btn" type="button" disabled={busy} onClick={() => run('bld', () => deleteBuilding(b.id).then(buildingsChanged), `${b.name} 건물을 삭제했습니다.`)}><Trash2 size={18} aria-hidden />영구 삭제</button>}
                        <button className="secondary adm-btn" type="button" onClick={() => setAsk(null)}>취소</button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <a className="secondary adm-btn" href={`#/admin/${id}/buildings/new`}><Plus size={18} aria-hidden />건물 추가</a>
        <form className="adm-assign" onSubmit={(e) => { e.preventDefault(); if (picked) run('bld', () => assignBuilding(picked.id, id).then(() => { setPick(''); buildingsChanged() }), `${picked.name} 건물을 연결했습니다.`) }}>
          <label htmlFor="adm-pick">연결할 건물</label>
          <select id="adm-pick" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">건물 선택</option>
            {!!free.length && <optgroup label="연결 안 된 건물">{free.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</optgroup>}
            {!!taken.length && <optgroup label="다른 기업 건물">{taken.map((b) => <option key={b.id} value={b.id}>{b.name}, 현재 {b.companyName}</option>)}</optgroup>}
          </select>
          <button className="secondary adm-btn" type="submit" disabled={busy || !picked}><Link2 size={18} aria-hidden />건물 연결</button>
        </form>
        {picked?.companyId && <p className="adm-help">{picked.companyName}에서 이 기업으로 옮깁니다. {picked.companyName} 구성원은 이 건물을 볼 수 없게 됩니다.</p>}
        {say('bld')}
      </section>

      <Members base={co(id)} members={data.members} onChange={() => { load().catch((e) => setError(msg(e))) }} />
      <Audit base={co(id)} at={data} names={auditNames(data)} />

      <section className="card adm-card" aria-labelledby="adm-del">
        <h2 id="adm-del">기업 삭제</h2>
        {ask === 'del' ? (
          <div className="adm-ask fade-in">
            <p className="adm-help">{c.name} 기업을 삭제합니다. 삭제한 기업은 되돌릴 수 없습니다.</p>
            <div className="adm-btns">
              <button className="adm-danger adm-btn" type="button" disabled={busy} onClick={remove}><Trash2 size={18} aria-hidden />삭제</button>
              <button className="secondary adm-btn" type="button" onClick={() => setAsk(null)}>취소</button>
            </div>
          </div>
        ) : (
          <button className="secondary adm-btn adm-del" type="button" onClick={() => setAsk('del')}><Trash2 size={18} aria-hidden />기업 삭제</button>
        )}
        {say('del')}
      </section>
    </main>
  )
}
