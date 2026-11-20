import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, FileBox, ImageIcon, Info } from 'lucide-react'
import { buildingsChanged, createBuilding, getCompany, getTwin, putTwin, type BuildingInput, type CompanyDetail } from '../api'
import BuildingEditor from '../BuildingEditor'
import PlanIngest from '../ingest/PlanIngest'
import type { Plan } from '../floor-edit'
import type { AdminSub } from '../shell/route'
import { SkRows, SkWrap } from '../skeleton/Skeleton'
import { editablePlan, onBuildingRendered, pipelineSrc, postTheme } from '../twin'
import { newBuildingId, toServer, twinDefaults, type Twin } from './convert'
import { msg } from './form'
import { BuildingForm, type BuildingInfo } from './parts'

// 판매사 건물 화면(관리자 전용, #/admin/<기업 id>/buildings/...)
// - new: 건물 추가 방법 선택 → image: 도면 이미지 파이프라인, file: 도면 파일 변환과 실내기 매핑(PlanIngest) → 건물 정보 확인 → POST
// - replace: 도면 교체 방법 선택 → image: 파이프라인 → 교체 확인 → PUT /buildings/{id}/twin
// - plan: 서버 트윈 도면 편집(BuildingEditor) → PUT /buildings/{id}/twin
const NO_TWIN = '트윈 도면이 없는 건물입니다. 도면 교체로 도면을 먼저 넣으십시오.'
const NO_ROOMS = '실내기가 연결된 호실이 없어 저장할 수 없습니다. 도면을 보정한 뒤 다시 만드십시오.'

export default function BuildingPage({ company, sub }: { company: string; sub: AdminSub }) {
  const back = `#/admin/${company}`
  // 제목용 건물 이름: 기업 상세의 건물 목록
  const [detail, setDetail] = useState<CompanyDetail | null>(null)
  useEffect(() => { if (sub.building) getCompany(company).then(setDetail, () => undefined) }, [company, sub.building])
  const name = detail?.buildings.find((b) => b.id === sub.building)?.name ?? sub.building ?? ''
  const title = sub.kind === 'new' ? '건물 추가' : `${name} ${sub.kind === 'plan' ? '도면 편집' : '도면 교체'}`
  const base = sub.kind === 'new' ? `${back}/buildings/new` : `${back}/buildings/${sub.building}/replace`

  if (sub.kind === 'plan') return <EditPlan back={back} title={title} building={sub.building!} />
  return (
    <main className={sub.image || sub.file ? 'adm adm-wide' : 'adm'}>
      {sub.image || sub.file
        ? <a className="adm-back" href={base}><ArrowLeft size={18} aria-hidden />만들기 방법 선택</a>
        : <a className="adm-back" href={back}><ArrowLeft size={18} aria-hidden />기업 상세</a>}
      <h1>{title}</h1>
      {sub.image || sub.file ? <ImageStep company={company} building={sub.building} name={name} back={back} file={sub.file} /> : <Methods base={base} />}
    </main>
  )
}

// 만들기 방법: 도면 이미지(트윈 파이프라인), 도면 파일(IFC, DXF, DWG, PDF 변환과 실내기 자동 인식)
function Methods({ base }: { base: string }) {
  return (
    <section className="card adm-card" aria-labelledby="bld-how">
      <h2 id="bld-how">만들기 방법</h2>
      <div className="adm-methods">
        <a className="adm-method" href={`${base}/image`}>
          <ImageIcon size={28} aria-hidden />
          <b>도면 이미지</b>
          <small>PNG, JPG 평면도 이미지로 3D 트윈을 만듭니다.</small>
        </a>
        <a className="adm-method" href={`${base}/file`}>
          <FileBox size={28} aria-hidden />
          <b>도면 파일</b>
          <small>IFC, DXF, DWG, PDF 도면을 변환하고 실내기를 자동 인식합니다.</small>
        </a>
      </div>
    </section>
  )
}

// 도면 이미지 → 3D 트윈 파이프라인(트윈 pipeline.html iframe), '트윈에서 렌더링' 결과 building.json 전달
// - 주소는 첫 렌더링 값 유지: 테마 전환은 메시지로 전달(주소가 바뀌면 작업 중인 도면이 사라짐)
// - hidden: 확인 단계에서 숨김, 작업 상태는 유지(도면 다시 만들기)
export function TwinPipeline({ hidden, onRendered }: { hidden?: boolean; onRendered: (b: unknown) => void }) {
  const [src] = useState(pipelineSrc)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => onBuildingRendered(onRendered), [onRendered])
  if (!src) return <p className="error adm-error" role="alert">3D 트윈 주소(VITE_TWIN_URL)가 없어 도면을 넣을 수 없습니다.</p>
  return (
    <>
      {!hidden && (
        <div className="banner" role="note">
          <Info size={16} aria-hidden />
          <span>층별 평면도 이미지를 넣고 <b>3D 트윈 만들기</b>를 누르십시오. 결과를 받으면 확인 단계로 넘어갑니다.</span>
        </div>
      )}
      <iframe ref={frame} className="adm-pipe" hidden={hidden} src={src} title="트윈 파이프라인(도면 이미지에서 3D 트윈 생성)" onLoad={() => postTheme(frame.current)} />
    </>
  )
}

