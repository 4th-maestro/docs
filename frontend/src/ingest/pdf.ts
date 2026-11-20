// 보정 평면도 이미지 → 1쪽 PDF(서버 pdf 작업: 쪽 렌더링 → 실내기 기호 인식 모델)
// - 화소는 무손실(FlateDecode, RGB 8비트)로 넣어 JPEG 손실로 기호가 뭉개지지 않게 함
// - pxPerM을 알면 축척 1/scale 용지 크기로 만들고 start options.scale로 알림 → 서버가 1m를 80px(모델 학습 축척)로 렌더링
// - 모르면 200dpi 용지 크기로 만들어 서버 기본 렌더링(200dpi)이 원본 화소 그대로 나오게 함
const PT_PER_M = 72 / .0254
const DPI = 200
const MAX_PT = 14400 // PDF 쪽 한 변 최대 크기(200in)
const SCALES = [100, 200, 500, 1000] // 서버가 인정하는 표준 축척 분모 중 일부

// 이미지 w×h, 1m당 화소 → 쪽 크기(pt)와 축척 분모(없으면 200dpi)
export function pageSize(w: number, h: number, pxPerM?: number): { pt: [number, number]; scale?: number } {
  if (!pxPerM) return { pt: [w * 72 / DPI, h * 72 / DPI] }
  const k = (s: number) => PT_PER_M / (s * pxPerM) // 화소 1개의 용지 길이(pt)
  const scale = SCALES.find(s => Math.max(w, h) * k(s) <= MAX_PT) ?? SCALES[SCALES.length - 1]
  return { pt: [w * k(scale), h * k(scale)], scale }
}

const enc = new TextEncoder()
const num = (v: number) => String(Math.round(v * 1000) / 1000)

// 압축한 RGB 화소(zlib) → PDF 바이트. 객체: 1 카탈로그, 2 쪽 목록, 3 쪽, 4 내용, 5 이미지
export function pdfBytes(w: number, h: number, zrgb: Uint8Array, [pw, ph]: [number, number]): Uint8Array {
  const draw = `q ${num(pw)} 0 0 ${num(ph)} 0 0 cm /Im0 Do Q`
  const parts: Uint8Array[] = []
  const offsets: number[] = []
  let size = 0
  const push = (b: Uint8Array | string) => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); size += u.length }
  const obj = (body: string, stream?: Uint8Array) => {
    offsets.push(size)
    push(`${offsets.length} 0 obj\n${body}\n`)
    if (stream) { push('stream\n'); push(stream); push('\nendstream\n') }
    push('endobj\n')
  }
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  obj('<< /Type /Catalog /Pages 2 0 R >>')
  obj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`)
  obj(`<< /Length ${enc.encode(draw).length} >>`, enc.encode(draw))
  obj(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${zrgb.length} >>`, zrgb)
  const xref = size
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`)
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

// RGBA → RGB(투명 부분은 흰 배경에 합성) → zlib 압축
export async function deflateRgb(rgba: Uint8ClampedArray | Uint8Array): Promise<Uint8Array> {
  const rgb = new Uint8Array(rgba.length / 4 * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255, bg = 255 * (1 - a)
    rgb[j] = rgba[i] * a + bg; rgb[j + 1] = rgba[i + 1] * a + bg; rgb[j + 2] = rgba[i + 2] * a + bg
  }
  const stream = new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// 보정 이미지(Blob) → {pdf, scale(start options.scale), px: 원본 화소 크기}
export async function planPdf(image: Blob, pxPerM?: number) {
  const bm = await createImageBitmap(image)
  const { width: w, height: h } = bm
  const g = new OffscreenCanvas(w, h).getContext('2d')
  if (!g) throw new Error('도면 PDF를 만들 수 없습니다(캔버스 미지원).')
  g.drawImage(bm, 0, 0)
  bm.close()
  const { pt, scale } = pageSize(w, h, pxPerM)
  const bytes = pdfBytes(w, h, await deflateRgb(g.getImageData(0, 0, w, h).data), pt)
  return { pdf: new Blob([bytes as BlobPart], { type: 'application/pdf' }), scale, px: [w, h] as [number, number] }
}
