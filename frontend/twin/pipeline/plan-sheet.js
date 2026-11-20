/* 평면도 '종이' 분석 — 캡처·스캔한 도면 한 장에서 건물 덩어리만 찾고, 층끼리 위치·축척을 맞춘다

   왜: 사용자가 올리는 도면은 화면 캡처(회색 테두리·"4층 설계도" 같은 설명), 도면 틀·표제란, 제목 글자, 축척 막대,
       치수선·통심선, 주변 대지(등고선·도로) 선이 함께 들어 있다. 이미지 전체나 바깥 테두리를 건물로 보면 모든 층이 상자가 된다.

   1) 잉크 밀도: 작게 줄인(상자 평균) 회색 영상에서 어두운 정도 → 창 안 평균 = 밀도
      건물은 벽·해치가 빽빽해 밀도가 높고, 치수선·등고선·글자·도면 틀은 가늘고 성겨서 낮다
   2) 밀도 문턱 → 닫힘(틈 메움) → 바깥에서 채우기(구멍 메움: 중정·홀처럼 선으로 둘러싸인 빈 곳은 건물 안)
      → 열림(가는 띠 제거: 표제란 글자 줄, 치수선 다발) → 덩어리
   3) 덩어리 고르기: 가장 큰 것의 8% 이상, 너무 납작한(글자 줄) 것 제외
   4) 윤곽 추적 → 단순화 → 수평·수직 맞춤 → 짧은 계단·턱 제거 (원본 px 좌표)

   층 맞추기(alignSheets): 같은 도면 세트는 보통 같은 축척으로 내보내므로 '같은 px 축척'을 기본으로 보고
   기준층 덩어리와 겹침(IoU)이 가장 큰 평행 이동을 찾는다. 덩어리 크기가 2배 넘게 다르면(확대 캡처) 축척도 찾는다. */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function downscale(image, maxSide) {
  const s = Math.min(1, maxSide / Math.max(image.width, image.height));
  const w = Math.max(8, Math.round(image.width * s)), h = Math.max(8, Math.round(image.height * s));
  const dark = new Float32Array(w * h), rx = image.width / w, ry = image.height / h, d = image.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * rx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * rx)), y0 = Math.floor(y * ry), y1 = Math.max(y0 + 1, Math.floor((y + 1) * ry));
    let t = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const o = (yy * image.width + xx) * 4, a = d[o + 3] / 255;
      const L = 255 * (1 - a) + a * (.299 * d[o] + .587 * d[o + 1] + .114 * d[o + 2]);
      t += clamp((235 - L) / 175, 0, 1); n++;            // 235 이상 = 종이(0), 60 이하 = 먹(1)
    }
    dark[y * w + x] = t / n;
  }
  return { w, h, dark, sx:image.width / w, sy:image.height / h };
}