// 도면 단계: 파이프라인 결과 또는 도면 파일 확정본 수신 → 확인(추가: 건물 정보 입력, 교체: 교체 확인) → 저장 후 기업 상세로 이동
// - 도면 파일 변환 작업은 건물 id 형식이 필요해 추가 화면에서는 임시 id를 사용(저장할 때 새 id 생성)
function ImageStep({ company, building, name, back, file }: { company: string; building?: string; name: string; back: string; file?: boolean }) {
  const [jobId] = useState(() => building ?? newBuildingId())
  const [twin, setTwin] = useState<Twin | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const rendered = useCallback((b: unknown) => {
    try { setTwin(editablePlan(b) as Twin); setError('') } catch (e) { setError(msg(e)) }
  }, [])

  function done() {
    buildingsChanged()
    location.hash = back
  }
  // 건물 추가: 건물 id는 저장할 때마다 새로 생성(서버 409 중복이면 다시 누르면 새 id)
  async function create(body: BuildingInput) {
    const id = newBuildingId()
    const data = toServer(twin!, id)
    if (!data.rooms.length) throw new Error(NO_ROOMS)
    await createBuilding(company, { id, ...(body as BuildingInfo), ...data })
    done()
  }
  async function replace() {
    setBusy(true); setError('')
    try {
      const data = toServer(twin!, building!)
      if (!data.rooms.length) throw new Error(NO_ROOMS)
      await putTwin(building!, data)
      done()
    } catch (e) {
      setError(msg(e))
      setBusy(false)
    }
  }

  const info = twin && twinDefaults(twin)
  return (
    <>
      {error && <p key={error} className="error adm-error fade-in" role="alert">{error}</p>}
      {twin && info && (
        <section className="card adm-card fade-in" aria-labelledby="bld-ok">
          <h2 id="bld-ok">{building ? '도면 교체 확인' : '건물 정보 확인'}</h2>
          <p className="adm-help">도면에서 층 {twin.floors.length}개, 실내기가 연결된 호실 {info.roomCount}개를 인식했습니다.</p>
          {building ? (
            <>
              <p className="adm-help">저장하면 {name} 건물의 현재 도면과 호실 목록을 이 도면으로 바꿉니다.</p>
              <div className="adm-btns">
                <button className="adm-dark adm-btn" type="button" disabled={busy || !info.roomCount} onClick={replace}>도면 교체</button>
                <button className="secondary adm-btn" type="button" onClick={() => setTwin(null)}>도면 다시 만들기</button>
              </div>
            </>
          ) : (
            <BuildingForm init={info} label="건물 정보 확인" ok="건물 추가" cancel="도면 다시 만들기" submit={create} onCancel={() => setTwin(null)} />
          )}
          {!info.roomCount && <p className="adm-warn" role="alert">{NO_ROOMS}</p>}
        </section>
      )}
      {file
        ? <div hidden={!!twin}><PlanIngest buildingId={jobId} onDone={() => undefined} onConfirm={(p) => { setTwin(p as Twin); setError('') }} /></div>
        : <TwinPipeline hidden={!!twin} onRendered={rendered} />}
    </>
  )
}

// 도면 편집: 서버 트윈(GET /buildings/{id}/twin, 없으면 404 안내) → BuildingEditor → 변환 → PUT /buildings/{id}/twin
function EditPlan({ back, title, building }: { back: string; title: string; building: string }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState(false)
  const saving = useRef(false)

  useEffect(() => {
    getTwin(building).then((d) => setPlan(editablePlan(d))).catch((e) => {
      if ((e as { status?: number }).status === 404) setMissing(true)
      else setError(msg(e))
    })
  }, [building])

  async function save(next: Plan) {
    if (saving.current) return
    saving.current = true; setError('')
    try {
      const data = toServer(next as Twin, building)
      if (!data.rooms.length) throw new Error(NO_ROOMS)
      await putTwin(building, data)
      buildingsChanged()
      location.hash = back
    } catch (e) {
      setError(msg(e))
    } finally {
      saving.current = false
    }
  }

  return (
    <main className="adm adm-wide">
      <a className="adm-back" href={back}><ArrowLeft size={18} aria-hidden />기업 상세</a>
      <h1>{title}</h1>
      {error && <p key={error} className="error adm-error fade-in" role="alert">{error}</p>}
      {missing && (
        <section className="card adm-card">
          <p className="adm-warn" role="alert">{NO_TWIN}</p>
          <a className="secondary adm-btn" href={`${back}/buildings/${building}/replace`}>도면 교체</a>
        </section>
      )}
      {!plan && !missing && !error && <SkWrap label="도면을 불러오는 중입니다"><SkRows rows={4} /></SkWrap>}
      {plan && <BuildingEditor initial={plan} floor="" onSave={save} onCancel={() => { location.hash = back }} />}
    </main>
  )
}
