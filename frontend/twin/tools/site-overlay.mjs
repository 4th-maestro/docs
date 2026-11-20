// 스카이뷰 위에 도면(층 윤곽·실 다각형·기준점)을 겹쳐 그려 맞춤을 눈으로 확인
//   node tools/site-overlay.mjs <레시피> <building.json> [출력.png=sim/site-overlay.png]
//   노란 선: 층 윤곽 · 빨간 선: 사진에서 딴 지붕 윤곽 · 하늘색: 실 · 빨간 점: 사람이 찍은 기준점 · 초록 점: 맞춤 결과가 그 점을 보낸 위치
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encodePng } from './image-io.mjs';
import { siteFit, warpPoint } from '../pipeline/pipeline-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [rp, bp, op = 'sim/site-overlay.png'] = process.argv.slice(2);
const recipe = JSON.parse(fs.readFileSync(path.resolve(root, rp), 'utf8')), B = JSON.parse(fs.readFileSync(path.resolve(root, bp), 'utf8'));
const img = decode(path.resolve(root, recipe.base || '', recipe.site.image));
// building.json에 이미 맞춘 결과(site)가 있으면 그대로 씀 — 모양 보정된 도면과 같은 좌표계
const W = B.building.size.w, D = B.building.size.d;
const fit = B.site?.toImage ? B.site : (() => { const fps = B.floors.map(f => f.footprint?.length ? f.footprint : [[0, 0], [W, 0], [W, D], [0, D]]);
  const at = B.atrium && B.floors.some(f => f.atrium) ? [[[B.atrium.x0, B.atrium.y0], [B.atrium.x1, B.atrium.y0], [B.atrium.x1, B.atrium.y1], [B.atrium.x0, B.atrium.y1]]] : [];
  return siteFit({ ...recipe.site, size:[img.width, img.height] }, W, D, fps, at); })();
const T = fit.toImage, to = ([x, y]) => [T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5]];
const put = (x, y, c, r = 1) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = Math.round(x + dx), Y = Math.round(y + dy);
  if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue; const o = (Y * img.width + X) * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; } };
const line = (a, b, c, r) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])); for (let i = 0; i <= n; i++) put(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, c, r); };
const poly = (p, c, r) => p.forEach((q, i) => line(to(q), to(p[(i + 1) % p.length]), c, r));
for (const f of B.floors) for (const rm of f.rooms) if (rm.type === 'room') poly(rm.polygon, [80, 200, 255], 0);
for (const f of B.floors) poly(f.footprint?.length ? f.footprint : [[0, 0], [B.building.size.w, 0], [B.building.size.w, B.building.size.d], [0, B.building.size.d]], [255, 220, 0], 1);
if (B.atrium) { const a = B.atrium; poly([[a.x0, a.y0], [a.x1, a.y0], [a.x1, a.y1], [a.x0, a.y1]], [255, 120, 0], 1); }
// 빨간 선: 스카이뷰에서 딴 지붕 윤곽(모양 검증 기준)
const pxPoly = (p, c, r) => p.forEach((q, i) => line(q, p[(i + 1) % p.length], c, r));
for (const p of [recipe.site.outline || [], ...(recipe.site.holes || [])]) if (p.length) pxPoly(p, [255, 50, 50], 1);
for (const r of recipe.site.ref) { put(r.px[0], r.px[1], [255, 40, 40], 4); const q = to(warpPoint(fit.warp, r.m)); put(q[0], q[1], [40, 255, 90], 3); }
// 북쪽 화살표 (도면 위쪽)
const c0 = to([B.building.size.w / 2, B.building.size.d / 2]), c1 = to([B.building.size.w / 2, B.building.size.d / 2 - 12]); line(c0, c1, [255, 0, 255], 1);
fs.mkdirSync(path.dirname(path.resolve(root, op)), { recursive:true });
fs.writeFileSync(path.resolve(root, op), encodePng(img));
const chk = { ...fit.check }; delete chk.photoOutlineM; delete chk.photoHolesM;   // 로그엔 윤곽 좌표 빼고
console.log(JSON.stringify({ northDeg:fit.northDeg, residualM:fit.residualM, pxPerM:fit.pxPerM, check:chk, ...(fit.checkBefore ? { before:fit.checkBefore } : {}) }));
