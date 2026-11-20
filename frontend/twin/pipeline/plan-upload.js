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

export const floorNumber = id => /^\d+F$/.test(id) ? Number(id.slice(0,-1)) : null;
export const occupiedFloorIds = floor => {
  if (floor.repeatUntil == null) return [floor.id];
  const n = floorNumber(floor.id), end = floor.repeatUntil;
  if (!n || !Number.isInteger(end) || end < n || end - n >= 100 || end > 999)
    throw new Error('같은 도면을 적용할 마지막 층을 확인해 주세요. 한 그룹은 최대 100개 층입니다.');
  return Array.from({length:end-n+1},(_,i) => (n+i)+'F');
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
