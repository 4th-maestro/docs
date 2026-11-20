/* ═══════════════════════════════════════════════════════════════════════════
   자료 → building.json 파이프라인 (코어)
   입력:  평면도 이미지 + 사람이 남긴 레시피(모서리 4점, 라벨 점, 보정 조작, 사진에서 센 실내기 수, 사진에서 뽑은 색)
   출력:  twin.building/v1 (트윈 화면이 그대로 읽는 형식)
   같은 이미지 + 같은 레시피 → 항상 같은 결과 (난수 없음, 순서 고정)
   ═══════════════════════════════════════════════════════════════════════════ */

import { traceFloorRegions } from './site-roof.js';

export const RES = 20;            // 보정된 도면 해상도 (px / m)
export const MARGIN = 6;          // 건물 바깥 여유 (m) — 외부 계단 등
const r2 = v => Math.round(v * 20) / 20;           // 0.05 m 단위
const r1 = v => Math.round(v * 10) / 10;

/* ── 1. 원근 보정: 사진 속 건물 외곽 4점 → 실제 좌표(m) ─────────────────── */
// 8개 미지수 연립방정식으로 dst(m) → src(px) 호모그래피를 구한다
// 층 윤곽 면적(m²): 고리 하나 또는 여러 개
const footArea = fp => (Array.isArray(fp[0][0]) ? fp : [fp]).reduce((t, l) => t + Math.abs(l.reduce((s, [x, y], i) => { const [u, v] = l[(i + 1) % l.length]; return s + x * v - y * u; }, 0)) / 2, 0);
export function homography(dst, src){
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return (x, y) => { const w = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
}

// corners: 사진 픽셀 좌표 [북서, 북동, 남동, 남서] (건물 좌표 (0,0) (W,0) (W,D) (0,D))
export function isDarkPlan({ width, height, data }) {
  let background = 0, marks = 0;
  for (let row = 0; row < 32; row++) for (let col = 0; col < 32; col++) {
    const p = 4 * (Math.floor((row + .5) * height / 32) * width + Math.floor((col + .5) * width / 32));
    const mean = (data[p] + data[p+1] + data[p+2]) / 3;
    if (data[p+3] < 240) continue;
    if (mean < 82 && Math.max(data[p],data[p+1],data[p+2]) - Math.min(data[p],data[p+1],data[p+2]) < 28) background++;
    if (mean > 130) marks++;
  }
  return background > 690 && marks >= 3;
}

// res: 출력 해상도(px/m). 화면·벽 검출은 RES, 실내기 기호 인식은 host-bridge.js detectRes 값
// invert: 검은 바탕 도면(흰 선)을 흰 바탕으로 뒤집음. 예전 호출처럼 다섯째 인자로 true/false만 넘겨도 됨
export function rectify(img, corners, W, D, res = RES, invert = false){
  if (typeof res !== 'number') { invert = !!res; res = RES; }
  const map = homography([[0, 0], [W, 0], [W, D], [0, D]], corners);
  const w = Math.round((W + 2 * MARGIN) * res), h = Math.round((D + 2 * MARGIN) * res);
  const out = new Uint8ClampedArray(w * h * 4), { width:iw, height:ih, data } = img;
  const black = invert ? [0,1,2].map(c => {
    const samples = [];
    for (let row = 0; row < 24; row++) for (let col = 0; col < 24; col++) {
      samples.push(data[4 * (Math.floor((row+.5)*ih/24)*iw + Math.floor((col+.5)*iw/24)) + c]);
    }
    return Math.min(100, samples.sort((a,b)=>a-b)[samples.length >> 1] + 4);
  }) : null;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const [u, v] = map((i + .5) / res - MARGIN, (j + .5) / res - MARGIN), o = (j * w + i) * 4;
    if (u < 0 || v < 0 || u > iw - 1 || v > ih - 1) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255; continue; }
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0, x1 = Math.min(x0 + 1, iw - 1), y1 = Math.min(y0 + 1, ih - 1);
    for (let c = 0; c < 3; c++) {
      const a = data[(y0 * iw + x0) * 4 + c], bb = data[(y0 * iw + x1) * 4 + c], cc = data[(y1 * iw + x0) * 4 + c], d = data[(y1 * iw + x1) * 4 + c];
      const value = (a * (1 - fx) + bb * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
      out[o + c] = black ? 255 - Math.max(0,value-black[c]) * 255 / (255-black[c]) : value;
    }
    out[o + 3] = 255;
  }
  return { width:w, height:h, data:out };
}

const toPx = (x, y) => [Math.round((x + MARGIN) * RES), Math.round((y + MARGIN) * RES)];
export const toM = (i, j) => [(i + .5) / RES - MARGIN, (j + .5) / RES - MARGIN];

/* ── 2. 벽 검출: 주변보다 어둡고 채도가 낮은 선 (빨간 화살표·초록 비상구·소화기 아이콘은 제외) ── */
export function wallMask(rect, W, D, { dark = 40, sat = 70, close = 1 } = {}, wallOps = [], footprint = null){
  const { width:w, height:h, data } = rect, n = w * h;
  const L = new Float32Array(n), S = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    L[p] = .299 * r + .587 * g + .114 * b; S[p] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  // 배경 밝기: 큰 상자 평균(적분 영상)
  const I = new Float64Array((w + 1) * (h + 1));
  for (let j = 0; j < h; j++) { let s = 0; for (let i = 0; i < w; i++) { s += L[j * w + i]; I[(j + 1) * (w + 1) + i + 1] = I[j * (w + 1) + i + 1] + s; } }
  const R = 12, bg = (i, j) => { const x0 = Math.max(0, i - R), y0 = Math.max(0, j - R), x1 = Math.min(w, i + R + 1), y1 = Math.min(h, j + R + 1);
    return (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0)); };
  let m = new Uint8Array(n);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const p = j * w + i; if (bg(i, j) - L[p] > dark && S[p] < sat) m[p] = 1; }
  for (let k = 0; k < close; k++) m = dilate(m, w, h);
  // 건물 외곽선은 항상 벽
  const line = (x0, y0, x1, y1, t = 1) => { const [a, b] = toPx(x0, y0), [c, d] = toPx(x1, y1), steps = Math.max(Math.abs(c - a), Math.abs(d - b), 1);
    for (let s = 0; s <= steps; s++) { const x = Math.round(a + (c - a) * s / steps), y = Math.round(b + (d - b) * s / steps);
      for (let dy = -t; dy <= t; dy++) for (let dx = -t; dx <= t; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) m[yy * w + xx] = 1; } } };
  if (footprint !== false) {
    const loops = footprint ? (Array.isArray(footprint[0][0]) ? footprint : [footprint]) : [[[0, 0], [W, 0], [W, D], [0, D]]];
    for (const loop of loops) loop.forEach(([x, y], i) => line(x, y, ...loop[(i + 1) % loop.length]));
  }
  for (const o of wallOps) line(o.x0, o.y0, o.x1, o.y1);     // 사람이 그은 보정 벽
  return m;
}
export function eraseWalls(m, w, h, ops){
  for (const o of ops) { const [a, b] = toPx(Math.min(o.x0, o.x1), Math.min(o.y0, o.y1)), [c, d] = toPx(Math.max(o.x0, o.x1), Math.max(o.y0, o.y1));
    for (let y = Math.max(0, b); y <= Math.min(h - 1, d); y++) for (let x = Math.max(0, a); x <= Math.min(w - 1, c); x++) m[y * w + x] = 0; }
}
function dilate(m, w, h){
  const o = new Uint8Array(m.length);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!m[j * w + i]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = i + dx, y = j + dy; if (x >= 0 && y >= 0 && x < w && y < h) o[y * w + x] = 1; }
  }
  return o;
}

/* ── 2b. 색 채움 검출 (안내도·사인물: 상점이 색으로 칠해지고 선이 없는 도면) ──
   칠한 색의 '색 기운'(밝기를 뺀 RGB) 방향으로 얼마나 기울었는지로 판정 → 조명·반사로 밝기가 달라도 같은 색으로 본다.
   반환: 클래스 배열 0=벽(없음) 1=트인 공간(복도·대합실) 2=칠한 공간(상점·실) 3=건물 밖 */
export function fillClasses(rect, W, D, { fill = '#8389b0', strength = .5 } = {}, outsideM = null){
  const { width:w, height:h, data } = rect, n = w * h, cls = new Uint8Array(n);
  const hx = parseInt(fill.slice(1), 16), fr = hx >> 16 & 255, fg = hx >> 8 & 255, fb = hx & 255, fl = (fr + fg + fb) / 3;
  const dir = [fr - fl, fg - fl, fb - fl], mag = Math.hypot(...dir) || 1, thr = mag * strength;
  for (let p = 0; p < n; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2], l = (r + g + b) / 3;
    cls[p] = ((r - l) * dir[0] + (g - l) * dir[1] + (b - l) * dir[2]) / mag >= thr ? 2 : 1;
  }
  if (outsideM) for (let p = 0; p < n; p++) if (outsideM[p]) cls[p] = 3;
  return cls;
}
// 건물 윤곽(다각형, m) 밖 = 1 인 배열. 윤곽이 없으면 W×D 사각형
export function outsideMask(W, D, footprint){
  const w = Math.round((W + 2 * MARGIN) * RES), h = Math.round((D + 2 * MARGIN) * RES), m = new Uint8Array(w * h);
  // 윤곽 여러 개(떨어진 동)면 모두의 경계 교차를 모아 짝홀 규칙으로 — 겹치지 않는 고리들의 합집합
  const polys = !footprint?.length ? [[[0, 0], [W, 0], [W, D], [0, D]]] : Array.isArray(footprint[0]?.[0]) ? footprint.filter(l => l?.length >= 3) : [footprint];
  for (let j = 0; j < h; j++) { const y = (j + .5) / RES - MARGIN, xs = [];
    for (const poly of polys) for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) { const [x0, y0] = poly[k], [x1, y1] = poly[i]; if ((y0 > y) !== (y1 > y)) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0)); }
    xs.sort((a, b) => a - b);
    for (let i = 0; i < w; i++) { const x = (i + .5) / RES - MARGIN; let inside = false; for (const v of xs) if (v < x) inside = !inside; m[j * w + i] = inside ? 0 : 1; } }
  return m;
}
// 사진 픽셀 → 건물 좌표(m) (모서리 4점 기준)
export function photoToM(corners, W, D){ return homography(corners, [[0, 0], [W, 0], [W, D], [0, D]]); }

/* ── 3. 공간 분할: 벽으로 막힌 영역마다 번호. 작은 조각(글자 상자·계단 해치)은 이웃에 흡수 ──
   cls가 있으면 같은 클래스끼리만 이어진다 (색 채움 모드). 0은 벽 */
