import { TWIN_URL } from '../twin'
import type { Detection } from '../floor-edit'

// 트윈 파이프라인(pipeline.html iframe) ↔ 호스트 메시지. 목록과 필드: twin/README.md "호스트 연동 메시지"
// 출처는 VITE_TWIN_URL origin과 iframe 창으로 확인
const origin = () => new URL(TWIN_URL as string, location.href).origin

// 파이프라인 주소: 기호 인식 요청을 켬(detect=1, 이 값이 없으면 파이프라인은 인식을 요청하지 않음)
export function detectingSrc(src: string | null) {
  if (!src) return null
  const url = new URL(src)
  url.searchParams.set('detect', '1')
  return url.href
}

// 평면도 이미지(이미지 파일, PDF 렌더링 페이지)를 파이프라인 층별 입력에 넣음
export function sendPlans(frame: HTMLIFrameElement | null, files: File[]) {
  if (TWIN_URL) frame?.contentWindow?.postMessage({ source: 'maestro', type: 'plans', files }, origin())
}

// 파이프라인의 보정 이미지 인식 요청 → run 실행 → detectResult 응답(실패하면 빈 목록과 오류 문구)
export type DetectRequest = { floors: string[]; image: Blob; pxPerM?: number }
export function onDetectRequest(frame: () => HTMLIFrameElement | null, run: (req: DetectRequest) => Promise<{ detections: Detection[]; key?: string; px?: [number, number]; error?: string }>) {
  const listener = async (e: MessageEvent) => {
    const target = frame()?.contentWindow
    if (!TWIN_URL || !target || e.source !== target || e.origin !== origin() || e.data?.source !== 'twin' || e.data.type !== 'detectRequest') return
    const { id, floors, image, pxPerM } = e.data
    const reply = (body: object) => target.postMessage({ source: 'maestro', type: 'detectResult', id, ...body }, origin())
    if (!(image instanceof Blob) || !Array.isArray(floors)) return reply({ detections: [], error: '인식 요청 형식이 다릅니다.' })
    try {
      reply(await run({ floors: floors.map(String), image, pxPerM: Number(pxPerM) || undefined }))
    } catch (err) {
      reply({ detections: [], error: err instanceof Error ? err.message : String(err) })
    }
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
