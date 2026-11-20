/* 스카이뷰(위성·항공 사진)에서 건물 지붕 윤곽 따기 — 반자동
   사용자가 지붕을 한 번씩 클릭(지붕이 여러 단이면 단마다)하면 그 지붕 영역을 키워 다각형으로 돌려준다.

   1) 사진을 작업 크기로 줄이고 살짝 흐림 → 밝기·색차 두 축(Y, r−g, (r+g)/2−b)과 경계 세기(소벨)
   2) 클릭 주변의 중앙값 색에서 영역 키우기: 그 색과 가깝고(전체 기준) + 이웃끼리 갑자기 변하지 않는(한 걸음 기준) 픽셀만
      → 그림자(어두운 땅)·도로·풀·나무는 색이 달라 멈추고, 지붕 위 실외기·태양광판은 구멍으로 남음
   3) 정리: 닫힘 연산으로 틈 메우기 → 작은 구멍(옥상 설비)은 메우고 큰 구멍(중정)은 남김
   4) 윤곽 추적 → 더글러스-포이커로 단순화 → 건물 주축(가장 긴 변들의 방향)에 가까운 변은 직각으로 맞춤
      곡선 변은 짧은 변 여러 개라 맞추지 않고 그대로 둠
   반환: { levels:[{ seed, polygon:[[x,y]...], holes:[[[x,y]...]], areaPx, color }], axisDeg } (원본 사진 px 좌표) */