export function segment(mask, w, h, { minArea = 3.5 } = {}, cls = null){
  const lab = new Int32Array(w * h).fill(-1), sizes = [], Q = new Int32Array(w * h);
  if (cls) mask = cls.map(c => c ? 0 : 1);
  const same = cls ? (a, b) => cls[a] === cls[b] : () => true;
  let nReg = 0;
  for (let p = 0; p < w * h; p++) {
    if (mask[p] || lab[p] >= 0) continue;
    let qh = 0, qt = 0; Q[qt++] = p; lab[p] = nReg; let cnt = 0;
    while (qh < qt) { const q = Q[qh++]; cnt++; const i = q % w, j = (q - i) / w;
      if (i > 0 && !mask[q - 1] && lab[q - 1] < 0 && same(q, q - 1)) { lab[q - 1] = nReg; Q[qt++] = q - 1; }
      if (i < w - 1 && !mask[q + 1] && lab[q + 1] < 0 && same(q, q + 1)) { lab[q + 1] = nReg; Q[qt++] = q + 1; }
      if (j > 0 && !mask[q - w] && lab[q - w] < 0 && same(q, q - w)) { lab[q - w] = nReg; Q[qt++] = q - w; }
      if (j < h - 1 && !mask[q + w] && lab[q + w] < 0 && same(q, q + w)) { lab[q + w] = nReg; Q[qt++] = q + w; } }
    sizes.push(cnt); nReg++;
  }
  const minPx = minArea * RES * RES, big = sizes.map(s => s >= minPx);
  // 큰 영역에서 벽·조각 픽셀로 번져 나가며 채움 (벽 중심선이 경계가 됨)
  let qh = 0, qt = 0;
  for (let p = 0; p < w * h; p++) { if (lab[p] >= 0 && big[lab[p]]) Q[qt++] = p; else lab[p] = -1; }
  while (qh < qt) { const q = Q[qh++], i = q % w, L = lab[q];
    if (i > 0 && lab[q - 1] < 0) { lab[q - 1] = L; Q[qt++] = q - 1; }
    if (i < w - 1 && lab[q + 1] < 0) { lab[q + 1] = L; Q[qt++] = q + 1; }
    if (q >= w && lab[q - w] < 0) { lab[q - w] = L; Q[qt++] = q - w; }
    if (q + w < w * h && lab[q + w] < 0) { lab[q + w] = L; Q[qt++] = q + w; } }
  // 번호를 0..k-1로 다시 매김 (첫 등장 순서)
  const remap = new Map(); for (let p = 0; p < w * h; p++) if (lab[p] >= 0 && !remap.has(lab[p])) remap.set(lab[p], remap.size);
  for (let p = 0; p < w * h; p++) lab[p] = lab[p] >= 0 ? remap.get(lab[p]) : -1;
  return { lab, count:remap.size };
}

/* ── 4. 레시피 적용: 라벨 점 · 합치기 · 사각형 강제 ── */
export function resolveFloor(floor, rect, W, D){
  const w = Math.round((W + 2 * MARGIN) * RES), h = Math.round((D + 2 * MARGIN) * RES);
  let lab, count, mask = null, warn = [], cls = null;
  const ops = floor.ops || [];
  if (floor.mode === 'auto' && rect) {
    const footprint = floor.autoSpaces && floor.footprint?.length ? floor.footprint : null;
    const m = wallMask(rect, W, D, floor.params, ops.filter(o => o.op === 'wall'), footprint);
    eraseWalls(m, w, h, ops.filter(o => o.op === 'gap'));
    ({ lab, count } = segment(m, w, h, floor.params)); mask = m;
    if (footprint) {
      const outside = outsideMask(W, D, footprint);
      for (let p = 0; p < lab.length; p++) if (outside[p]) lab[p] = -1;
    }
  } else if (floor.mode === 'fill' && rect) {
    cls = fillClasses(rect, W, D, floor.params, outsideMask(W, D, floor.footprint));
    for (const o of ops.filter(o => o.op === 'wall')) {               // 보정 벽: 클래스 0
      const [a, b] = toPx(o.x0, o.y0), [c, d] = toPx(o.x1, o.y1), steps = Math.max(Math.abs(c - a), Math.abs(d - b), 1);
      for (let s = 0; s <= steps; s++) { const x = Math.round(a + (c - a) * s / steps), y = Math.round(b + (d - b) * s / steps);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) cls[yy * w + xx] = 0; } } }
    ({ lab, count } = segment(null, w, h, floor.params, cls));
    mask = cls.map(c => c === 2 ? 1 : 0);                                  // 화면의 '검출 보기'에는 칠한 영역을 보여줌
  } else { lab = new Int32Array(w * h).fill(-1); count = 0; }
  // 사각형 강제 (수동 트레이스 · 자동 결과 보정): 같은 라벨끼리는 한 공간
  for (const o of ops.filter(o => o.op === 'rect')) {
    const id = count++; o._rid = id;
    const [a, b] = toPx(Math.min(o.x0, o.x1), Math.min(o.y0, o.y1)), [c, d] = toPx(Math.max(o.x0, o.x1), Math.max(o.y0, o.y1));
    for (let y = Math.max(0, b); y < Math.min(h, d); y++) for (let x = Math.max(0, a); x < Math.min(w, c); x++) lab[y * w + x] = id;
  }
  const border = new Set(); for (let i = 0; i < w; i++) { border.add(lab[i]); border.add(lab[(h - 1) * w + i]); } for (let j = 0; j < h; j++) { border.add(lab[j * w]); border.add(lab[j * w + w - 1]); }
  const at = (x, y) => { const [i, j] = toPx(x, y); return i >= 0 && j >= 0 && i < w && j < h ? lab[j * w + i] : -1; };
  // 합치기 (union-find)
  const par = Array.from({ length:count }, (_, i) => i), find = i => par[i] === i ? i : (par[i] = find(par[i]));
  for (const o of ops.filter(o => o.op === 'merge')) { const a = at(o.a[0], o.a[1]), b = at(o.b[0], o.b[1]); if (a >= 0 && b >= 0) par[find(b)] = find(a); }
  for (const o of ops.filter(o => o.op === 'rect' && o.number)) {         // 같은 번호의 사각형은 한 방 (L자 등)
    const twin = ops.find(p => p.op === 'rect' && p.number === o.number && p._rid < o._rid); if (twin) par[find(o._rid)] = find(twin._rid); }
  // 라벨: 점이 떨어진 영역에 속성 부여 (사각형 자체 속성도 라벨)
  const attrs = new Map();
  // 색 채움 모드: 실 라벨은 칠한 칸에, 대합실·통로 라벨은 칠하지 않은 칸에 붙는다. 번호 동그라미·글자 위에 찍혀도 1.5m 안의 가장 가까운 칸으로
  let paint = null;                                    // 영역별 칠한 픽셀 비율 (흡수된 아이콘 조각 때문에 '칠한 픽셀 = 상점'이 아님)
  if (cls) { const tot = new Map(), pc = new Map(); for (let p = 0; p < w * h; p++) { if (lab[p] < 0) continue; const k = lab[p]; tot.set(k, (tot.get(k) || 0) + 1); if (cls[p] === 2) pc.set(k, (pc.get(k) || 0) + 1); }
    paint = k => (pc.get(k) || 0) / (tot.get(k) || 1); }
  const snap = o => {
    if (!cls) return at(o.x, o.y);
    const want = o.type === 'room' && o.use !== 'waiting' ? 2 : 1, [i0, j0] = toPx(o.x, o.y), R = Math.round(1.5 * RES);
    const ok = p => cls[p] === want && lab[p] >= 0 && (want === 2 ? paint(lab[p]) > .5 : paint(lab[p]) <= .5);
    if (ok(j0 * w + i0)) return lab[j0 * w + i0];
    for (let r = 1; r <= R; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue; const i = i0 + di, j = j0 + dj;
      if (i >= 0 && j >= 0 && i < w && j < h && ok(j * w + i)) return lab[j * w + i]; }
    if (want === 2) { warn.push(`라벨 ${o.number || o.name} (${o.x}, ${o.y}): 칠한 칸을 찾지 못함 → 사각형으로 지정 필요`); return -2; }
    return at(o.x, o.y);
  };
  const labels = ops.filter(o => o.op === 'label').map(o => ({ ...o, rid:snap(o) }))
    .concat(ops.filter(o => o.op === 'rect' && o.type).map(o => ({ ...o, rid:o._rid })));
  // 색 채움 모드: 붙어 칠해진 상점 줄(사이 흰 틈이 번져 이어짐)에 호실 라벨이 여럿이면 라벨 점 기준 보로노이로 나눈다
  if (cls) {
    const groups = new Map();
    for (const L of labels) if (L.op === 'label' && L.type === 'room' && L.number && L.rid >= 0 && L.use !== 'waiting') { const g = find(L.rid); (groups.get(g) || groups.set(g, []).get(g)).push(L); }
    for (const [g, list] of groups) {
      const pts = list.filter((L, i) => list.findIndex(M => M.number === L.number) === i);
      if (pts.length < 2) continue;
      const ids = pts.map(() => { par.push(par.length); return count++; });
      const P = pts.map(L => toPx(L.x, L.y));
      for (let p = 0; p < w * h; p++) { if (lab[p] < 0 || find(lab[p]) !== g) continue; const i = p % w, j = (p - i) / w;
        let best = 0, bd = Infinity; P.forEach(([x, y], k) => { const d = (x - i) ** 2 + (y - j) ** 2; if (d < bd) { bd = d; best = k; } }); lab[p] = ids[best]; }
      for (const L of list) L.rid = ids[pts.findIndex(M => M.number === L.number)];
    }
  }
  for (const L of labels) {
    if (L.rid === -2) continue;
    if (L.rid < 0 || (L.op === 'label' && border.has(L.rid))) { warn.push(`라벨 ${L.number || L.name || L.type} (${L.x}, ${L.y}): 닫힌 공간 밖에 있음 → 벽 보정 필요`); continue; }
    const k = find(L.rid), prev = attrs.get(k);
    const OPEN = { corridor:4, wc:3, core:2, store:1 };    // 계단·화장실 앞이 복도로 트인 경우: 복도로 본다
    if (prev && prev.type !== L.type && OPEN[prev.type] && OPEN[L.type]) { if (OPEN[L.type] > OPEN[prev.type]) attrs.set(k, { type:L.type, name:L.name }); continue; }
    if (prev && prev.type !== L.type) warn.push(`종류가 다른 라벨(${prev.type}·${L.type})이 한 공간으로 잡힘 @ (${L.x ?? ''}, ${L.y ?? ''}) → 벽 보정 필요`);
    if (prev && prev.number && L.number && prev.number !== L.number) warn.push(`${prev.number}·${L.number}가 한 공간으로 잡힘 → 벽 보정 필요`);
    if (prev && !prev.number && !L.number && prev.name !== L.name) prev.name = undefined;      // 이름이 다른 비냉방 공간이 이어져 있으면 기본 이름
    if (!prev || (!prev.number && L.number)) attrs.set(k, { type:L.type, number:L.number, use:L.use, capacity:L.capacity, name:L.name });
  }
  // 색 채움 모드: 라벨 없는 작은 조각(아이콘·글자·틈)은 가장 길게 맞닿은 이웃 공간에 붙인다
  if (cls) {
    const iconPx = (floor.params?.iconArea ?? 15) * RES * RES, size = new Map(), adj = new Map();
    for (let p = 0; p < w * h; p++) { if (lab[p] < 0) continue; const a = find(lab[p]); size.set(a, (size.get(a) || 0) + 1);
      for (const q of [p + 1, p + w]) { if (q >= w * h || (q === p + 1 && (p + 1) % w === 0) || lab[q] < 0) continue; const b = find(lab[q]); if (a === b) continue;
        for (const [x, y] of [[a, b], [b, a]]) { const m = adj.get(x) || adj.set(x, new Map()).get(x); m.set(y, (m.get(y) || 0) + 1); } } }
    const small = [...size].filter(([k, n]) => !attrs.has(k) && n < iconPx && !border.has(k)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const [k] of small) { const nb = [...(adj.get(k) || [])].filter(([b]) => !border.has(b)).sort((a, b) => (attrs.has(b[0]) ? 0 : 1) - (attrs.has(a[0]) ? 0 : 1) || b[1] - a[1] || a[0] - b[0])[0];
      if (nb) { const t = find(nb[0]); par[find(k)] = t; } }
  }
  return { w, h, lab, find, attrs, count, warn, mask };
}

