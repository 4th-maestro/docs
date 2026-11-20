/* 평면도 사진 전처리: 사진 → '구조만 남은 깨끗한 도면'
   안내판·인쇄물을 찍은 사진에는 도면 말고도 유리 반사(하늘·철골·사람), 눈부심, 번호 동그라미·아이콘·글자·범례가 섞여 있다.
   인식(pipeline-core)에 넣기 전에 구조(칠한 칸 + 굵게 이어진 선)만 남긴다.

   1) 조명·반사 펴기: 칸마다 '종이 흰색'(밝은 쪽 상위 값)을 구해 넓게 퍼뜨린 뒤 채널별로 나눈다
      → 넓게 퍼진 반사의 푸른 기·눈부심·그림자가 사라지고, 칠한 색은 제 색으로 돌아온다
   2) 분류: 칠한 칸(analyzePlanPhoto가 고른 색상각 ± 허용치) / 구조선(진하고 무채색) / 바탕
   3) 부가 정보 지우기: 작은 덩어리(번호·아이콘·글자 획)는 지움. 칠한 칸 안에 박힌 것은 칸으로 메움
      구조선은 길게 이어진 덩어리만 남김 (글자·기호는 짧음)
   4) 층 나누기: 칸 + 구조선을 조금 불려 이어진 큰 덩어리 = 도면 하나 (안내판에 위아래로 여러 층이면 여러 개)
   출력: { image:{ width, height, data } 흰 바탕·칠 #8389b0·선 #333 , fill(원래 칠 색), blocks:[{ corners, aspect, area }] } */
import { analyzePlanPhoto } from './plan-upload.js';

export const CLEAN_FILL = '#8389b0';