// 정사각 창 평균 (적분 영상)
function boxMean(src, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += src[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = Math.max(0, x - r), b = Math.max(0, y - r), c = Math.min(w, x + r + 1), e = Math.min(h, y + r + 1);
    out[y * w + x] = (I[e * (w + 1) + c] - I[b * (w + 1) + c] - I[e * (w + 1) + a] + I[b * (w + 1) + a]) / ((c - a) * (e - b));
  }
  return out;
}
// 이진 팽창/침식 (원형에 가까운 체비셰프+맨해튼 섞은 거리: 8방향 챔퍼)
// square = true: 체비셰프 거리(정사각 커널) → 직교 모서리가 둥글게 깎이지 않음
function chamfer(mask, w, h, inside, square = false) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) d[p] = (mask[p] === 1) === inside ? INF : 0;
  const A = 1, B = square ? 1 : 1.4142;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = y * w + x; if (!d[p]) continue; let v = d[p];
    if (x) v = Math.min(v, d[p - 1] + A); if (y) { v = Math.min(v, d[p - w] + A); if (x) v = Math.min(v, d[p - w - 1] + B); if (x < w - 1) v = Math.min(v, d[p - w + 1] + B); } d[p] = v; }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const p = y * w + x; if (!d[p]) continue; let v = d[p];
    if (x < w - 1) v = Math.min(v, d[p + 1] + A); if (y < h - 1) { v = Math.min(v, d[p + w] + A); if (x < w - 1) v = Math.min(v, d[p + w + 1] + B); if (x) v = Math.min(v, d[p + w - 1] + B); } d[p] = v; }
  return d;
}
const dilate = (m, w, h, r, sq) => { const d = chamfer(m, w, h, false, sq); return Uint8Array.from(d, v => v <= r ? 1 : 0); };
const erode = (m, w, h, r, sq) => { const d = chamfer(m, w, h, true, sq); return Uint8Array.from(d, v => v > r ? 1 : 0); };
function fillHoles(m, w, h) {
  const out = new Uint8Array(w * h).fill(1), st = [];
  const push = p => { if (!m[p] && out[p]) { out[p] = 0; st.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (st.length) { const p = st.pop(), x = p % w, y = (p - x) / w;
    if (x) push(p - 1); if (x < w - 1) push(p + 1); if (y) push(p - w); if (y < h - 1) push(p + w); }
  return out;
}
function components(m, w, h) {
  const lab = new Int32Array(w * h).fill(-1), comps = [];
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    const id = comps.length, st = [s]; lab[s] = id; let n = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (st.length) { const p = st.pop(), x = p % w, y = (p - x) / w; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [x ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && m[q] && lab[q] < 0) { lab[q] = id; st.push(q); } }
    comps.push({ id, n, x0, y0, x1, y1 });
  }
  return { lab, comps };
}
// 무어 이웃 윤곽 추적 (덩어리 바깥 경계)
function trace(lab, id, w, h, c) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === id;
  let sx = -1, sy = c.y0; for (let x = c.x0; x <= c.x1; x++) if (at(x, sy)) { sx = x; break; }
  const D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const pts = [[sx, sy]]; let x = sx, y = sy, dir = 6;
  for (let k = 0; k < 4 * (w + h) * 4; k++) {
    let found = false;
    for (let i = 0; i < 8; i++) { const nd = (dir + 6 + i) % 8, nx = x + D[nd][0], ny = y + D[nd][1];
      if (at(nx, ny)) { x = nx; y = ny; dir = nd; found = true; break; } }
    if (!found || (x === sx && y === sy)) break;
    pts.push([x, y]);
  }
  return pts;
}
function simplify(pts, eps) {
  if (pts.length < 4) return pts;
  // 닫힌 고리: 가장 먼 두 점으로 나눠 각각 단순화
  let far = 0, fd = -1; for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  const dp = (a) => { if (a.length < 3) return a; const [x0, y0] = a[0], [x1, y1] = a[a.length - 1], L = Math.hypot(x1 - x0, y1 - y0) || 1;
    let m = -1, md = eps; for (let i = 1; i < a.length - 1; i++) { const d = Math.abs((x1 - x0) * (y0 - a[i][1]) - (x0 - a[i][0]) * (y1 - y0)) / L; if (d > md) { md = d; m = i; } }
    return m < 0 ? [a[0], a[a.length - 1]] : [...dp(a.slice(0, m + 1)).slice(0, -1), ...dp(a.slice(m))]; };
  return [...dp(pts.slice(0, far + 1)).slice(0, -1), ...dp([...pts.slice(far), pts[0]]).slice(0, -1)];
}
// 건물 외곽은 대부분 직교: 수평·수직에서 12° 안쪽인 변은 축에 맞추고, 한 직선 위의 점·겹친 점은 지움 (래스터 계단·물결 제거)
function orthogonalize(pts) {
  const p = pts.map(q => [...q]), n = p.length, tan = Math.tan(12 * Math.PI / 180);
  for (let i = 0; i < n; i++) { const a = p[i], b = p[(i + 1) % n], dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    if (dy <= dx * tan) a[1] = b[1] = (a[1] + b[1]) / 2; else if (dx <= dy * tan) a[0] = b[0] = (a[0] + b[0]) / 2; }
  let out = p;
  for (let pass = 0; pass < 2; pass++) out = out.filter((q, i, l) => { const a = l[(i - 1 + l.length) % l.length], b = l[(i + 1) % l.length];
    if (Math.hypot(q[0] - a[0], q[1] - a[1]) < 1e-6) return false;
    return Math.abs((q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0])) > 1e-6 * (1 + Math.hypot(b[0] - a[0], b[1] - a[1]) ** 2); });
  return out.length >= 3 ? out : pts;
}
// 짧은 꺾임(계단·턱) 없애기: 가장 짧은 변이 minEdge보다 짧으면
//   앞뒤 변이 평행(Z자 계단) → 두 변을 길이 가중 평균 위치의 한 직선으로, 평행 아님 → 앞뒤 변의 연장선 교점 하나로
function removeJogs(pts, minEdge) {
  let p = pts.map(q => [...q]);
  const len = i => Math.hypot(p[(i + 1) % p.length][0] - p[i][0], p[(i + 1) % p.length][1] - p[i][1]);
  for (let guard = 0; guard < pts.length * 3 && p.length > 4; guard++) {
    let i = -1, best = minEdge;
    for (let k = 0; k < p.length; k++) { const L = len(k); if (L < best) { best = L; i = k; } }
    if (i < 0) break;
    const n = p.length, A = p[(i - 1 + n) % n], B = p[i], C = p[(i + 1) % n], E = p[(i + 2) % n];
    const ux = B[0] - A[0], uy = B[1] - A[1], vx = E[0] - C[0], vy = E[1] - C[1], cr = ux * vy - uy * vx;
    const la = Math.hypot(ux, uy), lb = Math.hypot(vx, vy);
    if (Math.abs(cr) > .2 * la * lb) {               // 교점
      const t = ((C[0] - A[0]) * vy - (C[1] - A[1]) * vx) / cr, X = [A[0] + t * ux, A[1] + t * uy];
      if (Math.hypot(X[0] - (B[0] + C[0]) / 2, X[1] - (B[1] + C[1]) / 2) > 3 * minEdge) { p.splice(i, 1); continue; }
      p[i] = X; p.splice((i + 1) % n, 1);
    } else if (Math.abs(ux) >= Math.abs(uy)) {        // 수평 Z: y를 맞춤
      const Y = (la * (A[1] + B[1]) / 2 + lb * (C[1] + E[1]) / 2) / (la + lb || 1);
      A[1] = B[1] = C[1] = E[1] = Y;
    } else {                                          // 수직 Z: x를 맞춤
      const X = (la * (A[0] + B[0]) / 2 + lb * (C[0] + E[0]) / 2) / (la + lb || 1);
      A[0] = B[0] = C[0] = E[0] = X;
    }
    p = orthogonalize(p);
  }
  return p;
}
// 윤곽 정리 전체: 단순화 → 축 맞춤 → 짧은 꺾임 제거 → 축 맞춤
function cleanLoop(pts, eps, minEdge) {
  return orthogonalize(removeJogs(orthogonalize(simplify(pts, eps)), minEdge));
}
const polyArea = l => Math.abs(l.reduce((s, [x, y], i) => { const [u, v] = l[(i + 1) % l.length]; return s + x * v - y * u; }, 0)) / 2;

