import { call } from '../api'
import type { Detection, Plan } from '../floor-edit'

// 도면 변환 API 클라이언트(판매사 관리자 전용): docs/human/reference/plan-ingest.md 4절
// - 파일은 사전 서명 URL로 S3에 직접 PUT(API Gateway 요청 한도 10MB 회피)
// - 상태는 3초마다 조회, review(초안 완료), done이면 종료, failed면 서버 오류 문구로 예외
export const API_ON = Boolean(import.meta.env.VITE_API_BASE_URL)
export type Kind = 'ifc' | 'cad' | 'pdf' | 'image'
export type Step = 'parse' | 'render' | 'detect' | 'merge'
export type Page = { floor?: string; url: string; px: [number, number] }
export type Job = { jobId: string; building: string; kind: Kind; status: 'created' | 'running' | 'review' | 'failed' | 'done'; step?: Step; error?: string; draftUrl?: string; pages?: Page[] }
export const ACCEPT = ['ifc', 'dxf', 'dwg', 'pdf', 'png', 'jpg', 'jpeg']
const LIMIT = 200 * 1024 * 1024
const POLL_MS = 3000
const POLL_LIMIT_MS = 10 * 60 * 1000
const post = (body: object): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
const ext = (f: File) => f.name.toLowerCase().split('.').pop() ?? ''

// 작업 종류: IFC가 있으면 ifc(함께 올린 설비도면 이미지, PDF는 같은 작업), CAD, PDF, 이미지만 있으면 image. 지원하지 않는 파일이 있으면 null
export function kindOf(files: File[]): Kind | null {
  const exts = files.map(ext)
  if (!exts.length || exts.some(e => !ACCEPT.includes(e))) return null
  return exts.includes('ifc') ? 'ifc' : exts.some(e => e === 'dxf' || e === 'dwg') ? 'cad' : exts.includes('pdf') ? 'pdf' : 'image'
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`변환 결과를 받지 못했습니다(${r.status}).`)
  return r.json() as Promise<T>
}

// 작업 생성과 업로드: POST /plans/jobs → 파일별 PUT
async function upload(building: string, kind: Kind, files: File[]) {
  const big = files.find(f => f.size > LIMIT)
  if (big) throw new Error(`${big.name}: 파일당 200MB까지 올릴 수 있습니다.`)
  const job = await call<{ jobId: string; uploads: { name: string; key: string; url: string }[] }>('/plans/jobs', post({ building, kind, files: files.map(f => ({ name: f.name, size: f.size })) }))
  await Promise.all(job.uploads.map(async u => {
    const file = files.find(f => f.name === u.name)
    if (!file) throw new Error(`${u.name}: 업로드할 파일이 없습니다.`)
    const r = await fetch(u.url, { method: 'PUT', body: file })
    if (!r.ok) throw new Error(`${u.name}: 업로드하지 못했습니다(${r.status}).`)
  }))
  return job
}

async function poll(jobId: string, onJob?: (job: Job) => void, signal?: AbortSignal): Promise<Job> {
  const until = Date.now() + POLL_LIMIT_MS
  for (;;) {
    if (signal?.aborted) throw new Error('변환 확인을 중단했습니다.')
    const job = await call<Job>(`/plans/jobs/${encodeURIComponent(jobId)}`)
    onJob?.(job)
    if (job.status === 'failed') throw new Error(job.error || '도면 변환에 실패했습니다.')
    if (job.status === 'review' || job.status === 'done') return job
    if (Date.now() > until) throw new Error('도면 변환이 10분 안에 끝나지 않았습니다. 잠시 후 다시 시도하십시오.')
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

// 파일 변환: 업로드 → 시작 → 상태 조회 → 초안(draftUrl). PDF는 초안 대신 렌더링한 페이지(pages)를 사용
export async function convertFiles(building: string, files: File[], onJob: (job: Job) => void, signal?: AbortSignal) {
  const kind = kindOf(files)
  if (!kind) throw new Error(`지원하지 않는 파일이 있습니다. ${ACCEPT.join(', ').toUpperCase()} 파일을 고르십시오.`)
  const { jobId } = await upload(building, kind, files)
  await call(`/plans/jobs/${encodeURIComponent(jobId)}/start`, post({}))
  const job = await poll(jobId, onJob, signal)
  const draft = kind !== 'pdf' && job.draftUrl ? await getJson<unknown>(job.draftUrl) : null
  return { job, draft }
}

// 렌더링한 PDF 페이지 → 트윈 파이프라인에 넣을 이미지 파일
export const pageFiles = (pages: Page[]) => Promise.all(pages.map(async (p, i) => {
  const r = await fetch(p.url)
  if (!r.ok) throw new Error(`도면 페이지 ${i + 1}을 받지 못했습니다(${r.status}).`)
  return new File([await r.blob()], `${p.floor ?? `page-${i + 1}`}.png`, { type: 'image/png' })
}))

// 실내기 기호 인식: 보정 이미지 업로드(kind image) → POST /plans/detect → 상태 조회 → draftUrl의 {floor, detections, model}
export async function detect(building: string, image: Blob, pxPerM?: number): Promise<{ detections: Detection[]; key: string }> {
  const file = new File([image], 'plan.png', { type: 'image/png' })
  const { uploads } = await upload(building, 'image', [file])
  const key = uploads[0].key
  const { jobId } = await call<{ jobId: string }>('/plans/detect', post({ building, key, pxPerM }))
  const job = await poll(jobId)
  const out = job.draftUrl ? await getJson<{ detections?: Detection[] }>(job.draftUrl) : {}
  return { detections: out.detections ?? [], key }
}

// 확정 저장 어댑터: convert(호출 쪽이 넘기는 판매사 화면 변환 함수, src/admin/convert.ts의 toServer)가 있으면
// PUT /buildings/{id}/twin {twin, rooms, plan}. 변환 함수가 twin을 반환하면(호실 id 접두어 적용본) 그 값을 저장
// 변환 함수가 없으면 데모 저장: 이 브라우저 localStorage(기존 '건물 추가' 저장 키와 같음, 서버 미반영)
export type Convert = (twin: Plan) => { twin?: unknown; rooms: unknown[]; plan: unknown }
export async function saveTwin(buildingId: string, twin: Plan, convert?: Convert): Promise<{ version?: number; local?: boolean }> {
  if (convert) {
    const out = convert(twin)
    return call<{ version: number }>(`/buildings/${encodeURIComponent(buildingId)}/twin`, { method: 'PUT', body: JSON.stringify({ twin: out.twin ?? twin, rooms: out.rooms, plan: out.plan }) })
  }
  try { localStorage.setItem(`maestro:custom-building:${buildingId}`, JSON.stringify(twin)) } catch { throw new Error('도면을 저장하지 못했습니다(브라우저 저장 공간 부족).') }
  return { local: true }
}
