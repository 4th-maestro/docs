import { planPdfPixels } from '../../twin/pipeline/plan-pdf.js'
export { pageSize, pdfBytes, deflateRgb } from '../../twin/pipeline/plan-pdf.js'

// 보정 이미지(Blob) → {pdf, scale(start options.scale), px: 원본 화소 크기}
export async function planPdf(image: Blob, pxPerM?: number) {
  const bm = await createImageBitmap(image)
  const { width: w, height: h } = bm
  const g = new OffscreenCanvas(w, h).getContext('2d')
  if (!g) throw new Error('도면 PDF를 만들 수 없습니다(캔버스 미지원).')
  g.drawImage(bm, 0, 0)
  bm.close()
  return planPdfPixels(g.getImageData(0, 0, w, h), pxPerM)
}