/* 한 장 분석. 반환 { loops:[[x,y]...](원본 px), box:{x0,y0,x1,y1}, mask:{w,h,data,sx,sy}, area, threshold }
   못 찾으면 null */
export function sheetSilhouette(image, opt = {}) {
  const S = opt.work ?? 420;
  const { w, h, dark, sx, sy } = downscale(image, S);
  const R = Math.max(w, h), rDen = Math.max(2, Math.round(R * .012));
  const den = boxMean(dark, w, h, rDen);
  const tries = [];
  for (const t of opt.thresholds ?? [.16, .11, .07, .045]) {
    let m = Uint8Array.from(den, v => v >= t ? 1 : 0);
    // 정사각 커널: 원형 커널은 직각 모서리를 둥글게 깎아 윤곽이 물결·사선 조각이 됨
    m = erode(dilate(m, w, h, R * .012, true), w, h, R * .012, true);           // 닫힘
    m = fillHoles(m, w, h);
    const ro = R * .022; m = dilate(erode(m, w, h, ro, true), w, h, ro, true);  // 열림 (가는 띠 제거)
    const { lab, comps } = components(m, w, h);
    const big = Math.max(0, ...comps.map(c => c.n));
    const keep = comps.filter(c => c.n >= big * .08 && c.n >= w * h * .004 && Math.max(c.x1 - c.x0, c.y1 - c.y0) / Math.max(1, Math.min(c.x1 - c.x0, c.y1 - c.y0)) < 7
      && !(c.x0 <= 0 && c.y0 <= 0 && c.x1 >= w - 1 && c.y1 >= h - 1));               // 종이 전체(틀 안을 다 채움)는 건물 아님
    // 가장 큰 덩어리에서 떨어진 작은 덩어리(열쇠 평면도·위치도 같은 삽입 그림)는 뺌 — 큰 것의 25% 미만이면서 간격이 4% 넘게 벌어진 것
    const main = keep.reduce((a, c) => !a || c.n > a.n ? c : a, null), gap = c => Math.max(main.x0 - c.x1, c.x0 - main.x1, main.y0 - c.y1, c.y0 - main.y1, 0);
    if (main) for (let i = keep.length - 1; i >= 0; i--) if (keep[i] !== main && keep[i].n < main.n * .25 && gap(keep[i]) > R * .04) keep.splice(i, 1);
    const area = keep.reduce((s, c) => s + c.n, 0) / (w * h);
    tries.push({ t, m, lab, keep, area });
  }
  // 그럴듯한 것: 종이의 6~75%를 덮는 것 중 가장 엄격한 문턱 (밀도가 높을수록 해치·대지선이 덜 붙음)
  const ok = tries.filter(r => r.keep.length && r.area >= .06 && r.area <= .75);
  const pick = ok[0] ?? tries.filter(r => r.keep.length).sort((a, b) => Math.abs(a.area - .3) - Math.abs(b.area - .3))[0];
  if (!pick) return null;
  const eps = Math.max(1, R * .005), minEdge = R * .025;
  const loops = pick.keep.sort((a, b) => b.n - a.n).slice(0, 6).map(c => cleanLoop(trace(pick.lab, c.id, w, h, c), eps, minEdge).map(([x, y]) => [(x + .5) * sx, (y + .5) * sy]))
    .filter(l => l.length >= 3);
  if (!loops.length) return null;
  const xs = loops.flat().map(p => p[0]), ys = loops.flat().map(p => p[1]);
  const data = new Uint8Array(w * h); for (let p = 0; p < w * h; p++) data[p] = pick.keep.some(c => c.id === pick.lab[p]) ? 1 : 0;
  const box = { x0:Math.min(...xs), y0:Math.min(...ys), x1:Math.max(...xs), y1:Math.max(...ys) };
  return { loops, box, mask:{ w, h, data, sx, sy }, area:loops.reduce((s, l) => s + polyArea(l), 0), threshold:pick.t };
}