/* ── 5. 공간 → 다각형: 행 단위 구간을 사각형으로 묶고, 좌표를 층 전체에서 정렬 ── */
function rectsOf(lab, w, h, find, id, bb, thin = false){
  const tol = .35 * RES, minRun = .3 * RES, open = [], done = [];
  for (let j = bb.y0; j <= bb.y1 + 1; j++) {
    const runs = [];
    if (j <= bb.y1) { let s = -1;
      for (let i = bb.x0; i <= bb.x1 + 1; i++) { const inside = i <= bb.x1 && lab[j * w + i] >= 0 && find(lab[j * w + i]) === id;
        if (inside && s < 0) s = i; if (!inside && s >= 0) { if (i - s >= minRun) runs.push([s, i]); s = -1; } } }
    const used = new Set();
    for (let k = open.length - 1; k >= 0; k--) {
      const o = open[k], m = runs.findIndex((r, ri) => !used.has(ri) && Math.abs(r[0] - o.x0) < tol && Math.abs(r[1] - o.x1) < tol);
      if (m >= 0) { used.add(m); o.xs0.push(runs[m][0]); o.xs1.push(runs[m][1]); o.y1 = j + 1; }
      else { done.push(o); open.splice(k, 1); }
    }
    runs.forEach((r, ri) => { if (!used.has(ri)) open.push({ x0:r[0], x1:r[1], xs0:[r[0]], xs1:[r[1]], y0:j, y1:j + 1 }); });
  }
  const med = a => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  return done.filter(o => o.y1 - o.y0 >= .4 * RES || (thin && (o.y1 - o.y0) * (o.x1 - o.x0) >= 1.5 * RES * RES)).map(   // 사선·곡선 입면: 얇아도 넓은 띠는 남김
    o => ({ x0:med(o.xs0) / RES - MARGIN, x1:med(o.xs1) / RES - MARGIN, y0:o.y0 / RES - MARGIN, y1:o.y1 / RES - MARGIN }));
}
function cluster(vals, tol, anchors){
  const s = [...new Set(vals)].sort((a, b) => a - b), map = new Map();
  let grp = [];
  const flush = () => { if (!grp.length) return; const a = anchors.find(t => grp.some(v => Math.abs(v - t) < .45));
    const v = a ?? r2(grp.reduce((p, q) => p + q, 0) / grp.length); grp.forEach(g => map.set(g, v)); grp = []; };
  for (const v of s) { if (grp.length && v - grp[grp.length - 1] > tol) flush(); grp.push(v); }
  flush(); return map;
}
// 사각형 합집합의 바깥 테두리 (축 정렬 격자 위에서 추적)
function outline(rects){
  const xs = [...new Set(rects.flatMap(r => [r.x0, r.x1]))].sort((a, b) => a - b), ys = [...new Set(rects.flatMap(r => [r.y0, r.y1]))].sort((a, b) => a - b);
  const nx = xs.length - 1, ny = ys.length - 1, cell = new Uint8Array(Math.max(0, nx * ny)), xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  for (const r of rects) for (let i = xi.get(r.x0); i < xi.get(r.x1); i++) for (let j = yi.get(r.y0); j < yi.get(r.y1); j++) cell[j * nx + i] = 1;
  const on = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && cell[j * nx + i] === 1;
  // 경계 변 (안쪽이 진행 방향 오른쪽 = 화면 좌표에서 시계 방향). 한 꼭짓점에서 나가는 변이 둘일 수 있다(꼭짓점만 닿은 두 칸)
  const E = new Map(), key = (i, j) => i + ',' + j, add = (a, b) => (E.get(key(...a)) || E.set(key(...a), []).get(key(...a))).push(b);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    if (!on(i, j)) continue;
    if (!on(i, j - 1)) add([i, j], [i + 1, j]);
    if (!on(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
    if (!on(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
    if (!on(i - 1, j)) add([i, j + 1], [i, j]);
  }
  const used = new Set(), loops = [];
  for (const sk of [...E.keys()].sort()) for (const first of E.get(sk)) {
    const [si, sj] = sk.split(',').map(Number);
    if (used.has(`${si},${sj}>${first}`)) continue;
    const pts = []; let cur = [si, sj], nxt = first, guard = 0;
    while (guard++ < 99999) {
      used.add(`${cur[0]},${cur[1]}>${nxt}`); pts.push([xs[cur[0]], ys[cur[1]]]);
      const d = [Math.sign(nxt[0] - cur[0]), Math.sign(nxt[1] - cur[1])]; cur = nxt;
      if (cur[0] === si && cur[1] === sj) break;
      const outs = (E.get(key(...cur)) || []).filter(n => !used.has(`${cur[0]},${cur[1]}>${n}`));
      if (!outs.length) break;
      const turn = n => { const e = [Math.sign(n[0] - cur[0]), Math.sign(n[1] - cur[1])]; return e[0] === -d[1] && e[1] === d[0] ? 0 : e[0] === d[0] && e[1] === d[1] ? 1 : 2; };   // 오른쪽 > 직진 > 왼쪽
      nxt = outs.sort((a, b) => turn(a) - turn(b))[0];
    }
    const clean = pts.filter((p, i) => { const a = pts[(i - 1 + pts.length) % pts.length], c = pts[(i + 1) % pts.length]; return !((a[0] === p[0] && p[0] === c[0]) || (a[1] === p[1] && p[1] === c[1])); });
    if (clean.length >= 4) loops.push(clean);
  }
  if (!loops.length) return [];
  loops.sort((a, b) => areaOf(b) - areaOf(a));
  const outer = loops[0], mid = l => [(Math.min(...l.map(p => p[0])) + Math.max(...l.map(p => p[0]))) / 2, (Math.min(...l.map(p => p[1])) + Math.max(...l.map(p => p[1]))) / 2];
  const holes = loops.slice(1).filter(l => inPoly(...mid(l), outer) && !rects.some(r => { const [x, y] = mid(l); return x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1; }));
  if (holes.length) outer.holes = holes;                   // 큰 대합실 안에 상점이 섬처럼 있으면 구멍
  return outer;
}

// 맞닿고 폭이 같은 사각형끼리 합침 (복도가 가는 띠로 쪼개지는 것 방지)
function mergeRects(list){
  const a = list.map(r => ({ ...r })).sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
  let changed = true;
  while (changed) { changed = false;
    for (let i = 0; i < a.length && !changed; i++) for (let j = 0; j < a.length && !changed; j++) { if (i === j) continue; const p = a[i], q = a[j];
      if (p.x0 === q.x0 && p.x1 === q.x1 && Math.abs(p.y1 - q.y0) < .45) { p.y1 = q.y1; a.splice(j, 1); changed = true; }
      else if (p.y0 === q.y0 && p.y1 === q.y1 && Math.abs(p.x1 - q.x0) < .45) { p.x1 = q.x1; a.splice(j, 1); changed = true; } } }
  return a;
}
function traceRoomRegion(lab,w,h,find,id,bb){
  const step=3, x0=Math.floor(bb.x0/step)*step, y0=Math.floor(bb.y0/step)*step;
  const width=Math.ceil((bb.x1+1-x0)/step),height=Math.ceil((bb.y1+1-y0)/step);
  const cells=new Uint8Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const xx=Math.min(w-1,x0+x*step+1), yy=Math.min(h-1,y0+y*step+1), value=lab[yy*w+xx];
    if(value>=0&&find(value)===id)cells[y*width+x]=1;
  }
  const rings=traceFloorRegions(cells,width,height)
    .map(loop=>loop.map(([x,y])=>[(x0+x*step)/RES-MARGIN,(y0+y*step)/RES-MARGIN]))
    .filter(loop=>areaOf(loop)>=1.5);
  const holes=rings.filter(loop=>areaSign(loop)<0);
  return rings.filter(loop=>areaSign(loop)>0).map(loop=>{
    const inner=holes.filter(hole=>inPoly(...hole[0],loop));
    if(inner.length)loop.holes=inner;
    return loop;
  });
}
const TYPE_NAME = { corridor:'복도', wc:'화장실', core:'계단실', store:'설비실' };
export const USE_NAME = { lecture:'강의실', lab:'실습실', office:'연구실', meeting:'세미나실', admin:'행정실', lounge:'라운지',
  retail:'상점', restaurant:'식당', waiting:'대합실' };

export function floorRooms(floor, res, W, D){
  const { w, h, lab, find, attrs, warn } = res;
  const bbs = new Map();
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const L = lab[j * w + i]; if (L < 0) continue; const k = find(L);
    const b = bbs.get(k) || bbs.set(k, { x0:i, y0:j, x1:i, y1:j, n:0 }).get(k); if (i < b.x0) b.x0 = i; if (i > b.x1) b.x1 = i; if (j < b.y0) b.y0 = j; if (j > b.y1) b.y1 = j; b.n++; }
  const regs = [];
  for (const [k, bb] of [...bbs].sort((a, b) => a[0] - b[0])) {
    const [cx, cy] = toM((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2), area = bb.n / RES / RES, a = attrs.get(k);
    const inside = cx > 0 && cx < W && cy > 0 && cy < D;
    if (!a && (!inside || bb.x0 === 0 || bb.y0 === 0 || bb.x1 === w - 1 || bb.y1 === h - 1)) continue;   // 건물 밖(라벨 없음)은 버림
    const inferred = !a && floor.autoSpaces && (floor.footprint?.length || area <= W * D * .92);
    const polygons = (floor.darkPlan || floor.shellFootprint) && inferred ? traceRoomRegion(lab,w,h,find,k,bb) : null;
    // 자동 공간이 층 윤곽의 35% 넘게 차지하면 벽을 못 나눈 복도·홀로 봄 (흰 덩어리 방 블록 대신 바닥만)
    const fpArea = floor.footprint?.length ? footArea(floor.footprint) : W * D, hall = inferred && area > fpArea * .35;
    regs.push({ k, bb, area, a:a || (hall ? { type:'corridor', name:'복도·홀' } : inferred ? { type:'room', name:'자동 공간', use:'unknown' } : { type:'store', name:'미지정' }), unlabeled:!a && !inferred, inferred, hall:!a && hall, polygons, rects:polygons ? [] : rectsOf(lab, w, h, find, k, bb, floor.mode === 'fill') });
  }
  // 층 전체에서 x·y 좌표를 묶어 인접한 방의 경계를 일치시킴 (외곽 0·W·D에는 붙임)
  const all = regs.flatMap(r => r.rects);
  const fill = floor.mode === 'fill', tolC = fill ? .12 : .3;        // 사선·곡선 입면(색 채움 도면)은 계단 모양이 뭉개지지 않게 작게
  const mx = cluster(all.flatMap(r => [r.x0, r.x1]), tolC, [0, W]), my = cluster(all.flatMap(r => [r.y0, r.y1]), tolC, [0, D]);
  for (const r of all) { r.x0 = mx.get(r.x0); r.x1 = mx.get(r.x1); r.y0 = my.get(r.y0); r.y1 = my.get(r.y1); }
  const rooms = [], meta = {};
  let xi = 0;
  for (const R of regs) {
    const rects = mergeRects(R.rects.filter(r => r.x1 - r.x0 > (fill ? .1 : .2) && r.y1 - r.y0 > (fill ? .1 : .2)));
    if (!rects.length && !R.polygons?.length) continue;
    const a = R.a;
    if (a.type === 'atrium' || a.type === 'elevator') {
      const b = { x0:Math.min(...rects.map(r => r.x0)), y0:Math.min(...rects.map(r => r.y0)), x1:Math.max(...rects.map(r => r.x1)), y1:Math.max(...rects.map(r => r.y1)) };
      meta[a.type] = b; continue;
    }
    if (R.unlabeled) warn.push(`라벨 없는 공간 ${r1(R.area)}㎡ @ (${r1(toM(R.bb.x0, R.bb.y0)[0])}, ${r1(toM(R.bb.x0, R.bb.y0)[1])}) → 설비실로 둠`);
    const type = a.type || 'room';
    // 복도·홀(벽을 못 나눈 자동 공간)은 사각형 조각으로 쪼개지 않고 한 공간으로 둠: 조각마다 공간이 되면 실내기를 고르게 펼 수 없음
    const pieces = R.polygons ?? (type === 'room' || R.hall ? [outline(rects)] : rects.map(r => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]));
    pieces.forEach((poly, pi) => {
      if (poly.length < (R.polygons ? 3 : 4)) return;
      const id = type === 'room' && a.number ? `${floor.id}-${a.number}` : `${floor.id}-x${String(++xi).padStart(2, '0')}`;
      const room = { id: pieces.length > 1 && type === 'room' ? `${id}-${pi + 1}` : id,
        name: type === 'room' ? `${a.number || ''} ${a.name || USE_NAME[a.use] || '실'}`.trim() : (a.name || TYPE_NAME[type] || type), type, polygon:poly };
      if (poly.holes?.length) room.holes = poly.holes;
      if (R.hall) room.hall = true;   // 실내기 면적 추정 대상(벽을 못 나눈 실과 복도가 섞인 공간)
      if (R.inferred) room.name = '자동 공간 ' + String(xi).padStart(2, '0');
      if (type === 'room') Object.assign(room, { number:a.number || null, use:a.use || 'office', capacity:+a.capacity || 0 });
      rooms.push(room);
    });
  }
  return { rooms, meta, warn };
}

/* ── 6. 실내기: 사진에서 센 대수(없으면 면적 기준 추정) → 위치·용량·실외기 계통 ── */
export const CATALOG = {
  '4WAY': { model:'LG 시스템에어컨 4WAY 천장형 카세트', type:'4WAY 카세트', kw:[5.6, 7.2, 9, 11, 13] },
  '1WAY': { model:'LG 시스템에어컨 1WAY 천장형 카세트', type:'1WAY 카세트', kw:[2.8, 3.6, 4, 5.6] },
  'WALL': { model:'LG 벽걸이형 실내기', type:'벽걸이', kw:[2.3, 2.8, 3.6, 5.6] },
};
const LOAD = { lecture:.2, lab:.22, meeting:.18, lounge:.18, admin:.16, office:.16, retail:.25, restaurant:.3, waiting:.2 };    // kW/㎡ 냉방부하 가정
const areaOf = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; s += x0 * y1 - x1 * y0; } return Math.abs(s) / 2; };
const inPoly = (x, y, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const [xi, yi] = p[i], [xj, yj] = p[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const roomArea = r => areaOf(r.polygon) - (r.holes || []).reduce((t, h) => t + areaOf(h), 0);
const inRoom = (x, y, r) => inPoly(x, y, r.polygon) && !(r.holes || []).some(h => inPoly(x, y, h));

/* 실내기 위치는 근거가 강한 것부터 쓴다 (방마다 따로 판단):
   ① 도면 표기  — 평면도·설비대장에 실내기 위치가 있으면 그대로 (층 조작 op:'idu')
   ② 모델 예측  — 에어컨이 없는 평면도에서 위치를 예측한 결과 (twin.acplacement/v1). 신뢰도 하한 미만은 버림
   ③ 사진 대수  — 천장 사진에서 센 대수를 방 긴 축에 고르게
   ④ 면적 추정  — 40㎡당 1대
   ②+③: 모델 위치를 쓰되 대수는 사진을 따름 (신뢰도 높은 순으로 자르고, 모자라면 규칙 배치로 채움) */
const LOAD_DEFAULT = .16;
const GRID = new WeakMap();
// 5대 이상(큰 홀·대합실): 실 안 격자에 고르게. 간격 = √(면적/대수)에서 시작해 모자라면 줄임
const SPREAD = new WeakMap();
function spreadPos(r, n){
  const key = SPREAD.get(r); if (key?.n === n) return key.pts;
  const xs = r.polygon.map(p => p[0]), ys = r.polygon.map(p => p[1]), b = { x0:Math.min(...xs), x1:Math.max(...xs), y0:Math.min(...ys), y1:Math.max(...ys) };
  let sp = Math.sqrt(roomArea(r) / n), pts = [];
  for (let t = 0; t < 12; t++, sp *= .9) { pts = [];
    for (let y = b.y0 + sp / 2; y < b.y1; y += sp) for (let x = b.x0 + sp / 2; x < b.x1; x += sp) if (inRoom(x, y, r)) pts.push([x, y]);
    if (pts.length >= n) break; }
  const pick = pts.length <= n ? pts : Array.from({ length:n }, (_, k) => pts[Math.floor((k + .5) * pts.length / n)]);
  SPREAD.set(r, { n, pts:pick }); return pick;
}
function rulePos(r, n, k){
  if (n >= 5) { const p = spreadPos(r, n)[k]; if (p) return p; }
  const xs = r.polygon.map(p => p[0]), ys = r.polygon.map(p => p[1]);
  const b = { x0:Math.min(...xs), x1:Math.max(...xs), y0:Math.min(...ys), y1:Math.max(...ys) }, longX = b.x1 - b.x0 >= b.y1 - b.y0, t = (k + .5) / n;
  let x = longX ? b.x0 + (b.x1 - b.x0) * t : (b.x0 + b.x1) / 2, y = longX ? (b.y0 + b.y1) / 2 : b.y0 + (b.y1 - b.y0) * t;
  if (!inRoom(x, y, r)) { // L자 방·구멍 있는 방: 가장 가까운 안쪽 격자점 (격자는 방마다 한 번만 계산)
    const grid = GRID.get(r) || GRID.set(r, (() => { const g = []; for (let gx = b.x0 + .5; gx < b.x1; gx += .5) for (let gy = b.y0 + .5; gy < b.y1; gy += .5) if (inRoom(gx, gy, r)) g.push([gx, gy]); return g; })()).get(r);
    let best = null; for (const [gx, gy] of grid) { const d = (gx - x) ** 2 + (gy - y) ** 2; if (!best || d < best[2]) best = [gx, gy, d]; }
    if (best) [x, y] = best; }
  return [x, y];
}
export function placeIdus(floors, src, W){
  const { counts = {}, explicit = {}, predicted = {}, model = {} } = src, minConf = model.minConfidence ?? .5;
  const idus = [], warn = [], conf = v => Math.round(v * 100) / 100;
  for (const f of floors) {
    let addr = 0;
    // 냉방 공간: 실, 그리고 사람이 표기하거나 모델·사진으로 실내기를 둔 복도·홀(면적 추정은 실에만)
    const rooms = f.rooms.filter(r => r.type === 'room' || r.type === 'corridor');
    const owner = u => u.room ? rooms.find(r => r.id === u.room) : rooms.find(r => r.type === 'room' && inRoom(u.x, u.y, r)) ?? rooms.find(r => inRoom(u.x, u.y, r));
    const ex = new Map(), pr = new Map();
    for (const u of explicit[f.id] || []) { const r = owner(u); if (r) (ex.get(r) || ex.set(r, []).get(r)).push(u); else warn.push(`${f.id}: 도면 표기 실내기 (${u.x}, ${u.y})가 냉방 실 밖에 있음`); }
    for (const u of predicted[f.id] || []) { if ((u.confidence ?? 1) < minConf) continue; const r = owner(u); if (r) (pr.get(r) || pr.set(r, []).get(r)).push(u); }
    for (const r of rooms) {
      const area = roomArea(r), c = counts[r.id], n = c?.units?.length || 0;
      let units;            // [{x, y, kind, coolKw?, source, basis}]
      if (ex.has(r)) {
        units = ex.get(r).filter(u => !u.none).map(u => ({ ...u, source:'plan', basis:u.from || '도면 표기' }));   // none: 사람이 '이 방은 실내기 없음'으로 고정
        if (!units.length) continue;
        if (n && n !== units.length) warn.push(`${r.id}: 도면 표기 ${units.length}대 ≠ 사진 ${n}대 → 도면 표기를 씀`);
      } else if (pr.has(r)) {
        const list = [...pr.get(r)].sort((a, b) => (b.confidence ?? 1) - (a.confidence ?? 1) || a.x - b.x || a.y - b.y);
        const take = n ? list.slice(0, n) : list;
        units = take.map((u, k) => ({ x:u.x, y:u.y, kind:(n ? c.units[k] : u.kind) || '4WAY', coolKw:u.coolKw, source:'model',
          basis:`모델 ${model.name || '예측'} (신뢰도 ${conf(u.confidence ?? 1)})${n ? ' · 대수는 사진' : ''}` }));
        for (let k = take.length; k < n; k++) { const [x, y] = rulePos(r, n, k); units.push({ x, y, kind:c.units[k], source:'photo', basis:`사진 ${c.photos.join(', ')} (모델 위치 부족)` }); }
        if (n && list.length !== n) warn.push(`${r.id}: 모델 ${list.length}대 ≠ 사진 ${n}대 → 대수는 사진`);
      } else if (n) {
        units = c.units.map((kind, k) => { const [x, y] = rulePos(r, n, k); return { x, y, kind, source:'photo', basis:`사진 ${c.photos.join(', ')}` }; });
      } else {
        if (r.type !== 'room' && !r.hall) continue;   // 복도는 면적 추정 제외, 벽을 못 나눈 복도·홀은 실이 섞여 있어 추정
        const m = Math.max(1, Math.round(area / 40));
        units = Array.from({ length:m }, (_, k) => { const [x, y] = rulePos(r, m, k); return { x, y, kind:area < 40 ? '1WAY' : '4WAY', source:'estimate', basis:'추정(면적 40㎡당 1대)' }; });
      }
      const need = area * (LOAD[r.use] || LOAD_DEFAULT) / units.length;
      units.forEach((u, k) => {
        const C = CATALOG[u.kind] || CATALOG['4WAY'], coolKw = +u.coolKw || (C.kw.find(v => v >= need) ?? C.kw[C.kw.length - 1]);
        idus.push({ id:`IDU-${r.id}-${k + 1}`, ctrlAddr:String(addr++).padStart(2, '0'), room:r.id, model:u.model || C.model, type:C.type, coolKw, ratedKw:r2(coolKw * .31),
          pos:[r2(u.x), r2(u.y)], odu:u.odu || `ODU-${f.id}-${u.x < W / 2 ? 'W' : 'E'}`, source:u.source, basis:u.basis });
      });
    }
  }
  const odus = [...new Set(idus.map(a => a.odu))].map(id => ({ id, model:'LG MULTI V 실외기', location:`옥상 ${id.endsWith('W') ? '서측' : '동측'}`, serves:id.split('-')[1] }));
  return { idus, odus, warn };
}

/* ── 6b. 모델 입력·출력 형식 ──
   입력(twin.acplacement.input/v1): 층마다 보정된 평면도 이미지(픽셀 = (x+MARGIN)·RES) + 실 다각형(에어컨 없는 평면도)
   출력(twin.acplacement/v1):      { schema, model:{name, version}, units:[{ floor, x, y | px:[i,j], kind, coolKw?, confidence, room? }] }
   px로 주면 입력 이미지의 픽셀 좌표로 보고 m로 바꾼다 */
export function modelInput(recipe, floorsJson){
  const B = recipe.building;
  return { schema:'twin.acplacement.input/v1', building:{ id:B.id, name:B.name, size:B.size, floorHeight:B.floorHeight, ceiling:B.ceiling },
    raster:{ res:RES, margin:MARGIN, note:'pixel (i, j) = ((x + margin) * res, (y + margin) * res), x·y in metres' },
    catalog:Object.fromEntries(Object.entries(CATALOG).map(([k, v]) => [k, v.kw])),
    floors:floorsJson.map(f => ({ id:f.id, plan:`plan-${f.id}.png`, walls:`walls-${f.id}.png`,
      rooms:f.rooms.map(r => ({ id:r.id, type:r.type, use:r.use || null, area:r2(roomArea(r)), polygon:r.polygon, holes:r.holes })) })) };
}
export function readPredictions(pred){
  if (!pred) return {};
  if (pred.schema && pred.schema !== 'twin.acplacement/v1') throw new Error('모델 결과 형식이 twin.acplacement/v1이 아님: ' + pred.schema);
  const out = {};
  for (const u of pred.units || []) { const [x, y] = u.px ? toM(u.px[0] - .5, u.px[1] - .5) : [u.x, u.y];
    if (!u.floor || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    (out[u.floor] ||= []).push({ x:r2(x), y:r2(y), kind:u.kind || '4WAY', coolKw:u.coolKw, confidence:u.confidence ?? 1, room:u.room }); }
  return out;
}
// 모델 입력용 '벽 그림': 실 다각형 테두리만 검게 (사진의 얼룩·글자 없이 정규화된 평면도)
export function renderWalls(floor, W, D){
  const w = Math.round((W + 2 * MARGIN) * RES), h = Math.round((D + 2 * MARGIN) * RES), data = new Uint8ClampedArray(w * h * 4).fill(255);
  const dot = (x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const i = x + dx, j = y + dy; if (i >= 0 && j >= 0 && i < w && j < h) { const o = (j * w + i) * 4; data[o] = data[o + 1] = data[o + 2] = 0; } } };
  for (const r of floor.rooms) r.polygon.forEach((p, k) => { const q = r.polygon[(k + 1) % r.polygon.length], [a, b] = toPx(...p), [c, d] = toPx(...q), n = Math.max(Math.abs(c - a), Math.abs(d - b), 1);
    for (let s = 0; s <= n; s++) dot(Math.round(a + (c - a) * s / n), Math.round(b + (d - b) * s / n)); });
  return { width:w, height:h, data };
}

/* ── 7. 사진에서 색 뽑기: 사람이 고른 사각형 안의 중앙값 (조명 얼룩에 강함) ── */
export function medianColor(img, box){
  const { width:w, data } = img, rs = [], gs = [], bs = [];
  const x0 = Math.round(Math.min(box[0], box[2])), x1 = Math.round(Math.max(box[0], box[2])), y0 = Math.round(Math.min(box[1], box[3])), y1 = Math.round(Math.max(box[1], box[3]));
  const step = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / 4000)));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const o = (y * w + x) * 4; rs.push(data[o]); gs.push(data[o + 1]); bs.push(data[o + 2]); }
  const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1] || 0; };
  return '#' + [med(rs), med(gs), med(bs)].map(v => v.toString(16).padStart(2, '0')).join('');
}