export function extractRoof(image, seeds, opt = {}) {
  const S = Math.min(1, (opt.work ?? 900) / Math.max(image.width, image.height));
  const w = Math.max(8, Math.round(image.width * S)), h = Math.max(8, Math.round(image.height * S)), n = w * h;
  /* 1) 줄이기(상자 평균) + 색 축 */
  const Y = new Float32Array(n), C1 = new Float32Array(n), C2 = new Float32Array(n);
  const rx = image.width / w, ry = image.height / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xa = Math.floor(x * rx), xb = Math.max(xa + 1, Math.floor((x + 1) * rx)), ya = Math.floor(y * ry), yb = Math.max(ya + 1, Math.floor((y + 1) * ry));
    let r = 0, g = 0, b = 0, k = 0;
    for (let yy = ya; yy < yb; yy += Math.max(1, (yb - ya) >> 1)) for (let xx = xa; xx < xb; xx += Math.max(1, (xb - xa) >> 1)) { const i = (yy * image.width + xx) * 4; r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; k++; }
    r /= k; g /= k; b /= k; const p = y * w + x; Y[p] = (r + g + b) / 3; C1[p] = r - g; C2[p] = (r + g) / 2 - b;
  }
  const Ys = box3(Y, w, h), A1 = box3(C1, w, h), A2 = box3(C2, w, h);
  const dist = (p, c) => Math.hypot(Ys[p] - c[0], 1.3 * (A1[p] - c[1]), 1.3 * (A2[p] - c[2]));
  const step = (p, q) => Math.hypot(Ys[p] - Ys[q], 1.3 * (A1[p] - A1[q]), 1.3 * (A2[p] - A2[q]));
  // 경계 세기: 2칸 떨어진 이웃끼리 색 차이(가로·세로 중 큰 것). 흐려진 난간 선·지붕 끝도 잡힘
  const E = new Float32Array(n);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { const p = y * w + x;
    E[p] = Math.max(step(p - 2, p + 2), step(p - 2 * w, p + 2 * w)); }

  const levels = [], taken = new Uint8Array(n);
  for (const sd of seeds) {
    const sx = Math.min(w - 1, Math.max(0, Math.round(sd[0] * S))), sy = Math.min(h - 1, Math.max(0, Math.round(sd[1] * S))), p0 = sy * w + sx;
    if (taken[p0]) continue;                                   // 이미 앞 클릭이 잡은 지붕
    /* 2) 클릭 주변 색 (중앙값) 과 퍼짐 */
    const r0 = Math.max(3, Math.round(Math.max(w, h) * .008)), ys = [], c1 = [], c2 = [];
    for (let y = sy - r0; y <= sy + r0; y++) for (let x = sx - r0; x <= sx + r0; x++) if (x >= 0 && y >= 0 && x < w && y < h) { const p = y * w + x; ys.push(Ys[p]); c1.push(A1[p]); c2.push(A2[p]); }
    const c = [med(ys), med(c1), med(c2)];
    const spread = med(ys.map((v, i) => Math.hypot(v - c[0], 1.3 * (c1[i] - c[1]), 1.3 * (c2[i] - c[2]))));
    const T = Math.max(opt.minTol ?? 16, (opt.tolK ?? 4) * spread), Tstep = opt.stepTol ?? Math.max(9, T * .55);
    // 경계 문턱: 지붕 자체 질감의 경계 세기(클릭 주변 중앙값)의 몇 배 — 그보다 센 경계는 넘지 않음
    const es = []; for (let y = sy - r0; y <= sy + r0; y++) for (let x = sx - r0; x <= sx + r0; x++) if (x >= 0 && y >= 0 && x < w && y < h) es.push(E[y * w + x]);
    const Tedge = opt.edgeTol ?? Math.max(opt.minEdge ?? 18, (opt.edgeK ?? 3.5) * med(es));
    /* 영역 키우기 — 색은 점점 넓어진 영역 평균으로 갱신 (지붕 한쪽이 밝게 바랜 경우 대비) */
    const m = new Uint8Array(n), Q = new Int32Array(n); let qh = 0, qt = 0; Q[qt++] = p0; m[p0] = 1;
    let sY = 0, s1 = 0, s2 = 0, cnt = 0;
    while (qh < qt) {
      const p = Q[qh++], x = p % w, y = (p - x) / w;
      sY += Ys[p]; s1 += A1[p]; s2 += A2[p]; cnt++;
      if ((cnt & 1023) === 0) { const k = Math.min(.5, cnt / 40000); c[0] = c[0] * (1 - k) + sY / cnt * k; c[1] = c[1] * (1 - k) + s1 / cnt * k; c[2] = c[2] * (1 - k) + s2 / cnt * k; }
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0 || m[q]) continue;
        if (dist(q, c) <= T && step(p, q) <= Tstep && E[q] <= Tedge) { m[q] = 1; Q[qt++] = q; }
      }
    }
    // 경계 띠 흡수: 경계 문턱에서 멈춘 영역은 난간·지붕 끝의 안쪽에 서 있음 → 센 경계 띠(난간)만 따라 최대 rb칸 더 나감
    const rb = opt.bandR ?? Math.max(2, Math.round(Math.max(w, h) * .0035));
    let front = []; for (let i = 0; i < qt; i++) front.push(Q[i]);
    for (let it = 0; it < rb; it++) { const nx = [];
      for (const p of front) { const x = p % w, y = (p - x) / w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && !m[q] && E[q] > Tedge * .5) { m[q] = 1; nx.push(q); } }
      front = nx; }
    // 태양광판: 어둡고 푸른 덩어리가 지붕에 닿아 있으면 지붕 (판 사이 틈·격자선 때문에 영역 키우기가 못 넘음)
    if (opt.panels !== false) { const near = dilate(m, w, h, 2), area0 = qt;
      for (const c of labelComps(p => !m[p] && Ys[p] < 110 && A2[p] < -20, w, h)) if (c.px.length < area0 * .2 && c.px.some(q => near[q])) for (const q of c.px) m[q] = 1; }
    /* 3) 닫힘 → 클릭한 덩어리만 */
    const rc = Math.max(1, Math.round(Math.max(w, h) * (opt.closeR ?? .003)));
    const mm = keepComp(erode(dilate(m, w, h, rc), w, h, rc), w, h, p0) || m;
    if (opt.areaRange && (qt < n * opt.areaRange[0] || qt > n * opt.areaRange[1])) continue;
    for (let p = 0; p < n; p++) if (mm[p]) taken[p] = 1;
    levels.push({ seed:sd, p0, m:mm, c, T, Tstep, Tedge, rc });
  }
  /* 3-1) 윗단 그림자: 낮은 단 지붕에 높은 단(탑)의 그림자가 지면 그 부분은 색이 같고 어두울 뿐 → 낮은 단에 합침
     조건: 그 단 지붕색과 색 비율이 같고 밝기만 0.3~0.85배, 그 단과 다른 단(그림자를 드리운 높은 단)에 모두 닿음, 사진 가장자리에 안 닿음 */
  if (opt.shadow !== false && levels.length > 1) {
    const any = new Uint8Array(n); for (const L of levels) for (let p = 0; p < n; p++) if (L.m[p]) any[p] = 1;
    const touchR = Math.max(5, Math.round(Math.max(w, h) * .008));   // 난간 띠·흐림 때문에 이웃 단과 몇 칸 떨어져 멈춤
    for (const A of levels) {
      const [cY, c1, c2] = A.c, area = A.m.reduce((a, v) => a + v, 0);
      // 같은 지붕의 그늘(어두운 쪽) 또는 — 클릭이 그늘에 떨어졌으면 — 햇빛 받은 쪽(밝은 쪽): 색 비율이 같고 밝기만 다름
      const sameHue = (q, lo, hi) => { const r = Ys[q] / Math.max(1, cY); return r >= lo && r <= hi && Math.abs(A1[q] / Math.max(1, Ys[q]) - c1 / cY) < .09 && Math.abs(A2[q] / Math.max(1, Ys[q]) - c2 / cY) < .09; };
      const others = new Uint8Array(n); for (const B of levels) if (B !== A) { const d = dilate(B.m, w, h, touchR); for (let p = 0; p < n; p++) if (d[p]) others[p] = 1; }
      const nearA = dilate(A.m, w, h, 2), nearA3 = dilate(A.m, w, h, touchR);
      for (const [lo, hi, maxA] of [[.3, .85, 1.2], [1 / .85, 1 / .3, 20]]) {
        const seen = new Uint8Array(n), ok = q => sameHue(q, lo, hi);
        for (let s0 = 0; s0 < n; s0++) {
          if (!nearA[s0] || any[s0] || seen[s0] || !ok(s0)) continue;
          const R = [s0]; seen[s0] = 1; let edge = false, touchB = 0, touchA = 0;
          for (let i = 0; i < R.length && R.length < area * maxA; i++) { const p = R[i], x = p % w, y = (p - x) / w;
            if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true; if (others[p]) touchB++; if (nearA3[p]) touchA++;
            for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
              if (q >= 0 && !seen[q] && !any[q] && ok(q) && step(p, q) <= A.Tstep && E[q] <= A.Tedge) { seen[q] = 1; R.push(q); } }
          // 그늘은 그 단에 더 많이 붙어 있어야 함(높은 단에는 한 변만 닿음) → 탑이 제 그늘을 가져가는 것 방지
          if (opt.debug) opt.debug.push({ lo, n:R.length, area, edge, touchA, touchB });
          if (!edge && touchB && (lo > 1 || touchA > touchB) && R.length < area * maxA && R.length > 20) for (const p of R) { A.m[p] = 1; any[p] = 1; }
        }
      }
      A.m = keepComp(erode(dilate(A.m, w, h, A.rc), w, h, A.rc), w, h, A.p0) || A.m;
    }
  }
  /* 3-2) 다듬기: 볼록 껍질과의 작은 틈(가장자리 태양광판·나무가 갉아먹은 곳) 메우기 → 구멍 분류 → 열림 */
  const out = [];
  for (const L of levels) {
    let mm = L.m;
    const area = mm.reduce((a, v) => a + v, 0);
    const hull = fillPoly(convexHull(mm, w, h), w, h);
    for (const c of labelComps(p => hull[p] && !mm[p], w, h)) if (c.px.length < area * (opt.pocketFrac ?? .04)) for (const q of c.px) mm[q] = 1;
    // 구멍: 다른 단(탑)이 차지한 자리면 그 단의 바닥 → 메움(낮은 단 윤곽은 탑 밑까지 포함)
    //       작으면 설비 → 메움. 크면(지붕의 8% 이상) 또는 건물 밖 땅(그늘 포함)과 색이 닮았으면 중정
    const otherM = new Uint8Array(n); for (const B of levels) if (B !== L) for (let p = 0; p < n; p++) if (B.m[p]) otherM[p] = 1;
    const ringM = dilate(mm, w, h, 4), ring = [[], [], []];
    for (let p = 0; p < n; p += 2) if (ringM[p] && !mm[p] && !taken[p]) { ring[0].push(Ys[p]); ring[1].push(A1[p]); ring[2].push(A2[p]); }
    const g = ring.map(med), gTol = Math.max(25, L.T);
    const groundLike = p => Math.hypot(Ys[p] - g[0], 1.3 * (A1[p] - g[1]), 1.3 * (A2[p] - g[2])) <= gTol
      || Math.hypot(Ys[p] - g[0] * .6, 1.3 * (A1[p] - g[1] * .6), 1.3 * (A2[p] - g[2] * .6)) <= gTol;
    const holes = [];
    for (const c of labelComps(p => !mm[p], w, h)) {
      if (c.edge) continue;
      let gl = 0, ot = 0; for (const q of c.px) if (otherM[q]) ot++;
      if (ot < c.px.length * .5 && c.px.length >= area * (opt.holeFrac ?? .03)) for (const q of c.px) if (groundLike(q)) gl++;
      const court = ot < c.px.length * .5 && (c.px.length >= area * (opt.courtFrac ?? .08) || gl > c.px.length * (opt.courtGround ?? .3));
      if (court) holes.push(c); else for (const q of c.px) mm[q] = 1;
    }
    // 열림: 가는 돌기(경계 따라 샌 실선) 제거, 클릭 덩어리 다시 고름
    const ro = Math.max(1, Math.round(L.rc * .7));
    mm = keepComp(dilate(erode(mm, w, h, ro), w, h, ro), w, h, L.p0) || mm;
    /* 4) 윤곽 → 다각형 */
    const eps = Math.max(1, Math.max(w, h) * (opt.eps ?? .004));
    const outer = simplify(trace(mm, w, h), eps);
    const holePolys = holes.map(c => { const hm = new Uint8Array(n); for (const q of c.px) hm[q] = 1; return simplify(trace(hm, w, h), eps); }).filter(p => p.length >= 3);
    out.push({ seed:L.seed, outer, holes:holePolys, areaPx:Math.round(mm.reduce((a, v) => a + v, 0) / S / S), color:'#' + rgbHex(L.c) });
  }
  levels.length = 0; levels.push(...out);
  /* 건물 주축: 모든 단의 긴 변 방향을 길이로 가중한 90° 주기 평균 */
  let sx = 0, sy = 0;
  for (const L of levels) for (const poly of [L.outer, ...L.holes]) for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length], len = Math.hypot(bx - ax, by - ay), a = Math.atan2(by - ay, bx - ax) * 4;
    sx += Math.cos(a) * len * len; sy += Math.sin(a) * len * len;
  }
  const axis = Math.atan2(sy, sx) / 4;
  const snapTol = (opt.snapDeg ?? 10) * Math.PI / 180, minEdge = Math.max(w, h) * .015;
  const fin = poly => (opt.snap === false ? poly : orthoSnap(poly, axis, snapTol, minEdge)).map(([x, y]) => [+(x / S).toFixed(1), +(y / S).toFixed(1)]);
  return { levels:levels.map(L => ({ seed:L.seed, polygon:fin(L.outer), holes:L.holes.map(fin), areaPx:L.areaPx, color:L.color })), axisDeg:+(axis * 180 / Math.PI).toFixed(1) };
}

