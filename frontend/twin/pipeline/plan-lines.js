import { RES, wallMask, resolveFloor, floorRooms } from './pipeline-core.js';

function removeIsolatedMarks(mask, w, h) {
  const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let count = 1, x0 = w, y0 = h, x1 = 0, y1 = 0;
    queue[0] = i; seen[i] = 1;
    for (let j = 0; j < count; j++) {
      const p = queue[j], x = p % w, y = (p - x) / w;
      x0 = Math.min(x0,x); x1 = Math.max(x1,x); y0 = Math.min(y0,y); y1 = Math.max(y1,y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = p + dy*w + dx;
        if (x+dx >= 0 && x+dx < w && y+dy >= 0 && y+dy < h && mask[q] && !seen[q]) {
          seen[q] = 1; queue[count++] = q;
        }
      }
    }
    const width = x1-x0+1, height = y1-y0+1;
    if (Math.max(width,height) < RES * .45 ||
        (Math.min(width,height) >= RES * .2 && Math.max(width,height) < RES * .85 && count > width * height * .48)) {
      for (let j = 0; j < count; j++) mask[queue[j]] = 0;
    }
  }
}

function mergeParallelGaps(mask, w, h) {
  const merged = mask.slice();
  // Confirm a parallel run on each side of the gap before joining its strokes.
  // The gap is limited in plan metres, independent of the original image resolution.
  const maxGap = Math.round(RES * .15), arm = Math.ceil(RES * .17);
  for (const [dx,dy] of [[1,0],[0,1],[1,1],[1,-1]]) {
    const maxStep = Math.floor(maxGap / Math.hypot(dx,dy)) + 1;
    const across = dx + dy*w, along = -dy + dx*w;
    const supported = p => {
      let count = 0;
      for (let k = -arm; k <= arm; k++) count += mask[p + k*along];
      return count >= arm + 3;
    };
    const edge = maxStep + arm;
    for (let y = edge; y < h-edge; y++) for (let x = edge; x < w-edge; x++) {
      const p = y*w + x;
      if (!mask[p] || mask[p+across]) continue;
      let step = 2;
      while (step <= maxStep && !mask[p+step*across]) step++;
      if (step > maxStep || !supported(p) || !supported(p+step*across)) continue;
      for (let k = 1; k < step; k++) merged[p+k*across] = 1;
    }
  }
  return merged;
}

// Zhang–Suen thinning. Alternating passes preserve junctions and endpoints.
function thin(mask, w, h) {
  const active = [], remove = [];
  for (let y = 1; y < h-1; y++) for (let x = 1; x < w-1; x++) {
    const p = y*w+x;
    if (mask[p]) active.push(p);
  }
  for (let changed = true; changed && active.length;) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const p of active) {
        const n=mask[p-w], ne=mask[p-w+1], e=mask[p+1], se=mask[p+w+1];
        const s=mask[p+w], sw=mask[p+w-1], west=mask[p-1], nw=mask[p-w-1];
        const count = n+ne+e+se+s+sw+west+nw;
        if (count < 2 || count > 6) continue;
        const breaks = (1-n)*ne + (1-ne)*e + (1-e)*se + (1-se)*s +
          (1-s)*sw + (1-sw)*west + (1-west)*nw + (1-nw)*n;
        if (breaks !== 1) continue;
        if (pass === 0 ? n*e*s || e*s*west : n*e*west || n*s*west) continue;
        remove.push(p);
      }
      if (!remove.length) continue;
      changed = true;
      for (const p of remove) mask[p] = 0;
      remove.length = 0;
      let size = 0;
      for (const p of active) if (mask[p]) active[size++] = p;
      active.length = size;
    }
  }
}

export function normalizePlanLines(rect, width, depth, params) {
  const w = rect.width, h = rect.height;
  const mask = wallMask(rect, width, depth, { ...params, close:0 }, [], false);
  removeIsolatedMarks(mask,w,h);
  const lines = mergeParallelGaps(mask,w,h);
  thin(lines,w,h);
  const data = new Uint8ClampedArray(lines.length * 4).fill(255);
  for (let p = 0; p < lines.length; p++) if (lines[p]) data[p*4] = data[p*4+1] = data[p*4+2] = 0;
  return { width:w, height:h, data };
}

export function resolvePlanGeometry(floor, rect, width, depth, normalized) {
  const evaluate = image => {
    const res = resolveFloor(floor, image, width, depth);
    return { res, out:floorRooms(floor, res, width, depth) };
  };
  if (floor.mode !== 'auto' || !normalized) return evaluate(floor.mode === 'manual' ? null : rect);
  const cleaned = evaluate(normalized), reference = evaluate(rect);
  const count = entry => entry.out.rooms.filter(room => room.type === 'room').length;
  // A plan can contain faint walls that survive only in the original scan.
  return count(reference) > 0 && count(cleaned) < Math.max(1, count(reference) * .7) ? reference : cleaned;
}