/* ── 8. 전체 조립 ── */
/* ── 큰 공간을 공조 구역으로 나누기 (대합실·로비·식당가처럼 실내기가 많은 열린 공간) ──
   기준 (다른 건물에도 같은 규칙):
     1) 실내기가 maxIdus(기본 8)대보다 많은 실만 나눈다
     2) 실외기(냉매 계통)가 다른 실내기는 같은 구역에 넣지 않는다 — 계통이 제어·운전의 단위
     3) 외주부·내주부 분리: 외벽에서 perimeter(기본 4.57m = ASHRAE 90.1 부록 G의 외주부 깊이) 안의 실내기는 외주부,
        외주부는 외벽이 바라보는 방향(도면 기준 위·아래·좌·우)별로 따로 묶는다 — 일사·외기 부하가 달라서
        외주부 묶음의 실내기가 minIdus(기본 2)대 미만이면 같은 계통의 가장 가까운 묶음에 합친다
     4) 같은 묶음 안에서 거리로 묶되(k-평균, 시작점은 긴 축 순서로 고정 → 항상 같은 결과) 한 구역은 maxIdus대 이하
     5) 구역 경계 = 실 안의 각 점에서 (그 점과 같은 외주부·내주부 구분의) 가장 가까운 실내기가 속한 구역 (보로노이), cell(기본 0.5m) 격자로 계산.
        떨어져 나온 작은 조각은 가장 많이 맞닿은 구역에 붙인다
   결과: 원래 실은 구역 실들로 바뀌고(id = 원래id-1,2,…), 각 구역 실에 zoneOf(원래 실)·zoneBasis(나눈 근거)를 남긴다 */
