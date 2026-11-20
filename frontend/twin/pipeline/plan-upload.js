// Estimate the four straight outer edges of a photographed plan.
export function detectPlanCorners(image) {
  const scale = Math.min(1, 480 / Math.max(image.width, image.height));
  const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
  if (w < 24 || h < 24) return null;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (Math.min(image.height-1,Math.round(y / scale)) * image.width + Math.min(image.width-1,Math.round(x / scale))) * 4;
    const a = image.data[i + 3] / 255;
    gray[y * w + x] = 255 * (1 - a) + a * (image.data[i] * .299 + image.data[i+1] * .587 + image.data[i+2] * .114);
  }
  const horizontal = new Uint8Array(w * h), vertical = new Uint8Array(w * h);
  for (let y = 5; y < h - 5; y++) for (let x = 5; x < w - 5; x++) {
    const p = y * w + x;
    // A wall stroke has lighter pixels on both sides. Reject one-sided
    // boundaries such as the edge of the photographed paper or a shadow.
    const dx = Math.min(gray[p + 5], gray[p - 5]) - gray[p];
    const dy = Math.min(gray[p + 5*w], gray[p - 5*w]) - gray[p];
    if (dy >= 24 && dy > dx * 1.2) horizontal[p] = 1;
    if (dx >= 24 && dx > dy * 1.2) vertical[p] = 1;
  }

  function lines(edges, transpose) {
    const length = transpose ? h : w, across = transpose ? w : h;
    const points = [];
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++)
      if (edges[y * w + x]) points.push(transpose ? [y,x] : [x,y]);
    const margin = Math.ceil(length * .25) + 2;
    const found = [];
    for (let k = -20; k <= 20; k++) {
      const slope = k / 40;
      const votes = new Uint32Array(across + 2 * margin);
      for (const [x,y] of points) votes[Math.round((y - slope * (x - length / 2)) / 2) + margin]++;
      for (let bin = 1; bin < votes.length - 1; bin++) {
        const center = (bin - margin) * 2, score = votes[bin];
        if (score > length * .24 && score >= votes[bin - 1] && score >= votes[bin + 1])
          found.push({ slope, center, offset:center - slope * length / 2, score });
      }
    }
    const pick = side => {
      const keep = [];
      for (const line of found.filter(v => side ? v.center > across * .46 : v.center < across * .54)
        .sort((a,b) => b.score-a.score)) {
        if (keep.some(v => Math.abs(v.center-line.center) < 5 && Math.abs(v.slope-line.slope) < .065)) continue;
        keep.push(line);
        if (keep.length === 9) break;
      }
      return keep;
    };
    return [pick(false),pick(true)];
  }

  const [tops,bottoms] = lines(horizontal,false), [lefts,rights] = lines(vertical,true);
  const meet = (hor,ver) => {
    const y = (hor.offset + hor.slope * ver.offset) / (1 - hor.slope * ver.slope);
    return [ver.offset + ver.slope * y,y];
  };
  function coverage(a,b,edge,transpose) {
    let hits = 0;
    for (let i = 1; i <= 30; i++) {
      const t = i / 31, x = Math.round(a[0]+(b[0]-a[0])*t), y = Math.round(a[1]+(b[1]-a[1])*t);
      for (let d = -3; d <= 3; d++) {
        const u = transpose ? x+d : x, v = transpose ? y : y+d;
        if (u >= 0 && u < w && v >= 0 && v < h && edge[v*w+u]) { hits++; break; }
      }
    }
    return hits / 30;
  }

  let best = null, score = 0;
  for (const top of tops) for (const bottom of bottoms) for (const left of lefts) for (const right of rights) {
    if (bottom.center-top.center < h*.29 || right.center-left.center < w*.29) continue;
    const corners = [meet(top,left),meet(top,right),meet(bottom,right),meet(bottom,left)];
    if (!corners.every(([x,y]) => x >= 0 && x < w && y >= 0 && y < h) || !validCorners(corners)) continue;
    const area = polygonArea(corners) / (w*h);
    if (area < .16) continue;
    const sides = corners.map((p,i) => coverage(p,corners[(i+1)%4], i%2 ? vertical : horizontal, i%2));
    if (sides.some(v => v < .53)) continue;
    const quality = sides.reduce((a,b) => a+b,0) + area*1.05;
    if (quality > score) { best = corners; score = quality; }
  }
  return best?.map(([x,y]) => [Math.min(image.width-1,Math.round(x/scale)),Math.min(image.height-1,Math.round(y/scale))]) ?? null;
}

/* 색으로 칠한 안내도 사진 분석 (역·쇼핑몰 안내판처럼 벽선 없이 상점을 색으로 칠한 도면)
   - 칠한 색: 채도가 중간인 픽셀의 색상각 히스토그램에서 봉우리를 고르고, 그 색의 덩어리가 '반듯한 칸' 모양일수록 점수를 줌
     유리에 비친 하늘·철골은 색상각이 다르고(하늘 ≈ 205~210°, 보라 칠 ≈ 225~235°) 밝기가 높아(눈부심) 점수가 낮음
   - 도면 영역: 칠한 칸들을 세로 띠로 묶음 → 안내판처럼 한 사진에 층이 위아래로 여러 개면 위에서부터 여러 영역
   반환: { fill:'#rrggbb', hue, hueTol, coverage, blocks:[{ corners:[NW,NE,SE,SW] px, aspect(가로/세로), area }] } · 칠한 칸을 못 찾으면 null */