export function cleanPlanPhoto(image, opt = {}) {
  const { width:w, height:h, data } = image, n = w * h;
  /* 1) 종이 흰색 추정 (블록 B px마다 채널별 상위 92% 값 → 이웃 블록 최댓값 → 흐리게 → 픽셀마다 보간) */
  const B = Math.max(16, Math.round(Math.max(w, h) / 64)), gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  const top = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  const hist = new Uint32Array(256);
  for (let c = 0; c < 3; c++) for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
    hist.fill(0); let k = 0;
    for (let y = by * B; y < Math.min(h, by * B + B); y += 2) for (let x = bx * B; x < Math.min(w, bx * B + B); x += 2) { hist[data[(y * w + x) * 4 + c]]++; k++; }
    let acc = 0, v = 255; for (; v > 0; v--) { acc += hist[v]; if (acc >= k * .08) break; }
    top[c][by * gw + bx] = v;
  }
  const R = Math.max(2, Math.round(opt.paperRadius ?? 3));        // 칠한 칸 하나보다 넓게: 이웃 R블록 안의 가장 밝은 값
  const paper = top.map(t => blur(maxFilter(t, gw, gh, R), gw, gh, 2));
  const norm = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = Math.min(gw - 1.001, Math.max(0, x / B - .5)), fy = Math.min(gh - 1.001, Math.max(0, y / B - .5)), x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0, p = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) { const t = paper[c], a = t[y0 * gw + x0], b = t[y0 * gw + x0 + 1], d = t[(y0 + 1) * gw + x0], e = t[(y0 + 1) * gw + x0 + 1];
      const bg = Math.max(40, (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty); norm[p + c] = data[p + c] * 245 / bg; }
    norm[p + 3] = 255;
  }
  const flat = { width:w, height:h, data:norm };
  /* 2) 분류 */
  const A = opt.analysis || analyzePlanPhoto(flat) || analyzePlanPhoto(image);
  const hue0 = A?.hue, tol = A?.hueTol ?? 16;
  const cls = new Uint8Array(n);          // 0 바탕 · 1 칠한 칸 · 2 구조선 · 3 기타(아이콘·글자·반사 조각)
  const dh = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  // 칠한 칸 채도 기준: 칠한 색 채도의 65% (반사가 남긴 옅은 같은 색 기운은 채도가 절반 이하)
  // 단, 칠 색상각이 하늘 반사(≈200~220°)에서 멀면(분홍·주황·초록) 반사와 헷갈릴 일이 없으므로 눈부심에 바랜 칸까지 받도록 낮춤
  const fc = A?.fill ? (v => Math.max(...v) - Math.min(...v))([1, 3, 5].map(i => parseInt(A.fill.slice(i, i + 2), 16))) : 30;
  const skyFar = hue0 != null && Math.min(Math.abs(hue0 - 210), 360 - Math.abs(hue0 - 210)) > 35;
  const minC = skyFar ? Math.max(8, fc * .3) : Math.max(14, fc * .65);
  // 하늘색에 가까운 칠이면 밝기 상한도 둠: 반사 조각은 칠보다 밝음 (칠 밝기 + 바탕까지 거리의 55%)
  const fL = A?.fill ? [1, 3, 5].reduce((s, i) => s + parseInt(A.fill.slice(i, i + 2), 16), 0) / 3 : 150;
  const maxL = skyFar ? 256 : fL + Math.max(25, (245 - fL) * (opt.lightMargin ?? .55));
  const Lum = new Float32Array(n), Chr = new Float32Array(n);
  for (let p = 0; p < n; p++) { const r = norm[p * 4], g = norm[p * 4 + 1], b = norm[p * 4 + 2]; Lum[p] = (r + g + b) / 3; Chr[p] = Math.max(r, g, b) - Math.min(r, g, b); }
  // 구조선 = 양옆(가로 또는 세로로 k px 떨어진 곳)보다 확실히 어두운 획. 넓은 어두운 반사 덩어리는 양옆도 어두워서 빠짐
  const k = Math.max(3, Math.round(Math.max(w, h) * .006));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, r = norm[p * 4], g = norm[p * 4 + 1], b = norm[p * 4 + 2], mx = Math.max(r, g, b), ch = Chr[p], L = Lum[p];
    const hu = ch ? ((mx === r ? ((g - b) / ch + 6) % 6 : mx === g ? (b - r) / ch + 2 : (r - g) / ch + 4) * 60) : -1;
    if (hue0 != null && ch >= minC && L > 50 && L <= maxL && dh(hu, hue0) <= tol) { cls[p] = 1; continue; }
    if (ch < 45 && L < 200) {
      const sx = x >= k && x < w - k ? Math.min(Lum[p - k], Lum[p + k]) - L : 0, sy = y >= k && y < h - k ? Math.min(Lum[p - k * w], Lum[p + k * w]) - L : 0;
      if (Math.max(sx, sy) >= 40) { cls[p] = 2; continue; }
    }
    if (ch >= 40 || L < 200) cls[p] = 3;
  }
  /* 3) 부가 정보 지우기 */
  const minLine = Math.max(w, h) * (opt.minLine ?? .05);           // 구조선: 덩어리 길이(외접 사각형 긴 변)가 사진의 5% 이상
  const holeMax = n * (opt.holeMax ?? .004);                       // 칸 안에 박힌 번호·글자: 이보다 작은 덩어리
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) out[p] = cls[p] === 1 ? 1 : 0;
  // 칠한 칸 조각 중 아주 작은 것(아이콘 색이 우연히 맞은 것)은 버림
  // 크면서 들쭉날쭉한 덩어리(넓은 반사·범례 바탕에 남은 같은 색 기운)도 버림: 칸은 사각형·사다리꼴이라 외접 사각형을 60% 넘게 채움
  //   단, 칸 여러 개가 가는 틈으로 붙은 경우를 위해 3×3 침식 후 다시 재서 판단
  for (const c of comps(p => cls[p] === 1, w, h)) {
    const fr = c.area / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));
    // 테두리 들쭉날쭉함: 테두리 길이 ÷ 외접 사각형 둘레. 칸(곧은 변) ≈ 1, 반사 얼룩 ≫ 1
    const rag = c.border.size / (2 * (c.x1 - c.x0 + c.y1 - c.y0 + 2));
    if (c.area < n * .00015 || (c.area > n * .002 && (fr < (opt.minRect ?? .5) || rag > (opt.maxRag ?? 1.8)))) for (const q of c.px) out[q] = 0;
  }
  // 구조선: 길게 이어진 것만
  for (const c of comps(p => cls[p] === 2, w, h)) if (Math.max(c.x1 - c.x0, c.y1 - c.y0) >= minLine && c.area / Math.max(1, (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) < .5) for (const q of c.px) out[q] = 2;
  // 칸 안 구멍(번호 동그라미·글자·아이콘)은 칸으로 메움: 바탕·기타 덩어리가 작고 테두리가 대부분 칠한 칸이면
  for (const c of comps(p => out[p] !== 1 && out[p] !== 2, w, h)) {
    if (c.area > holeMax || c.touchesEdge) continue;
    let fillN = 0, tot = 0;
    for (const q of c.border) { tot++; if (out[q] === 1) fillN++; }
    if (tot && fillN / tot > .6) for (const q of c.px) out[q] = 1;
  }
  /* 4) 층 나누기: 칸 + 구조선을 반경 r 만큼 불려 이어진 큰 덩어리를 찾고,
     위아래로 이웃한 덩어리 사이에 가로 구조선(층 외곽선)이 없으면 같은 층으로 합침.
     여러 층 안내판은 층 사이 간격이 층 안 복도보다 좁아 간격만으론 못 나누지만, 층 경계에는 외곽선이 있음 */
  const rad = Math.max(2, Math.round(Math.max(w, h) * (opt.joinRadius ?? .012)));
  const solid = dilateBox(out.map(v => v ? 1 : 0), w, h, rad);
  let big = comps(p => solid[p], w, h).filter(c => c.area > n * .02).map(c => ({ x0:c.x0, y0:c.y0, x1:c.x1, y1:c.y1, area:c.area, px:c.px }));
  const separated = (a, b) => {          // a 위, b 아래: 겹치는 가로 범위의 열 중 사이 띠에 구조선이 지나는 비율
    const xa = Math.max(a.x0, b.x0), xb = Math.min(a.x1, b.x1); if (xb - xa < 10) return true;
    if (b.y0 <= a.y1 - 2 * rad) return false;        // 세로로 겹치면 같은 층(한 층이 조각난 것)
    const ya = a.y1 - 2 * rad, yb = b.y0 + 2 * rad; let hit = 0;
    for (let x = xa; x <= xb; x++) for (let y = Math.max(0, ya); y <= Math.min(h - 1, yb); y++) if (out[y * w + x] === 2) { hit++; break; }
    return hit / (xb - xa + 1) > (opt.sepRatio ?? .5);
  };
  if (!opt.noMerge) for (let merged = true; merged;) {
    merged = false; big.sort((a, b) => a.y0 - b.y0);
    for (let i = 0; i < big.length && !merged; i++) for (let j = i + 1; j < big.length && !merged; j++) {
      const a = big[i], b = big[j], ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      if (ov < .5 * Math.min(a.x1 - a.x0, b.x1 - b.x0) || separated(a, b)) continue;
      big[i] = { x0:Math.min(a.x0, b.x0), y0:Math.min(a.y0, b.y0), x1:Math.max(a.x1, b.x1), y1:Math.max(a.y1, b.y1), area:a.area + b.area, px:a.px.concat(b.px) };
      big.splice(j, 1); merged = true;
    }
  }
  big = big.filter(c => c.area > n * .03).sort((a, b) => a.y0 - b.y0);
  const blocks = big.map(c => { let fillA = 0; for (const q of c.px) if (out[q] === 1) fillA++;
    const x0 = Math.max(0, c.x0), y0 = Math.max(0, c.y0), x1 = Math.min(w - 1, c.x1), y1 = Math.min(h - 1, c.y1);
    return { corners:[[x0, y0], [x1, y0], [x1, y1], [x0, y1]], aspect:(x1 - x0) / Math.max(1, y1 - y0), area:c.area / n, fill:fillA / n }; })
    .filter(b => b.fill > .004);
  /* 출력 그림 */
  const img = new Uint8ClampedArray(n * 4), F = [0x83, 0x89, 0xb0];
  for (let p = 0; p < n; p++) { const v = out[p], o = p * 4;
    if (v === 1) { img[o] = F[0]; img[o + 1] = F[1]; img[o + 2] = F[2]; } else if (v === 2) { img[o] = img[o + 1] = img[o + 2] = 0x33; } else img[o] = img[o + 1] = img[o + 2] = 255;
    img[o + 3] = 255; }
  return { image:{ width:w, height:h, data:img }, flat, fill:A?.fill ?? null, hue:hue0 ?? null, blocks, classes:out };
}