export const ZONING = { maxIdus:8, minIdus:2, perimeter:4.57, cell:.5 };
export function splitZones(floors, idus, W, D, opt = {}){
  const Z = { ...ZONING, ...opt }, info = [];
  if (Z.enabled === false) return info;
  for (const f of floors) {
    const feet = !f.footprint?.length ? [[[0, 0], [W, 0], [W, D], [0, D]]] : Array.isArray(f.footprint[0]?.[0]) ? f.footprint : [f.footprint];
    const edges = feet.flatMap(foot => { const sg = areaSign(foot); return foot.map((p, i) => [p, foot[(i + 1) % foot.length], sg]); });
    const near = ([x, y]) => { let best = { d:1e9 }; for (const [a, b, sg] of edges) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L));
      const d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); if (d < best.d) best = { d, nx:dy * sg, ny:-dx * sg }; } return best; };
    const out = [];
    for (const r of f.rooms) {
      const mine = idus.filter(a => a.room === r.id);
      if (r.type !== 'room' || mine.length <= Z.maxIdus) { out.push(r); continue; }
      // 2·3) 계통 · 외주부(방향) · 내주부 묶음
      const side = (ox, oy) => {     // 바깥 방향 (윤곽마다 돌림 방향을 반영한 법선)
        return Math.abs(ox) > Math.abs(oy) ? (ox > 0 ? '우측' : '좌측') : (oy > 0 ? '아래쪽' : '위쪽'); };
      const clsOf = pt => { const n = near(pt); return n.d < Z.perimeter ? `외주부 ${side(n.nx, n.ny)}` : '내주부'; };
      const buckets = new Map();
      for (const a of mine) { a._cls = clsOf(a.pos); const k = `${a.odu}|${a._cls}`; (buckets.get(k) || buckets.set(k, []).get(k)).push(a); }
      // 실내기가 minIdus(기본 2)대 미만인 외주부 묶음은 같은 계통의 가장 가까운 묶음에 합침 (구역이 너무 잘게 쪼개지지 않게)
      for (const [k, list] of [...buckets]) {
        if (list.length >= (Z.minIdus ?? 2) || !buckets.has(k)) continue;
        const odu = k.split('|')[0], cand = [...buckets].filter(([k2]) => k2 !== k && k2.startsWith(odu + '|'));
        if (!cand.length) continue;
        const d = ([, l2]) => Math.min(...l2.flatMap(b => list.map(a => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]))));
        const [k2, l2] = cand.sort((p, q) => d(p) - d(q) || p[0].localeCompare(q[0]))[0];
        for (const a of list) a._cls = k2.split('|')[1];
        l2.push(...list); buckets.delete(k);
      }
      // 4) 묶음마다 k-평균
      const groups = [];
      for (const [k, list] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
        const n = Math.ceil(list.length / Z.maxIdus);
        const mx = list.reduce((s, a) => s + a.pos[0], 0) / list.length, my = list.reduce((s, a) => s + a.pos[1], 0) / list.length;
        let sxx = 0, syy = 0, sxy = 0; for (const a of list) { const dx = a.pos[0] - mx, dy = a.pos[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
        const th = .5 * Math.atan2(2 * sxy, sxx - syy), ax = [Math.cos(th), Math.sin(th)], proj = a => (a.pos[0] - mx) * ax[0] + (a.pos[1] - my) * ax[1];
        const sorted = [...list].sort((a, b) => proj(a) - proj(b) || a.id.localeCompare(b.id));
        let C = Array.from({ length:n }, (_, i) => [...sorted[Math.floor((i + .5) * sorted.length / n)].pos]), lab = [];
        for (let it = 0; it < 30; it++) {
          // 크기 제한 있는 배정: 가까운 순으로 채우고 꽉 찬 구역은 건너뜀
          const cap = Math.ceil(list.length / n), cnt = Array(n).fill(0), pairs = [];
          sorted.forEach((a, i) => C.forEach((c, j) => pairs.push([Math.hypot(a.pos[0] - c[0], a.pos[1] - c[1]), i, j])));
          pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]); lab = Array(sorted.length).fill(-1);
          for (const [, i, j] of pairs) if (lab[i] < 0 && cnt[j] < cap) { lab[i] = j; cnt[j]++; }
          const NC = C.map((c, j) => { const m = sorted.filter((_, i) => lab[i] === j); return m.length ? [m.reduce((s, a) => s + a.pos[0], 0) / m.length, m.reduce((s, a) => s + a.pos[1], 0) / m.length] : c; });
          if (NC.every((c, j) => Math.hypot(c[0] - C[j][0], c[1] - C[j][1]) < 1e-6)) break; C = NC;
        }
        for (let j = 0; j < n; j++) { const m = sorted.filter((_, i) => lab[i] === j); if (m.length) groups.push({ key:k, idus:m }); }
      }
      // 5) 보로노이 격자 → 구역 다각형
      const xs = r.polygon.map(p => p[0]), ys = r.polygon.map(p => p[1]), x0 = Math.floor(Math.min(...xs) / Z.cell) * Z.cell, y0 = Math.floor(Math.min(...ys) / Z.cell) * Z.cell;
      const nx = Math.ceil((Math.max(...xs) - x0) / Z.cell), ny = Math.ceil((Math.max(...ys) - y0) / Z.cell), g = new Int16Array(nx * ny).fill(-1);
      const owner = new Map(); groups.forEach((gr, gi) => gr.idus.forEach(a => owner.set(a.id, gi)));
      // 칸의 외주부·내주부 구분이 같은 실내기 중 가장 가까운 것 (그 구분의 실내기가 없으면 전체에서 가장 가까운 것)
      const byCls = new Map(); for (const a of mine) (byCls.get(a._cls) || byCls.set(a._cls, []).get(a._cls)).push(a);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const cx = x0 + (i + .5) * Z.cell, cy = y0 + (j + .5) * Z.cell; if (!inRoom(cx, cy, r)) continue;
        const pool = byCls.get(clsOf([cx, cy])) || mine;
        let best = null, bd = 1e9; for (const a of pool) { const d = (a.pos[0] - cx) ** 2 + (a.pos[1] - cy) ** 2; if (d < bd) { bd = d; best = a; } } g[j * nx + i] = owner.get(best.id); }
      // 떨어진 조각 정리: 구역마다 가장 큰 덩어리만 남기고 나머지는 많이 맞닿은 이웃 구역으로
      for (let pass = 0; pass < 3; pass++) {
        const comp = new Int32Array(nx * ny).fill(-1), comps = [];
        for (let s0 = 0; s0 < nx * ny; s0++) { if (g[s0] < 0 || comp[s0] >= 0) continue; const id = comps.length, st = [s0], cells = []; comp[s0] = id;
          while (st.length) { const c = st.pop(); cells.push(c); const ci = c % nx, cj = (c / nx) | 0;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ni = ci + di, nj = cj + dj, nc = nj * nx + ni; if (ni >= 0 && nj >= 0 && ni < nx && nj < ny && comp[nc] < 0 && g[nc] === g[c]) { comp[nc] = id; st.push(nc); } } }
          comps.push({ gi:g[s0], cells }); }
        const biggest = new Map(); for (const c of comps) if (!biggest.has(c.gi) || biggest.get(c.gi).cells.length < c.cells.length) biggest.set(c.gi, c);
        let moved = 0;
        for (const c of comps) { if (biggest.get(c.gi) === c) continue; const touch = new Map();
          for (const cell of c.cells) { const ci = cell % nx, cj = (cell / nx) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue; const v = g[nj * nx + ni]; if (v >= 0 && v !== c.gi) touch.set(v, (touch.get(v) || 0) + 1); } }
          const to = [...touch].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]; if (to == null) continue; for (const cell of c.cells) g[cell] = to; moved++; }
        if (!moved) break;
      }
      const total = roomArea(r), made = [];
      groups.forEach((gr, gi) => {
        const rects = []; for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (g[j * nx + i] === gi) rects.push({ x0:r2(x0 + i * Z.cell), y0:r2(y0 + j * Z.cell), x1:r2(x0 + (i + 1) * Z.cell), y1:r2(y0 + (j + 1) * Z.cell) });
        if (!rects.length) return;
        const poly = outline(rects); if (!poly.length) return;
        const zr = { id:`${r.id}-${made.length + 1}`, name:`${r.name} ${made.length + 1}구역`, type:'room', number:`${r.number || r.id}-${made.length + 1}`, use:r.use, polygon:poly.map(p => [r2(p[0]), r2(p[1])]),
          ...(poly.holes ? { holes:poly.holes.map(h => h.map(p => [r2(p[0]), r2(p[1])])) } : {}), ...(r.finish ? { finish:r.finish } : {}) };
        zr.capacity = Math.round((r.capacity || 0) * roomArea(zr) / total);
        zr.zoneOf = r.id; zr.zoneBasis = `${gr.key.split('|')[0]} · ${gr.key.split('|')[1]} · 실내기 ${gr.idus.length}대`;
        for (const a of gr.idus) { a.room = zr.id; delete a._cls; }
        made.push(zr);
      });
      info.push({ room:r.id, zones:made.length, idus:mine.length });
      out.push(...made);
    }
    f.rooms = out;
  }
  return info;
}
const areaSign = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; s += x0 * y1 - x1 * y0; } return Math.sign(s) || 1; };