export function analyzePlanPhoto(image) {
  const s = Math.min(1, 640 / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * s)), h = Math.max(1, Math.round(image.height * s)), n = w * h;
  if (w < 32 || h < 32) return null;
  const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), hue = new Float32Array(n), ok = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (Math.min(image.height - 1, Math.round(y / s)) * image.width + Math.min(image.width - 1, Math.round(x / s))) * 4, p = y * w + x;
    const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn, L = (r + g + b) / 3;
    R[p] = r; G[p] = g; B[p] = b;
    hue[p] = c ? ((mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60) : -1;
    ok[p] = c >= 14 && c <= 95 && L >= 55 && L <= 225 ? 1 : 0;    // 아주 진한 아이콘·번호 동그라미와 흰·검정은 제외
  }
  const hist = new Float32Array(72);
  for (let p = 0; p < n; p++) if (ok[p]) hist[Math.floor(hue[p] / 5) % 72]++;
  const sm = hist.map((_, k) => hist[(k + 71) % 72] + 2 * hist[k] + hist[(k + 1) % 72]);
  const peaks = [...sm.keys()].filter(k => sm[k] > 0 && sm[k] >= sm[(k + 71) % 72] && sm[k] >= sm[(k + 1) % 72])
    .sort((a, b) => sm[b] - sm[a]).filter((k, i, a) => a.findIndex(j => Math.min(Math.abs(j - k), 72 - Math.abs(j - k)) < 3) === i).slice(0, 4);
  const TOL = 12, dh = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  let best = null;
  for (const k of peaks) {
    const h0 = k * 5 + 2.5, m = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (ok[p] && dh(hue[p], h0) <= TOL) m[p] = 1;
    const comps = components(open3(m, w, h), w, h);
    // 반듯한 칸 모양 덩어리. 하늘 반사는 색상각이 칠과 몇 도 차이라 한 봉우리에 섞이므로 밝기로 가름:
    // 반사 조각은 밝고(덩어리 평균 밝기 > 195) 칠한 칸은 그보다 어두움 → 어두운 덩어리만으로 점수·색을 냄
    const shaped = comps.filter(c => c.area >= n * .0004 && c.area / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) >= .45);
    const dark = shaped.filter(c => c.L / c.area <= 195);
    const use = dark.length ? dark : shaped;
    let score = 0;
    for (const c of use) score += c.area * c.area / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));
    if (!use.length) continue;
    if (!dark.length) score *= .3;                                             // 눈부신 반사뿐
    if (!best || score > best.score) {
      const mm = new Uint8Array(n); for (const c of use) for (const p of c.px) mm[p] = 1;   // 칠한 색은 고른 덩어리 픽셀에서만
      best = { score, h0, m:mm, comps:use };
    }
  }
  if (!best || best.score < n * .004) return null;
  // 칠한 색 = 덩어리 픽셀의 중앙값
  const rs = [], gs = [], bs = [];
  for (let p = 0; p < n; p += 2) if (best.m[p]) { rs.push(R[p]); gs.push(G[p]); bs.push(B[p]); }
  const med = a => a.sort((x, y) => x - y)[a.length >> 1], hex = v => v.toString(16).padStart(2, '0');
  const fill = '#' + hex(med(rs)) + hex(med(gs)) + hex(med(bs));
  // 세로 띠로 묶기: y 범위가 겹치거나 틈이 사진 높이의 4% 이하인 덩어리는 같은 층
  const comps = best.comps.sort((a, b) => a.y0 - b.y0), bands = [];
  for (const c of comps) {
    const b = bands.find(b => c.y0 <= b.y1 + h * .04 && c.y1 >= b.y0 - h * .04);
    if (b) { b.x0 = Math.min(b.x0, c.x0); b.x1 = Math.max(b.x1, c.x1); b.y0 = Math.min(b.y0, c.y0); b.y1 = Math.max(b.y1, c.y1); b.area += c.area; b.n++; }
    else bands.push({ x0:c.x0, x1:c.x1, y0:c.y0, y1:c.y1, area:c.area, n:1 });
  }
  for (let merged = true; merged;) { merged = false;          // 띠끼리 다시 겹치면 합침
    for (let i = 0; i < bands.length && !merged; i++) for (let j = i + 1; j < bands.length && !merged; j++) { const a = bands[i], b = bands[j];
      if (b.y0 <= a.y1 + h * .04 && b.y1 >= a.y0 - h * .04) { a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1); a.y0 = Math.min(a.y0, b.y0); a.y1 = Math.max(a.y1, b.y1); a.area += b.area; a.n += b.n; bands.splice(j, 1); merged = true; } } }
  const total = bands.reduce((t, b) => t + b.area, 0);
  const blocks = bands.filter(b => b.n >= 2 && b.area >= total * .08 && (b.x1 - b.x0) > w * .15).sort((a, b) => a.y0 - b.y0).map(b => {
    const pad = Math.round(Math.max(w, h) * .012), x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad), x1 = Math.min(w - 1, b.x1 + pad), y1 = Math.min(h - 1, b.y1 + pad);
    const P = (x, y) => [Math.min(image.width - 1, Math.round(x / s)), Math.min(image.height - 1, Math.round(y / s))];
    return { corners:[P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], aspect:(x1 - x0) / Math.max(1, y1 - y0), area:b.area / n };
  });
  if (!blocks.length) return null;
  return { fill, hue:Math.round(best.h0), hueTol:TOL + 4, coverage:total / n, blocks };

  function open3(m, w, h) {          // 3×3 침식 후 팽창: 글자 획·가는 반사선 제거
    const e = new Uint8Array(m.length), o = new Uint8Array(m.length);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { let all = 1; for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (!m[(y + dy) * w + x + dx]) { all = 0; break; } e[y * w + x] = all; }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (e[y * w + x]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) o[(y + dy) * w + x + dx] = 1;
    return o;
  }
  function components(m, w, h) {
    const lab = new Int32Array(m.length).fill(-1), out = [], Q = new Int32Array(m.length);
    for (let p0 = 0; p0 < m.length; p0++) {
      if (!m[p0] || lab[p0] >= 0) continue;
      let qh = 0, qt = 0; Q[qt++] = p0; lab[p0] = out.length;
      const c = { x0:w, y0:h, x1:0, y1:0, area:0, L:0 };
      while (qh < qt) { const q = Q[qh++], x = q % w, y = (q - x) / w; c.area++; c.L += (R[q] + G[q] + B[q]) / 3;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (const v of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1]) if (v >= 0 && m[v] && lab[v] < 0) { lab[v] = out.length; Q[qt++] = v; } }
      c.px = Q.slice(0, qt); out.push(c);
    }
    return out;
  }
}