function maxFilter(t, gw, gh, r) {
  const o = new Float32Array(t.length);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let m = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && t[yy * gw + xx] > m) m = t[yy * gw + xx]; }
    o[y * gw + x] = m; }
  return o;
}
function blur(t, gw, gh, r) {
  const o = new Float32Array(t.length);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let s = 0, k = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) { s += t[yy * gw + xx]; k++; } }
    o[y * gw + x] = s / k; }
  return o;
}
// 사각형 팽창 (적분 영상)
function dilateBox(m, w, h, r) {
  const I = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += m[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; } }
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
    if (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0] > 0) o[y * w + x] = 1; }
  return o;
}
// 연결 요소 (4방향): 픽셀 목록·외접 사각형·바깥 테두리 픽셀
function comps(inSet, w, h) {
  const n = w * h, seen = new Uint8Array(n), Q = new Int32Array(n), out = [];
  for (let p0 = 0; p0 < n; p0++) {
    if (seen[p0] || !inSet(p0)) continue;
    let qh = 0, qt = 0; Q[qt++] = p0; seen[p0] = 1;
    const c = { x0:w, y0:h, x1:0, y1:0, area:0, px:[], border:new Set(), touchesEdge:false };
    while (qh < qt) { const q = Q[qh++], x = q % w, y = (q - x) / w; c.area++; c.px.push(q);
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      if (!x || !y || x === w - 1 || y === h - 1) c.touchesEdge = true;
      for (const v of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1]) {
        if (v < 0) continue;
        if (inSet(v)) { if (!seen[v]) { seen[v] = 1; Q[qt++] = v; } } else c.border.add(v);
      } }
    out.push(c);
  }
  return out;
}
