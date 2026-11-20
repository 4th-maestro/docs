import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Circle, CircleAlert, CircleCheck, LoaderCircle, Upload } from 'lucide-react'
import BuildingEditor from '../BuildingEditor'
import type { Plan } from '../floor-edit'
import { onBuildingRendered, pipelineSrc } from '../twin'
import { ACCEPT, API_ON, convertFiles, detect, kindOf, pageFiles, saveTwin, type Convert, type Job, type Page } from './api'
import { detectingSrc, onDetectRequest, sendPlans } from './bridge'
import { applyDetections, asPlan, pendingDetections, reviewUnits } from './units'
import './ingest.css'

// 도면 업로드 → 2D 실내기 매핑 → 확정 저장(판매사 건물 화면에서 사용). 규약: docs/human/reference/plan-ingest.md
// - IFC, DXF, DWG: 서버 변환 초안(draftUrl)을 바로 편집, 렌더링한 도면(pages)은 층별 배경 이미지
// - PDF: 서버가 렌더링한 페이지를, PNG, JPG: 고른 파일을 트윈 파이프라인(iframe)에 넣어 호실을 만들고, 파이프라인 결과를 편집
// - 파이프라인은 보정 평면도마다 기호 인식을 요청(detectRequest) → 이 화면이 POST /plans/detect로 처리, 보정 이미지는 배경 이미지
// - 확정: onConfirm이 있으면 호출한 화면이 저장(판매사 건물 화면), 없으면 saveTwin(buildingId, twin, convert) 후 onDone(twin)
const STEPS = [['parse', '파일 해석'], ['detect', '실내기 인식'], ['merge', '병합']] as const
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function PlanIngest({ buildingId, onDone, onConfirm, convert }: { buildingId: string; onDone(twin: Plan): void; onConfirm?(twin: Plan): void; convert?: Convert }) {
  const [files, setFiles] = useState<File[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [plans, setPlans] = useState<File[] | null>(null)
  const [draft, setDraft] = useState<Plan | null>(null)
  const [src] = useState(() => detectingSrc(pipelineSrc()))
  const frame = useRef<HTMLIFrameElement>(null)
  const loaded = useRef(false)
  const saving = useRef(false)
  const abort = useRef<AbortController | null>(null)
  // 층 id → 배경 이미지 주소(서버 페이지 URL 또는 파이프라인 보정 이미지 blob URL), blobs는 화면을 닫을 때 해제
  const [backgrounds, setBackgrounds] = useState<Record<string, string>>({})
  const blobs = useRef<string[]>([])
  const kind = kindOf(files)

  function open(data: unknown, pages?: Page[]) {
    try {
      const plan = applyDetections(asPlan(data))
      if (pages) setBackgrounds(b => ({ ...b, ...Object.fromEntries(pages.map((p, i) => [p.floor ?? plan.floors[i]?.id, p.url]).filter(([f]) => f)) }))
      setDraft(plan)
      setError('')
    } catch (e) { setError(msg(e)) }
  }
  useEffect(() => onBuildingRendered(open), [])
  useEffect(() => onDetectRequest(() => frame.current, async ({ floors, image, pxPerM }) => {
    const url = URL.createObjectURL(image)
    blobs.current.push(url)
    setBackgrounds(b => ({ ...b, ...Object.fromEntries(floors.map(f => [f, url])) }))
    return API_ON ? detect(buildingId, image, pxPerM) : { detections: [], error: '인식 서버 미연결(VITE_API_BASE_URL 없음)' }
  }), [buildingId])
  useEffect(() => () => {
    abort.current?.abort()
    blobs.current.forEach(URL.revokeObjectURL)
  }, [])
  // 파이프라인이 열려 있으면 바로 전달, 아니면 iframe 로드 후 전달(onLoad)
  useEffect(() => { if (plans && loaded.current) sendPlans(frame.current, plans) }, [plans])

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const list = [...(e.target.files ?? [])]
    e.target.value = ''
    setFiles(list); setJob(null)
    setError(list.length && !kindOf(list) ? `지원하지 않는 파일이 있습니다. ${ACCEPT.join(', ').toUpperCase()} 파일만 고르십시오.` : '')
  }

  async function start() {
    if (!kind) return
    setError('')
    if (kind === 'image') { setPlans(files); return }
    if (!API_ON) { setError('IFC, CAD, PDF 변환은 서버 연결(VITE_API_BASE_URL)이 필요합니다. PNG, JPG 이미지는 서버 없이 처리합니다.'); return }
    setBusy(true)
    abort.current = new AbortController()
    try {
      const { job, draft } = await convertFiles(buildingId, files, setJob, abort.current.signal)
      if (kind !== 'pdf') { open(draft, job.pages); return }
      const pages = await pageFiles(job.pages ?? [])
      if (!pages.length) throw new Error('PDF에서 도면 페이지를 찾지 못했습니다.')
      setPlans(pages)
    } catch (e) {
      setError(msg(e))
    } finally {
      setBusy(false)
    }
  }

  async function confirm(plan: Plan) {
    if (saving.current) return
    const n = reviewUnits(plan).length, d = pendingDetections(plan)
    if ((n || d) && !window.confirm(`확인 필요 실내기 ${n}대${d ? `, 위치를 맞추지 않은 인식 결과 ${d}개` : ''}가 남아 있습니다. 이대로 저장할까요?`)) return
    if (onConfirm) { onConfirm(plan); return }
    saving.current = true
    setError('')
    try {
      await saveTwin(buildingId, plan, convert)
      onDone(plan)
    } catch (e) {
      setError(msg(e))
    } finally {
      saving.current = false
    }
  }

  const at = !job ? -1 : job.status === 'review' || job.status === 'done' ? STEPS.length : STEPS.findIndex(s => s[0] === job.step)
  const warnings = draft?.meta?.ingest?.warnings ?? []
  return (
    <div className="ingest">
      {error && <p className="error" role="alert">{error}</p>}
      {draft ? <>
        {warnings.length > 0 && <section className="banner" role="note" aria-label="변환 경고">
          <ul className="ingest-warn">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </section>}
        <BuildingEditor initial={draft} floor="" draft backgrounds={backgrounds} onSave={confirm} onCancel={() => setDraft(null)} />
      </> : (
        <section className="card ingest-up" aria-labelledby="ingest-title">
          <h2 id="ingest-title">도면 파일</h2>
          <div className="ingest-btns">
            <label className="ingest-pick"><Upload size={18} aria-hidden />파일 고르기
              <input className="ingest-file" type="file" multiple accept={ACCEPT.map(x => '.' + x).join(',')} disabled={busy} onChange={pick} />
            </label>
            <button className="primary" type="button" disabled={!kind || busy} onClick={start}>{kind === 'image' ? '평면도 넣기' : busy ? '변환 중' : '변환 시작'}</button>
          </div>
          <p className="small">IFC, DXF, DWG, PDF, PNG, JPG 파일을 여러 개 고를 수 있습니다. 파일당 200MB까지입니다. IFC와 함께 올릴 설비도면 이미지는 같이 고르십시오.</p>
          {files.length > 0 && <ul className="ingest-files" aria-label="고른 파일">
            {files.map(f => <li key={f.name}>{f.name} ({(f.size / 1048576).toFixed(1)} MB)</li>)}
          </ul>}
          {job && <ol className="ingest-steps" aria-label="변환 단계">
            {STEPS.map(([id, label], i) => {
              const failed = job.status === 'failed' && i === at
              const state = failed ? 'failed' : i < at ? 'done' : i === at ? 'on' : ''
              const Icon = failed ? CircleAlert : i < at ? CircleCheck : i === at ? LoaderCircle : Circle
              return <li key={id} className={state}><Icon size={18} aria-hidden />{label}{failed ? ' 실패' : i < at ? ' 완료' : i === at ? ' 중' : ' 대기'}</li>
            })}
          </ol>}
        </section>
      )}
      {plans && src && <iframe ref={frame} className="ingest-pipe" hidden={!!draft} src={src} title="트윈 파이프라인(평면도 이미지에서 호실 생성)"
        onLoad={() => { loaded.current = true; sendPlans(frame.current, plans) }} />}
      {plans && !src && <p className="error" role="alert">3D 트윈 주소(VITE_TWIN_URL)가 없어 평면도 이미지를 처리할 수 없습니다.</p>}
    </div>
  )
}
