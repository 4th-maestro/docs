// 보정 이미지 → PDF 자가 점검: node src/ingest/pdf.check.mjs (Node 23.6 이상, TypeScript 형식 제거 실행)
// 범위: 쪽 크기와 축척, pdfjs로 다시 읽은 쪽 크기·이미지 크기·화소 값, 서버 렌더링 배율(1m = 80px) 환산
import assert from 'node:assert/strict'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { deflateRgb, pageSize, pdfBytes } from './pdf.ts'

// 1. 쪽 크기: 축척을 알면 1/100 용지(80px/m → 1px = 12.5mm 실물 = 0.125mm 용지), 모르면 200dpi
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`)
let s = pageSize(800, 400, 80)
assert.equal(s.scale, 100); near(s.pt[0], 800 * .125 / 25.4 * 72)
// 서버(ingest/pdf.py) 렌더링 배율 k = 80·s·25.4/72000 px/pt → 렌더링 폭이 1m=80px 기준 화소와 같아야 함
near(s.pt[0] * 80 * s.scale * 25.4 / 72000, 800)
s = pageSize(800, 400, 40); near(s.pt[0] * 80 * s.scale * 25.4 / 72000, 1600) // 40px/m 이미지는 2배로 렌더링
assert.equal(pageSize(50000, 10, 80).scale, 200) // 1/100이면 한 변이 200in를 넘음 → 1/200
s = pageSize(1000, 500); assert.equal(s.scale, undefined); near(s.pt[0] * 200 / 72, 1000)

// 2. PDF를 pdfjs로 다시 읽기: 쪽 크기, 이미지 크기, 화소(투명 → 흰색)
const w = 30, h = 20, rgba = new Uint8ClampedArray(w * h * 4)
for (let i = 0; i < w * h; i++) rgba.set(i % 2 ? [255, 0, 0, 255] : [0, 0, 0, 0], i * 4)
const pt = pageSize(w, h, 80).pt
const doc = await getDocument({ data: pdfBytes(w, h, await deflateRgb(rgba), pt), isEvalSupported: false }).promise
assert.equal(doc.numPages, 1)
const page = await doc.getPage(1), vp = page.getViewport({ scale: 1 })
near(vp.width, pt[0], 1e-3); near(vp.height, pt[1], 1e-3)
const ops = await page.getOperatorList(), at = ops.fnArray.indexOf(OPS.paintImageXObject)
assert.ok(at >= 0, '이미지 그리기 명령 없음')
const img = await new Promise(r => page.objs.get(ops.argsArray[at][0], r))
assert.equal(img.width, w); assert.equal(img.height, h)
const px = img.data, bpp = px.length / (w * h)
assert.deepEqual([...px.slice(0, 3)], [255, 255, 255]) // 투명 → 흰 배경
assert.deepEqual([...px.slice(bpp, bpp + 3)], [255, 0, 0])
console.log('pdf.check: 통과')