/* ── 스카이뷰(항공·위성 사진) 맞추기 ──
   site.ref = [{ m:[x, y](도면 m), px:[u, v](스카이뷰 px) }, ...] 사람이 찍은 같은 점들
   mode 'similarity'(회전·축척·이동, 2점 이상) — 도면이 실측일 때 / 'affine'(3점 이상) — 안내도처럼 비율이 어긋난 그림일 때
   결과: toImage(도면 m → 사진 px), northDeg(도면 위쪽이 진북에서 시계 방향으로 몇 도), 사진 축척으로 본 도면 크기 차이 */
export function siteFit(site, W, D, footprints = null, modelHoles = []){
  const ref = (site?.ref || []).filter(r => r.m && r.px);
  const mode = site.mode === 'affine' && ref.length >= 3 ? 'affine' : 'similarity';
  if (ref.length < 2) return null;
  let T;
  if (site.fixed) T = site.fixed;      // 이미 정한 변환 (모양 보정 뒤 검증용)
  else if (mode === 'similarity') {         // 복소수 최소제곱: z = c·w + t
    const n = ref.length, mw = [0, 0], mz = [0, 0];
    for (const r of ref) { mw[0] += r.m[0] / n; mw[1] += r.m[1] / n; mz[0] += r.px[0] / n; mz[1] += r.px[1] / n; }
    let a = 0, b = 0, den = 0;
    for (const r of ref) { const wx = r.m[0] - mw[0], wy = r.m[1] - mw[1], zx = r.px[0] - mz[0], zy = r.px[1] - mz[1]; a += zx * wx + zy * wy; b += zy * wx - zx * wy; den += wx * wx + wy * wy; }
    a /= den; b /= den;
    T = [a, -b, mz[0] - a * mw[0] + b * mw[1], b, a, mz[1] - b * mw[0] - a * mw[1]];
  } else {                             // 최소제곱 아핀: [x y 1]·p = u, v
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bu = [0, 0, 0], bv = [0, 0, 0];
    for (const r of ref) { const v = [r.m[0], r.m[1], 1]; for (let i = 0; i < 3; i++) { bu[i] += v[i] * r.px[0]; bv[i] += v[i] * r.px[1]; for (let j = 0; j < 3; j++) A[i][j] += v[i] * v[j]; } }
    const solve = (M, y) => { const a = M.map((row, i) => [...row, y[i]]);
      for (let c = 0; c < 3; c++) { let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r; [a[c], a[p]] = [a[p], a[c]];
        for (let r = 0; r < 3; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k]; } }
      return a.map((row, i) => row[3] / row[i]); };
    const pu = solve(A, bu), pv = solve(A, bv); T = [...pu, ...pv];
  }
  const toImg = ([x, y]) => [T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5]];
  const det = T[0] * T[4] - T[1] * T[3], pxPerM = Math.sqrt(Math.abs(det));
  // 도면 위쪽(−y)이 사진에서 가리키는 방향 → 방위각 (사진은 북쪽이 위)
  const northDeg = ((Math.atan2(-T[1], T[4]) * 180 / Math.PI) + 360) % 360;
  const res = ref.map(r => { const q = toImg(r.m); return Math.hypot(q[0] - r.px[0], q[1] - r.px[1]) / pxPerM; });
  const rms = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length);
  // 축 방향별 축척 (아핀이면 가로·세로가 다를 수 있음 → 안내도 비율 오차)
  const sx = Math.hypot(T[0], T[3]), sy = Math.hypot(T[1], T[4]);
  const out = { image:site.image.split('/').pop(), size:site.size, mode, toImage:T.map(v => Math.round(v * 1e6) / 1e6), northDeg:Math.round(northDeg * 10) / 10,
    pxPerM:Math.round(pxPerM * 1000) / 1000, residualM:Math.round(rms * 100) / 100, aspect:Math.round(sx / sy * 1000) / 1000 };
  if (site.mPerPx) {                    // 사진 축척을 잰 값이 있으면: 도면 크기가 맞는지 확인
    out.mPerPx = site.mPerPx; out.sizeRatioX = Math.round(sx * site.mPerPx * 1000) / 1000; out.sizeRatioY = Math.round(sy * site.mPerPx * 1000) / 1000;
  }
  // 모양 검증: 사람이 스카이뷰에서 딴 지붕 윤곽(site.outline, px)을 도면 m로 되돌려 층 윤곽 합집합과 비교
  //   site.holes: 지붕에 뚫린 중정(px) · modelHoles: 도면의 중정(m)
  const toM = ([u, v]) => [(T[4] * (u - T[2]) - T[1] * (v - T[5])) / det, (T[0] * (v - T[5]) - T[3] * (u - T[2])) / det];
  if (site.outline?.length >= 3 && footprints?.length) out.check = shapeCheck(site.outline.map(toM), footprints, { photoHoles:(site.holes || []).map(h => h.map(toM)), modelHoles });
  return out;
}
const segDist = (x, y, [ax, ay], [bx, by]) => { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(x - ax - t * dx, y - ay - t * dy); };
const polyDist = (x, y, p) => Math.min(...p.map((q, i) => segDist(x, y, q, p[(i + 1) % p.length])));
const boundary = (p, step) => p.flatMap((a, i) => { const b = p[(i + 1) % p.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); return [...Array(n)].map((_, k) => [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); });
/* 사진 윤곽 vs 도면 윤곽 (0.5 m 격자)
   iou: 겹친 넓이 / 합친 넓이 · areaRatio: 도면 넓이 / 사진 넓이 · meanEdgeM / maxEdgeM: 두 경계선 사이 거리(양방향 평균·최대)
   onlyModel / onlyPhoto: 한쪽에만 있는 넓이 (어디가 다른지 보는 실마리) */
export function shapeCheck(photo, footprints, { photoHoles = [], modelHoles = [], cell = .5 } = {}){
  const all = [photo, ...footprints].flat(), x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(...all.map(p => p[0])), y0 = Math.min(...all.map(p => p[1])), y1 = Math.max(...all.map(p => p[1]));
  let both = 0, onlyM = 0, onlyP = 0;
  for (let y = y0 + cell / 2; y < y1; y += cell) for (let x = x0 + cell / 2; x < x1; x += cell) {
    const m = footprints.some(f => inPoly(x, y, f)) && !modelHoles.some(h => inPoly(x, y, h)), p = inPoly(x, y, photo) && !photoHoles.some(h => inPoly(x, y, h));
    if (m && p) both++; else if (m) onlyM++; else if (p) onlyP++;
  }
  const a = cell * cell, r = (v, k = 100) => Math.round(v * k) / k;
  const mEdges = [...footprints, ...modelHoles], pEdges = [photo, ...photoHoles];
  const dA = pEdges.flatMap(q => boundary(q, 1)).map(([x, y]) => Math.min(...mEdges.map(f => polyDist(x, y, f))));
  const dB = mEdges.flatMap(f => boundary(f, 1)).map(([x, y]) => Math.min(...pEdges.map(q => polyDist(x, y, q))));
  const d = [...dA, ...dB];
  return { iou:r(both / (both + onlyM + onlyP), 1000), areaRatio:r((both + onlyM) / (both + onlyP), 1000), modelM2:Math.round((both + onlyM) * a), photoM2:Math.round((both + onlyP) * a),
    onlyModelM2:Math.round(onlyM * a), onlyPhotoM2:Math.round(onlyP * a), meanEdgeM:r(d.reduce((s, v) => s + v, 0) / d.length, 10), maxEdgeM:r(Math.max(...d), 10), photoOutlineM:photo.map(([x, y]) => [r(x, 10), r(y, 10)]), ...(photoHoles.length ? { photoHolesM:photoHoles.map(h => h.map(([x, y]) => [r(x, 10), r(y, 10)])) } : {}) };
}

/* ── 스카이뷰 지붕 윤곽에 도면 맞추기 (모양 보정) ──
   안내도·손 그림처럼 비율이 어긋난 도면을 실제 지붕 모양에 맞게 부드럽게 휜다.
   방법: 비강체 ICP + 박판 스플라인(TPS)
     1) 위에서 본 도면 윤곽(층 윤곽 합집합의 경계)을 일정 간격으로 찍은 점 = 조절점
     2) 조절점마다 사진 윤곽의 가장 가까운 점(정방향) + 그 조절점을 가장 가깝게 고른 사진 윤곽 점들(역방향)의 평균 → 목표
     3) 조절점 → 목표로 TPS를 맞춤. 처음엔 거의 아핀(단단하게), 반복하며 조금씩 유연하게(λ 감소)
     4) 접힘 검사: 도면 전체 격자에서 변형의 야코비안이 minJacobian 아래로 떨어지면 직전 단계에서 멈춤
   실·층 윤곽·실내기·중정은 모두 같은 변형을 받으므로 서로 어긋나지 않는다.
   적용 조건: 평균 경계 차가 minEdgeM(1.5m)보다 크고(그 이하는 사진 오차로 봄), 보정이 IoU를 minGain(0.01) 이상 올릴 때.
   설정은 레시피 site.fit으로 바꾼다 (예: { enabled:false } 끄기, { holes:true } 중정도 맞추기). */
export const SHAPE_FIT = { enabled:true, holes:false, spacing:null, lambda0:1, lambdaMin:.002, iters:24, minJacobian:.15, minGain:.01, minEdgeM:1.5 };
const tpsPhi = r => r < 1e-9 ? 0 : r * r * Math.log(r);
function solveLin(M, Y){              // 가우스 소거 (M: n×n, Y: n×k)
  const n = M.length, k = Y[0].length, a = M.map((row, i) => [...row, ...Y[i]]);
  for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r; [a[c], a[p]] = [a[p], a[c]];
    const piv = a[c][c] || 1e-12; for (let r = c + 1; r < n; r++) { const f = a[r][c] / piv; if (f) for (let q = c; q < n + k; q++) a[r][q] -= f * a[c][q]; } }
  const X = Array.from({ length:n }, () => Array(k).fill(0));
  for (let r = n - 1; r >= 0; r--) for (let j = 0; j < k; j++) { let v = a[r][n + j]; for (let q = r + 1; q < n; q++) v -= a[r][q] * X[q][j]; X[r][j] = v / (a[r][r] || 1e-12); }
  return X;
}
function tpsFit(src, dst, lambda){    // 정규화 좌표에서
  const n = src.length, N = n + 3, M = Array.from({ length:N }, () => Array(N).fill(0)), Y = Array.from({ length:N }, () => [0, 0]);
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) M[i][j] = tpsPhi(Math.hypot(src[i][0] - src[j][0], src[i][1] - src[j][1])) + (i === j ? lambda : 0);
    M[i][n] = M[n][i] = 1; M[i][n + 1] = M[n + 1][i] = src[i][0]; M[i][n + 2] = M[n + 2][i] = src[i][1]; Y[i] = [dst[i][0], dst[i][1]]; }
  const X = solveLin(M, Y);
  return { ctrl:src, w:X.slice(0, n), a:X.slice(n) };
}
const tpsAt = (t, [x, y]) => { let u = t.a[0][0] + t.a[1][0] * x + t.a[2][0] * y, v = t.a[0][1] + t.a[1][1] * x + t.a[2][1] * y;
  for (let i = 0; i < t.ctrl.length; i++) { const f = tpsPhi(Math.hypot(x - t.ctrl[i][0], y - t.ctrl[i][1])); u += t.w[i][0] * f; v += t.w[i][1] * f; } return [u, v]; };
