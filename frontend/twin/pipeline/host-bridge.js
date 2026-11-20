// 파이프라인 ↔ 호스트 앱(대시보드) 메시지. 목록과 필드: twin/README.md "호스트 연동 메시지"
// 부모 창의 메시지만 받고, 보낼 때는 부모 창 origin(document.referrer)을 지정
const parentOrigin = () => document.referrer ? new URL(document.referrer).origin : location.origin;
const fromHost = (e, type) => e.source === window.parent && e.data?.source === 'maestro' && e.data.type === type;
let seq = 0;

// 기호 인식용 보정 해상도(px/m): 인식 모델 학습 해상도 80px/m, 원본 사진의 실제 해상도(외곽 4변 중 최대)보다 크게 하지 않음,
// 여백 포함 긴 변 8000px 이하. 0.1 단위 내림
export const DETECT_PX_PER_M = 80, DETECT_MAX_PX = 8000;
export function detectRes(corners, W, D, margin){
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]), [nw, ne, se, sw] = corners;
  const source = Math.max(len(nw, ne) / W, len(sw, se) / W, len(nw, sw) / D, len(ne, se) / D);
  return Math.floor(Math.min(DETECT_PX_PER_M, source, DETECT_MAX_PX / (Math.max(W, D) + 2 * margin)) * 10) / 10;
}

// 호스트가 넣는 평면도 이미지: {source:'maestro', type:'plans', files:[File]}
export function onPlans(handler) {
  addEventListener('message', e => { if (fromHost(e, 'plans') && Array.isArray(e.data.files)) handler(e.data.files.filter(f => f instanceof File)); });
}

// 보정 평면도(ImageData 형식 {width, height, data}) 인식 요청 → {detections, key?, px?, error?}
// px: 호스트가 PDF로 바꿔 서버가 다시 렌더링한 쪽 크기(detections, key는 이 쪽 화소 기준), 없으면 보낸 이미지 크기
// 호스트가 detect=1로 연 경우에만 호출. 응답이 없으면 11분 뒤 빈 결과로 진행(호스트 작업 조회 한도 10분보다 길게)
export async function askDetect(floors, rect, pxPerM, timeoutMs = 11 * 60 * 1000) {
  const c = document.createElement('canvas');
  c.width = rect.width; c.height = rect.height;
  c.getContext('2d').putImageData(new ImageData(rect.data instanceof Uint8ClampedArray ? rect.data : new Uint8ClampedArray(rect.data), rect.width, rect.height), 0, 0);
  const image = await new Promise(r => c.toBlob(r, 'image/png'));
  const id = 'detect-' + (++seq);
  return new Promise(resolve => {
    const done = v => { removeEventListener('message', on); clearTimeout(timer); resolve(v); };
    const on = e => { if (fromHost(e, 'detectResult') && e.data.id === id) done(e.data); };
    const timer = setTimeout(() => done({ detections:[], error:'호스트 응답 시간 초과' }), timeoutMs);
    addEventListener('message', on);
    window.parent.postMessage({ source:'twin', type:'detectRequest', id, floors, image, pxPerM }, parentOrigin());
  });
}