function polygonArea(points) {
  return points.reduce((sum,[x,y],i) => {
    const [u,v] = points[(i+1)%points.length];
    return sum + x*v-y*u;
  },0)/2;
}

export function validCorners(points) {
  return points.length === 4 && polygonArea(points) > 10 &&
    points.every(([x,y],i) => {
      const [a,b] = points[(i+1)%4], [c,d] = points[(i+2)%4];
      return (a-x)*(d-b)-(b-y)*(c-a) > 3;
    });
}

// 층 번호: 지상 '3F' → 3, 지하 'B1'·'B1F' → −1 (0층은 없음 — B1 바로 위가 1F)
export const floorNumber = id => /^\d+F$/.test(id) ? Number(id.slice(0,-1)) : /^B\d+F?$/i.test(id) ? -parseInt(id.slice(1)) : null;
export const floorIdOf = n => n < 0 ? 'B' + (-n) : n + 'F';
export const isBelowGrade = f => f?.below === true || (floorNumber(f?.id ?? '') ?? 0) < 0;
export const occupiedFloorIds = floor => {
  if (floor.repeatUntil == null) return [floor.id];
  const n = floorNumber(floor.id), end = floor.repeatUntil;
  if (!n || !Number.isInteger(end) || end < n || end - n >= 100 || end > 999 || (n < 0 && end === 0))
    throw new Error('같은 도면을 적용할 마지막 층을 확인해 주세요. 한 그룹은 최대 100개 층입니다.');
  const ids = []; for (let k = n; k <= end; k++) if (k !== 0) ids.push(floorIdOf(k));
  return ids;
};

export function expandFloorGroups(recipe) {
  const ids = new Set(), sources = new Map();
  const floors = recipe.floors.flatMap(floor => occupiedFloorIds(floor).map(id => {
    if (ids.has(id)) throw new Error(id + ' 층이 다른 도면과 겹칩니다.');
    ids.add(id);
    sources.set(id,floor);
    const copy = structuredClone(floor);
    delete copy.repeatUntil;
    copy.id = id;
    if (id !== floor.id) for (const op of copy.ops) {
      if (op.room?.startsWith(floor.id+'-')) op.room = id + op.room.slice(floor.id.length);
      if (op.odu) op.odu = id + '-' + op.odu;
    }
    const idu = recipe.floorIduOverrides?.[id];
    if (idu) copy.ops = [...copy.ops.filter(op => op.op !== 'idu'),...structuredClone(idu)];
    return copy;
  }));
  if (floors.every(f => floorNumber(f.id) !== null)) floors.sort((a,b) => floorNumber(a.id)-floorNumber(b.id));
  return { recipe:{...recipe,floors}, sources };
}

export function floorResultFor(result, source, id) {
  const copy = structuredClone(result);
  if (source !== id) for (const room of copy.rooms) room.id = id + room.id.slice(source.length);
  return copy;
}