// building.json의 site.warp로 점 옮기기: 도면(레시피) 좌표 → 보정된 좌표, 그리고 그 반대
export function warpPoint(W, p){
  if (!W) return p;
  const { c, L } = W.norm, q = tpsAt(W, [(p[0] - c[0]) / L, (p[1] - c[1]) / L]);
  return [q[0] * L + c[0] - W.shift[0], q[1] * L + c[1] - W.shift[1]];
}
export function unwarpPoint(W, p){    // 뉴턴 반복 (변형이 부드러워 몇 번이면 수렴)
  if (!W) return p;
  let x = [p[0] + W.shift[0], p[1] + W.shift[1]];
  for (let it = 0; it < 30; it++) { const f = warpPoint(W, x), ex = f[0] - p[0], ey = f[1] - p[1]; if (Math.hypot(ex, ey) < 1e-4) break;
    const h = .05, fx = warpPoint(W, [x[0] + h, x[1]]), fy = warpPoint(W, [x[0], x[1] + h]);
    const a = (fx[0] - f[0]) / h, b = (fy[0] - f[0]) / h, cc = (fx[1] - f[1]) / h, d = (fy[1] - f[1]) / h, det = a * d - b * cc || 1;
    x = [x[0] - (d * ex - b * ey) / det, x[1] - (a * ey - cc * ex) / det]; }
  return x;
}
// 위에서 본 윤곽(층 윤곽 합집합)의 경계 위 점들
function unionBoundary(polys, step){
  const inside = (x, y) => polys.some(f => inPoly(x, y, f)), pts = [], seen = new Set();
  for (const f of polys) for (const [x, y] of boundary(f, step)) {
    // 경계 위 점: 주변 0.3m 원 위 8점 중 일부만 안쪽이면 합집합 경계
    let ins = 0; for (let k = 0; k < 8; k++) if (inside(x + .3 * Math.cos(k * Math.PI / 4), y + .3 * Math.sin(k * Math.PI / 4))) ins++;
    if (ins === 0 || ins === 8) continue;
    const key = `${Math.round(x / step * 2)},${Math.round(y / step * 2)}`; if (seen.has(key)) continue; seen.add(key); pts.push([x, y]);
  }
  return pts;
}
export function fitShape(modelPolys, photoPolys, opt = {}){
  const O = { ...SHAPE_FIT, ...opt };
  const all = modelPolys.flat(), xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2], L = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  const nrm = ([x, y]) => [(x - c[0]) / L, (y - c[1]) / L];
  const perim = modelPolys.reduce((t, p) => t + p.reduce((s, q, i) => s + Math.hypot(p[(i + 1) % p.length][0] - q[0], p[(i + 1) % p.length][1] - q[1]), 0), 0);
  const step = O.spacing || Math.max(1, perim / 160);
  const src = unionBoundary(modelPolys, step).map(nrm), photo = photoPolys.map(p => p.map(nrm)), photoPts = photoPolys.flatMap(p => boundary(p, step)).map(nrm);
  if (src.length < 6) return null;
  // 격자 (접힘 검사용): 도면 범위
  const grid = []; for (let j = 0; j <= 16; j++) for (let i = 0; i <= 16; i++) { const g = nrm([Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * i / 16, Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * j / 16]); if (modelPolys.some(f => inPoly(g[0] * L + c[0], g[1] * L + c[1], f))) grid.push(g); }
  const minJac = t => { let m = Infinity; const h = 1e-3; for (const g of grid) { const f = tpsAt(t, g), fx = tpsAt(t, [g[0] + h, g[1]]), fy = tpsAt(t, [g[0], g[1] + h]);
    m = Math.min(m, ((fx[0] - f[0]) * (fy[1] - f[1]) - (fy[0] - f[0]) * (fx[1] - f[1])) / (h * h)); } return m; };
  let tps = { ctrl:src, w:src.map(() => [0, 0]), a:[[0, 0], [1, 0], [0, 1]] }, lambda = O.lambda0, iters = 0;
  const decay = Math.pow(O.lambdaMin / O.lambda0, 1 / Math.max(1, O.iters - 1));
  for (let it = 0; it < O.iters; it++, lambda *= decay) {
    const cur = src.map(p => tpsAt(tps, p));
    const tgt = cur.map(q => { let best = null, bd = Infinity; for (const P of photo) P.forEach((a, i) => { const b = P[(i + 1) % P.length], d = segDist(q[0], q[1], a, b);
      if (d < bd) { bd = d; const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); best = [a[0] + t * dx, a[1] + t * dy]; } }); return { sum:[...best], n:1 }; });
    for (const p of photoPts) { let bi = 0, bd = Infinity; cur.forEach((q, i) => { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (d < bd) { bd = d; bi = i; } }); tgt[bi].sum[0] += p[0]; tgt[bi].sum[1] += p[1]; tgt[bi].n++; }
    const next = tpsFit(src, tgt.map(t => [t.sum[0] / t.n, t.sum[1] / t.n]), lambda);
    if (minJac(next) < O.minJacobian) break;
    tps = next; iters = it + 1;
  }
  const round = v => Math.round(v * 1e6) / 1e6;
  return { method:'nonrigid-ICP + thin-plate spline', iters, lambda:round(lambda), controlPoints:src.length, norm:{ c:c.map(v => round(v)), L:round(L) },
    ctrl:tps.ctrl.map(p => p.map(round)), w:tps.w.map(p => p.map(round)), a:tps.a.map(p => p.map(round)), minJacobian:Math.round(minJac(tps) * 100) / 100, shift:[0, 0] };
}
// 다각형 휘기: 2m 간격으로 점을 더해 옮긴 뒤 거의 일직선인 점은 다시 뺌 (긴 벽이 휘어도 이웃 실과 경계가 맞게)
function warpPoly(Wp, poly, step = 2, tol = .03){
  const dense = [];
  poly.forEach((a, i) => { const b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) dense.push({ p:warpPoint(Wp, [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]), orig:k === 0 }); });
  const n = dense.length, keep = dense.filter((d, i) => d.orig || segDist(d.p[0], d.p[1], dense[(i - 1 + n) % n].p, dense[(i + 1) % n].p) > tol);
  const out = []; for (const p of keep.map(d => [r2(d.p[0]), r2(d.p[1])])) { const l = out[out.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p); }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}
export function applyWarp(Wp, floors, idus, extra){
  for (const f of floors) {
    for (const key of ['footprint', 'shellFootprint', 'topFootprint']) {
      const footprint = f[key];
      if (footprint?.length) f[key] = Array.isArray(footprint[0][0]) ? footprint.map(loop => warpPoly(Wp, loop)) : warpPoly(Wp, footprint);
    }
    for (const r of f.rooms) { r.polygon = warpPoly(Wp, r.polygon); if (r.holes) r.holes = r.holes.map(h => warpPoly(Wp, h)); }
  }
  for (const a of idus) { const q = warpPoint(Wp, a.pos); a.pos = [r2(q[0]), r2(q[1])]; }
  for (const k in extra) { const b = extra[k]; if (!b) continue; const q = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(p => warpPoint(Wp, p));
    extra[k] = { x0:r2(Math.min(...q.map(p => p[0]))), y0:r2(Math.min(...q.map(p => p[1]))), x1:r2(Math.max(...q.map(p => p[0]))), y1:r2(Math.max(...q.map(p => p[1]))) }; }
}

// 와이파이 AP 위치 → 도면 좌표·소속 방 (레시피 wifi: 와이파이 지도 이미지에서 찍은 AP 위치 u,v ∈ [0,1])
//   orient: 지도와 도면의 방향 관계 'same' | 'rot90'(지도 오른쪽 = 도면 위쪽) | 'rot-90' | 'rot180'
//   bounds: 지도 이미지 안에서 건물 외곽이 차지하는 범위 [u0, v0, u1, v1]
//   AP가 복도·화장실에 있으면 같은 층의 가장 가까운 방(실)도 같이 적어 둔다 (접속자 나눌 때 씀)
export function placeAps(wifi, floors, W, D){
  if (!wifi?.floors) return { aps:[], warn:[] };
  const aps = [], warn = [];
  const map = (u, v, o) => o === 'rot90' ? [v * W, (1 - u) * D] : o === 'rot-90' ? [(1 - v) * W, u * D] : o === 'rot180' ? [(1 - u) * W, (1 - v) * D] : [u * W, v * D];
  const cen = p => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  for (const [fid, fw] of Object.entries(wifi.floors)) {
    const f = floors.find(x => x.id === fid); if (!f) { warn.push(`와이파이: 층 ${fid}가 도면에 없음`); continue; }
    const [u0, v0, u1, v1] = fw.bounds || wifi.bounds || [0, 0, 1, 1], o = fw.orient || wifi.orient || 'same';
    for (const a of fw.aps || []) {
      const [x, y] = map((a.u - u0) / (u1 - u0), (a.v - v0) / (v1 - v0), o), pos = [r2(x), r2(y)];
      const inside = f.rooms.find(r => inPoly(x, y, r.polygon));
      const near = f.rooms.filter(r => r.type === 'room').map(r => { const c = cen(r.polygon); return { r, d:Math.hypot(c[0] - x, c[1] - y) }; }).sort((p, q) => p.d - q.d)[0]?.r;
      const room = inside?.type === 'room' ? inside : near;
      aps.push({ id:a.id, floor:fid, pos, room:room?.id || null, ...(inside && inside.type !== 'room' ? { in:inside.id } : {}), ...(a.band ? { band:a.band } : {}) });
    }
  }
  return { aps, warn };
}