/* 층 맞추기. sheets: [{ sil }] (sheetSilhouette 결과, 원본 px)
   반환: 각 층의 변환 { s, dx, dy } — 기준층 px 좌표 = s · 이 층 px + (dx, dy)
   기준층 = 덩어리 넓이가 가장 큰 지상층(없으면 아무 층) */
export function alignSheets(sils, refIndex) {
  const ref = sils[refIndex];
  const G = 160, rb = ref.box, pad = .35, gw = (rb.x1 - rb.x0) * (1 + 2 * pad), gh = (rb.y1 - rb.y0) * (1 + 2 * pad);
  const cell = Math.max(gw, gh) / G, ox = rb.x0 - (rb.x1 - rb.x0) * pad, oy = rb.y0 - (rb.y1 - rb.y0) * pad;
  const W = Math.ceil(gw / cell), H = Math.ceil(gh / cell);
  const raster = (sil, T) => { const g = new Uint8Array(W * H), m = sil.mask;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const X = ox + (i + .5) * cell, Y = oy + (j + .5) * cell;
      const u = (X - T.dx) / T.s, v = (Y - T.dy) / T.s, mx = Math.floor(u / m.sx), my = Math.floor(v / m.sy);
      if (mx >= 0 && my >= 0 && mx < m.w && my < m.h && m.data[my * m.w + mx]) g[j * W + i] = 1; }
    return g; };
  const R0 = raster(ref, { s:1, dx:0, dy:0 });
  const iou = g => { let a = 0, u = 0; for (let p = 0; p < W * H; p++) { if (g[p] && R0[p]) a++; if (g[p] || R0[p]) u++; } return u ? a / u : 0; };
  return sils.map((sil, k) => {
    if (k === refIndex) return { s:1, dx:0, dy:0, iou:1 };
    const b = sil.box;
    // 같은 축척이 기본. 화면 캡처 배율 차이(±20%)는 겹침이 확실히 좋아질 때만 받아들임 — 1에서 멀수록 감점
    // (층마다 실제로 크기가 다른 건물은 감점 때문에 같은 축척에 머묾)
    const prior = 1, scales = Array.from({ length:13 }, (_, i) => Math.exp((i - 6) * .03));
    const penalty = s => Math.abs(Math.log(s / prior));
    let best = null;
    for (const s of scales) {
      const cx = (rb.x0 + rb.x1) / 2 - s * (b.x0 + b.x1) / 2, cy = (rb.y0 + rb.y1) / 2 - s * (b.y0 + b.y1) / 2;
      const span = Math.max(rb.x1 - rb.x0, rb.y1 - rb.y0) * .3;
      for (const step of [span / 6, span / 30]) {
        const c0 = best && best.s === s ? best : { dx:cx, dy:cy };
        for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) {
          const T = { s, dx:c0.dx + i * step, dy:c0.dy + j * step }, v = iou(raster(sil, T)), sc = v - penalty(s);
          if (!best || sc > best.score) best = { ...T, iou:v, score:sc, prior };
        }
      }
    }
    return best;
  });
}
export { polyArea };