// Join enclosed rooms across wall strokes before tracing the outside of each building.
export function enclosedOutlines(walls, w, h, close = 0) {
  const barrier = close ? erode(dilate(walls, w, h, close), w, h, close) : walls;
  const inside = new Uint8Array(walls.length), minimum = w * h * .0006;
  for (const region of labelComps(p => !barrier[p], w, h)) {
    if (!region.edge && region.px.length >= minimum) for (const p of region.px) inside[p] = 1;
  }
  const spread = Math.max(2, Math.round(Math.max(w, h) * .009));
  const joined = erode(dilate(inside, w, h, spread), w, h, Math.max(1, spread - 1));
  const components = labelComps(p => joined[p], w, h)
    .filter(c => !c.edge && c.px.length >= w * h * .008)
    .sort((a, b) => b.px.length - a.px.length);
  const mask = new Uint8Array(walls.length);
  return components.filter(c => c.px.length >= components[0].px.length * .07).map(c => {
    for (const p of c.px) mask[p] = 1;
    const loop = simplify(trace(mask, w, h), Math.max(1.2, Math.max(w, h) * .006));
    for (const p of c.px) mask[p] = 0;
    return loop;
  }).filter(loop => loop.length >= 3);
}

export function inkOutlines(ink, w, h) {
  const connected = dilate(ink, w, h, 3), mask = new Uint8Array(ink.length);
  const groups = labelComps(p => connected[p], w, h)
    .filter(c => c.px.length > w * h * .008)
    .sort((a,b) => b.px.length - a.px.length);
  return groups.slice(0, 5).filter(c => c.px.length >= groups[0].px.length * .16).flatMap(c => {
    for (const p of c.px) mask[p] = ink[p];
    const hull = convexHull(mask, w, h);
    for (const p of c.px) mask[p] = 0;
    return hull.length >= 3 ? [hull] : [];
  });
}