export function assemble(recipe, floorResults){
  const B = recipe.building, W = B.size.w, D = B.size.d, warn = [];
  const metas = { atrium:[], elevator:[] };
  const floors = recipe.floors.map((f, i) => {
    const fr = floorResults[f.id]; warn.push(...fr.warn.map(m => `${f.id}: ${m}`));
    for (const k in metas) if (fr.meta[k]) metas[k].push(fr.meta[k]);
    const out = { id:f.id, level:i + 1, atrium:!!fr.meta.atrium, rooms:fr.rooms };
    if (f.footprint) out.footprint = f.footprint;
    for (const k of ['shellFootprint', 'topFootprint', 'open', 'green', 'below']) if (f[k] != null) out[k] = f[k];
    if (f.note) out.note = f.note;
    // 자동 추정 공간은 안내 없이 표시(2026-11-21 사용자 요청), 공간을 못 찾은 층만 윤곽 안내
    else if (f.autoSpaces && !fr.rooms.some(room => room.type === 'room')) out.note = '닫힌 공간을 인식하지 못해 층 윤곽만 표시합니다.';
    return out;
  });
  // 중정·엘리베이터는 건물 전체에 하나: 층마다 찾은 사각형의 좌표별 중앙값 (한 층 사진이 기울어도 흔들리지 않음)
  const med = list => { if (!list.length) return null; const m = k => { const v = list.map(b => b[k]).sort((a, b) => a - b); return v.length % 2 ? v[v.length >> 1] : r2((v[v.length / 2 - 1] + v[v.length / 2]) / 2); }; return { x0:m('x0'), y0:m('y0'), x1:m('x1'), y1:m('y1') }; };
  const atrium = med(metas.atrium), elevator = med(metas.elevator);
  // 내부 사진 마감색: 방 지정 > 용도 지정
  const finishOf = r => {
    const out = {};
    for (const p of recipe.interior || []) {
      const hit = p.room ? p.room === r.id : p.use && p.use === r.use;
      if (!hit) continue;
      if (p.floor && (!out.floor || p.room)) out.floor = p.floor;
      if (p.wall && (!out.wall || p.room)) out.wall = p.wall;
    }
    return Object.keys(out).length ? out : null;
  };
  // 사람이 결과 화면에서 고친 실 속성 (레시피 overrides.rooms에 남음 → 다시 돌려도 같은 결과)
  const ov = recipe.overrides?.rooms || {};
  for (const f of floors) for (const r of f.rooms) { const o = ov[r.id]; if (!o) continue;
    for (const k of ['name', 'type', 'use', 'capacity']) if (o[k] != null && o[k] !== '') r[k] = k === 'capacity' ? +o[k] : o[k];
    if (r.type === 'room') { r.use ||= 'office'; r.capacity ??= 0; r.number ??= r.id.split('-').slice(1).join('-'); } else { delete r.use; delete r.capacity; delete r.number; } }
  for (const id in ov) if (!floors.some(f => f.rooms.some(r => r.id === id))) warn.push(`수정 기록의 실 ${id}가 도면에 없음`);
  for (const f of floors) for (const r of f.rooms) if (r.type === 'room') { const fin = finishOf(r); if (fin) r.finish = fin; }
  // 실내기 대수: 에어컨 사진에서 찍은 점
  const acCounts = {};
  for (const p of recipe.acPhotos || []) for (const m of p.marks || []) { const c = acCounts[p.room] ||= { units:[], photos:[] }; c.units.push(m.kind || '4WAY'); if (!c.photos.includes(p.file)) c.photos.push(p.file); }
  for (const id in acCounts) if (!floors.some(f => f.rooms.some(r => r.id === id))) warn.push(`에어컨 사진의 방 ${id}가 도면에 없음`);
  const explicit = Object.fromEntries(recipe.floors.map(f => [f.id, (f.ops || []).filter(o => o.op === 'idu')]));
  const predicted = readPredictions(recipe.acModel?.result);
  const { idus, odus, warn:w2 } = placeIdus(floors, { counts:acCounts, explicit, predicted, model:recipe.acModel || {} }, W);
  warn.push(...w2);
  const zoned = splitZones(floors, idus, W, D, recipe.zoning);      // 큰 공간 → 공조 구역
  const ext = recipe.exterior || {};
  const building = { id:B.id, name:B.name, size:{ w:W, d:D }, floorHeight:ext.floorHeight || B.floorHeight, ceiling:B.ceiling };
  if (ext.window) building.window = ext.window;
  if (ext.facade) building.facade = ext.facade;
  if (B.assumed) building.assumed = B.assumed;              // 확인 전 가정값 (예: 건축물대장 미확인 크기)
  let site = null, Wout = W, Dout = D, at2 = atrium, el2 = elevator;
  const planFloors = JSON.parse(JSON.stringify(floors));      // 보정 전(레시피 좌표) — 모델 입력·사람 수정은 이 좌표를 쓴다
  if (recipe.site?.image) {                                 // 스카이뷰: 방위·모양 검증 + 모양 보정 (화면에 사진은 깔지 않음)
    // 위에서 본 건물 윤곽 = 층 윤곽의 합집합 (층 윤곽이 없으면 건물 외곽 사각형)
    const fps = floors.flatMap(f => !f.footprint?.length ? [[[0, 0], [W, 0], [W, D], [0, D]]] : Array.isArray(f.footprint[0]?.[0]) ? f.footprint : [f.footprint]);   // 떨어진 동은 고리마다
    const at = atrium && floors.some(f => f.atrium) ? [[[atrium.x0, atrium.y0], [atrium.x1, atrium.y0], [atrium.x1, atrium.y1], [atrium.x0, atrium.y1]]] : [];
    site = siteFit(recipe.site, W, D, fps, at);
    if (!site) warn.push('스카이뷰 기준점이 2개 미만 — 방위를 정할 수 없음');
    const fitOpt = { ...SHAPE_FIT, ...(recipe.site.fit || {}) };
    // 평균 경계 차가 minEdgeM(기본 1.5m) 이하면 사진 오차(비스듬한 촬영·지붕 처마·점 찍기) 안이므로 도면을 믿고 휘지 않는다
    if (site?.check && fitOpt.enabled && site.check.meanEdgeM <= fitOpt.minEdgeM) site.fitSkipped = `평균 경계 차 ${site.check.meanEdgeM}m ≤ ${fitOpt.minEdgeM}m — 사진 오차 범위라 도면 그대로 씀`;
    else if (site?.check && fitOpt.enabled) {
      const photo = [site.check.photoOutlineM, ...(fitOpt.holes ? site.check.photoHolesM || [] : [])];
      const model = fitOpt.holes ? [...fps, ...at] : fps;
      const Wp = fitShape(model, photo, fitOpt);
      if (Wp) {
        // 휜 뒤 도면 원점(0,0)을 다시 왼쪽 위로: 이동량 = 휜 윤곽의 최솟값
        const wf = fps.flatMap(f => boundary(f, 2)).map(p => warpPoint(Wp, p)), mx = Math.min(...wf.map(p => p[0])), my = Math.min(...wf.map(p => p[1]));
        Wp.shift = [Math.round(mx * 1000) / 1000, Math.round(my * 1000) / 1000];
        const fps2 = fps.map(f => warpPoly(Wp, f)), at3 = at.map(h => warpPoly(Wp, h));
        const W2 = r2(Math.max(...wf.map(p => p[0])) - mx), D2 = r2(Math.max(...wf.map(p => p[1])) - my);
        // 사진 좌표계는 그대로(보정은 그 좌표계로 휘는 것) — 원점 이동만 반영: toImage(x) = T(x + shift)
        const T = site.toImage, [sx, sy] = Wp.shift, T2 = [T[0], T[1], T[2] + T[0] * sx + T[1] * sy, T[3], T[4], T[5] + T[3] * sx + T[4] * sy];
        const ref2 = recipe.site.ref.map(r => ({ ...r, m:warpPoint(Wp, r.m) }));
        const site2 = siteFit({ ...recipe.site, ref:ref2, fixed:T2 }, W2, D2, fps2, at3);
        const gain = site2?.check ? site2.check.iou - site.check.iou : -1;
        if (gain >= fitOpt.minGain) {
          for (const f of floors) if (!f.footprint?.length) f.footprint = [[0, 0], [W, 0], [W, D], [0, D]];
          const ex = { atrium, elevator }; applyWarp(Wp, floors, idus, ex); at2 = ex.atrium; el2 = ex.elevator;
          const before = { iou:site.check.iou, areaRatio:site.check.areaRatio, meanEdgeM:site.check.meanEdgeM, maxEdgeM:site.check.maxEdgeM, residualM:site.residualM, size:{ w:W, d:D } };
          site = { ...site2, checkBefore:before, warp:Wp };
          Wout = W2; Dout = D2;
          warn.push(`스카이뷰 모양 보정 적용: IoU ${before.iou} → ${site2.check.iou} · 평균 경계 차 ${before.meanEdgeM} → ${site2.check.meanEdgeM}m · 크기 ${W}×${D} → ${W2}×${D2}m`);
        } else site.fitSkipped = `보정해도 IoU가 ${gain >= 0 ? '+' : ''}${Math.round(gain * 1000) / 1000}밖에 안 올라 적용 안 함`;
      }
    }
    if (site) {
      if (site.residualM > 3) warn.push(`스카이뷰 맞춤 오차 ${site.residualM}m — 기준점 확인`);
      const c = site.check;
      if (c && c.iou < .8) warn.push(`스카이뷰 모양 일치도 IoU ${c.iou} (평균 경계 차 ${c.meanEdgeM}m) — 도면 윤곽 확인 필요`);
      if (c && Math.abs(c.areaRatio - 1) > .15) warn.push(`스카이뷰 지붕 넓이 대비 도면 넓이 ${Math.round(c.areaRatio * 100)}%`);
      if (site.mode === 'similarity' && site.sizeRatioX && Math.abs(site.sizeRatioX - 1) > .1) warn.push(`스카이뷰 축척으로 보면 도면 크기가 ${Math.round((site.sizeRatioX - 1) * 100)}% 다름`);
    }
  }
  building.size = { w:Wout, d:Dout };
  // 와이파이 AP: 도면 좌표로 놓은 뒤 모양 보정이 있으면 같이 옮기고, 소속 방은 보정 후 방으로 다시 찾는다
  const ap = placeAps(recipe.wifi, planFloors, W, D); warn.push(...ap.warn);
  if (site?.warp) for (const a of ap.aps) { const q = warpPoint(site.warp, a.pos); a.pos = [r2(q[0]), r2(q[1])]; }
  const open = !atrium && !elevator;                  // 중정·코어 라벨이 둘 다 없으면 일반형 건물 (트윈이 일반형으로 그림)
  if (!open && !atrium) warn.push('중정(atrium) 라벨이 없음');
  if (!open && !elevator) warn.push('엘리베이터 라벨이 없음');
  return {
    json:{ schema:'twin.building/v1', appearance:{}, source:`자료→렌더링 파이프라인 (레시피 ${recipe.id || ''}): 평면도 ${recipe.floors.map(f => f.image || '수동').join(', ')}`,
      building, ...(site ? { site } : {}), ...(open ? {} : { atrium:at2 || { x0:Wout / 2 - 1, y0:Dout / 2 - 1, x1:Wout / 2 + 1, y1:Dout / 2 + 1 }, elevator:el2 || { x0:0, y0:0, x1:0, y1:0 } }),
      operation:recipe.operation || { source:'BMS 운영 스케줄 설정', weekday:['08:00', '21:00'], weekend:null }, floors, odus, idus, ...(ap.aps.length ? { aps:ap.aps, wifi:{ devicesPerPerson:recipe.wifi.devicesPerPerson ?? 1.3, source:'와이파이 지도(AP 위치) → 접속 기기 수로 재실 추정' } } : {}) },
    warn,
    zones:zoned,
    planFloors,
    stats:{ rooms:floors.reduce((s, f) => s + f.rooms.filter(r => r.type === 'room').length, 0), idus:idus.length, aps:ap.aps.length,
      ...Object.fromEntries(['plan', 'model', 'photo', 'estimate'].map(k => [k, idus.filter(a => a.source === k).length])), fromPhoto:idus.filter(a => a.source === 'photo').length },
  };
}