// For CAD views with a filled building mass, keep the outside boundary of the ink
// component. The convex hull used for sparse line drawings loses re-entrant corners.
export function filledInkOutline(ink, w, h, tolerance = .004) {
  const connected = erode(dilate(ink, w, h, 4), w, h, 3);
  const candidate = labelComps(p => connected[p], w, h)
    .filter(c => !c.edge && c.px.length > w * h * .04 && c.px.length < w * h * .65)
    .sort((a,b) => b.px.length - a.px.length)[0];
  if (!candidate) return null;
  const mask = new Uint8Array(ink.length);
  for (const p of candidate.px) mask[p] = 1;
  for (const hole of labelComps(p => !mask[p],w,h)) if (!hole.edge) for (const p of hole.px) mask[p] = 1;
  const outline = simplify(trace(mask,w,h),Math.max(1.5,Math.max(w,h)*tolerance));
  return outline.length > 4 ? outline : null;
}

function rgbHex([Yv, c1, c2]) {   // Y=(r+g+b)/3, c1=r−g, c2=(r+g)/2−b 를 되돌림
  const b = Yv - 2 * c2 / 3, rg = 3 * Yv - b, r = (rg + c1) / 2, g = (rg - c1) / 2;
  return [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}
/* 덩어리의 볼록 껍질 (경계 픽셀 모서리 점들, 단조 사슬) */
function convexHull(m, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) { let a = -1, b = -1; for (let x = 0; x < w; x++) if (m[y * w + x]) { if (a < 0) a = x; b = x; }
    if (a >= 0) pts.push([a, y], [a, y + 1], [b + 1, y], [b + 1, y + 1]); }
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/* 다각형 칠하기 (픽셀 중심 기준, 짝홀) */
function fillPoly(poly, w, h) {
  const o = new Uint8Array(w * h); if (poly.length < 3) return o;
  for (let y = 0; y < h; y++) { const yc = y + .5, xs = [];
    for (let i = 0; i < poly.length; i++) { const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      if ((ay <= yc) !== (by <= yc)) xs.push(ax + (yc - ay) / (by - ay) * (bx - ax)); }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - .5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - .5)); x++) o[y * w + x] = 1; }
  return o;
}
const med = a =>{ const s = Float32Array.from(a).sort(); return s[s.length >> 1] ?? 0; };
function box3(a, w, h) {
  const o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += a[yy * w + xx]; k++; } }
    o[y * w + x] = s / k; }
  return o;
}
// 정사각형 팽창/침식 (가로·세로 분리, 누적합)
function morph(m, w, h, r, dil) {
  const t = new Uint8Array(m.length), o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) { let s = 0; const row = y * w;
    for (let x = -r; x < w + r; x++) { if (x + r < w && x + r >= 0) s += m[row + x + r]; if (x - r - 1 >= 0 && x - r - 1 < w) s -= m[row + x - r - 1];
      if (x >= 0 && x < w) { const span = Math.min(w - 1, x + r) - Math.max(0, x - r) + 1; t[row + x] = dil ? (s > 0 ? 1 : 0) : (s === span ? 1 : 0); } } }
  for (let x = 0; x < w; x++) { let s = 0;
    for (let y = -r; y < h + r; y++) { if (y + r < h && y + r >= 0) s += t[(y + r) * w + x]; if (y - r - 1 >= 0 && y - r - 1 < h) s -= t[(y - r - 1) * w + x];
      if (y >= 0 && y < h) { const span = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1; o[y * w + x] = dil ? (s > 0 ? 1 : 0) : (s === span ? 1 : 0); } } }
  return o;
}
const dilate = (m, w, h, r) => morph(m, w, h, r, true), erode = (m, w, h, r) => morph(m, w, h, r, false);
function labelComps(inSet, w, h) {
  const n = w * h, lab = new Int32Array(n).fill(-1), out = [], Q = new Int32Array(n);
  for (let p0 = 0; p0 < n; p0++) {
    if (lab[p0] >= 0 || !inSet(p0)) continue;
    let qh = 0, qt = 0, edge = false; Q[qt++] = p0; lab[p0] = out.length;
    while (qh < qt) { const p = Q[qh++], x = p % w, y = (p - x) / w; if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && lab[q] < 0 && inSet(q)) { lab[q] = out.length; Q[qt++] = q; } }
    out.push({ px:Q.slice(0, qt), edge });
  }
  return out;
}
function keepComp(m, w, h, p0) {
  if (!m[p0]) { // 닫힘·열림으로 클릭 지점이 빠졌으면 가장 가까운 덩어리
    let best = -1, bd = Infinity; const x0 = p0 % w, y0 = (p0 - x0) / w;
    for (let p = 0; p < m.length; p++) if (m[p]) { const d = (p % w - x0) ** 2 + (((p - p % w) / w) - y0) ** 2; if (d < bd) { bd = d; best = p; } }
    if (best < 0) return null; p0 = best;
  }
  const o = new Uint8Array(m.length), Q = new Int32Array(m.length); let qh = 0, qt = 0; Q[qt++] = p0; o[p0] = 1;
  while (qh < qt) { const p = Q[qh++], x = p % w, y = (p - x) / w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && m[q] && !o[q]) { o[q] = 1; Q[qt++] = q; } }
  return o;
}
/* 윤곽 추적: 픽셀 모서리를 따라 도는 경계(마칭 스퀘어식). 바깥 테두리 하나만 — 가장 긴 고리 */
function trace(m, w, h, all = false) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] ? 1 : 0;
  // 경계 변을 모아 고리로 잇기: 칸 (x,y)가 안이고 이웃이 밖이면 그 사이 변 (시계 방향)
  const next = new Map(), key = (x, y) => y * (w + 1) + x;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) {
    if (!at(x, y - 1)) next.set(key(x, y), key(x + 1, y));
    if (!at(x + 1, y)) next.set(key(x + 1, y) + .5, key(x + 1, y + 1));
    if (!at(x, y + 1)) next.set(key(x + 1, y + 1) + .25, key(x, y + 1));
    if (!at(x - 1, y)) next.set(key(x, y + 1) + .75, key(x, y));
  }
  // 같은 꼭짓점에서 나가는 변이 둘일 수 있어(대각 접촉) 꼭짓점별 목록으로
  const out = new Map();
  for (const [k, v] of next) { const s = Math.floor(k); (out.get(s) || out.set(s, []).get(s)).push(v); }
  const used = new Set(), loops=[]; let best = [];
  for (const [s0, list] of out) for (const t0 of list) {
    const id = s0 + ':' + t0; if (used.has(id)) continue;
    const ring = []; let s = s0, t = t0;
    for (let guard = 0; guard < 4 * n4(w, h); guard++) {
      used.add(s + ':' + t); ring.push(s);
      const cand = (out.get(t) || []).filter(v => !used.has(t + ':' + v)); if (!cand.length) break;
      s = t; t = cand[0];
      if (s === s0) break;
    }
    if (all && ring.length >= 4) loops.push(ring);
    if (ring.length > best.length) best = ring;
  }
  const coords = ring => ring.map(k => [k % (w + 1), Math.floor(k / (w + 1))]);
  return all ? loops.map(coords) : coords(best);
}
export const traceFloorRegions = (mask,w,h) => trace(mask,w,h,true).map(loop=>simplify(loop,1.2)).filter(loop=>loop.length>=3);
const n4 = (w, h) => (w + 1) * (h + 1);
/* 더글러스-포이커 (닫힌 고리) */
function simplify(pts, eps) {
  if (pts.length < 4) return pts;
  // 고리를 가장 먼 두 점에서 나눠 각각 단순화
  let a = 0, b = 0, bd = -1; for (let i = 0; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > bd) { bd = d; b = i; } }
  for (let i = 0; i < pts.length; i++) { const d = (pts[i][0] - pts[b][0]) ** 2 + (pts[i][1] - pts[b][1]) ** 2; if (d > bd) { bd = d; a = i; } }
  if (a > b) [a, b] = [b, a];
  const dp = arr => { if (arr.length < 3) return arr;
    const [x0, y0] = arr[0], [x1, y1] = arr[arr.length - 1], L = Math.hypot(x1 - x0, y1 - y0) || 1; let id = 0, md = -1;
    for (let i = 1; i < arr.length - 1; i++) { const d = Math.abs((x1 - x0) * (y0 - arr[i][1]) - (x0 - arr[i][0]) * (y1 - y0)) / L; if (d > md) { md = d; id = i; } }
    return md > eps ? dp(arr.slice(0, id + 1)).slice(0, -1).concat(dp(arr.slice(id))) : [arr[0], arr[arr.length - 1]]; };
  const A = dp(pts.slice(a, b + 1)), B = dp(pts.slice(b).concat(pts.slice(0, a + 1)));
  return A.slice(0, -1).concat(B.slice(0, -1));
}
/* 직각 맞춤: 주축(axis)이나 그 수직에 tol 안으로 가까운 긴 변은 그 방향으로 돌리고, 이웃 변의 직선끼리 교점을 새 꼭짓점으로 */
function orthoSnap(poly, axis, tol, minEdge) {
  const N = poly.length; if (N < 4) return poly;
  const lines = [];
  for (let i = 0; i < N; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % N], len = Math.hypot(bx - ax, by - ay); let ang = Math.atan2(by - ay, bx - ax);
    const d = ((ang - axis) % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2), off = Math.min(d, Math.PI / 2 - d);
    if (len >= minEdge && off <= tol) ang = ang - (d <= Math.PI / 4 ? d : d - Math.PI / 2);
    lines.push({ p:[(ax + bx) / 2, (ay + by) / 2], d:[Math.cos(ang), Math.sin(ang)], len });
  }
  const out = [];
  for (let i = 0; i < N; i++) {
    const L0 = lines[(i - 1 + N) % N], L1 = lines[i], den = L0.d[0] * L1.d[1] - L0.d[1] * L1.d[0];
    if (Math.abs(den) < Math.sin(8 * Math.PI / 180)) { out.push(poly[i]); continue; }
    const t = ((L1.p[0] - L0.p[0]) * L1.d[1] - (L1.p[1] - L0.p[1]) * L1.d[0]) / den, q = [L0.p[0] + L0.d[0] * t, L0.p[1] + L0.d[1] * t];
    out.push(Math.hypot(q[0] - poly[i][0], q[1] - poly[i][1]) > Math.max(3, .5 * Math.min(L0.len, L1.len)) ? poly[i] : q);
  }
  // 거의 일직선이 된 꼭짓점 제거
  return out.filter((p, i) => { const a = out[(i - 1 + out.length) % out.length], b = out[(i + 1) % out.length];
    return Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1])) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1) > .6; });
}
