import { MARGIN, RES, wallMask } from './pipeline-core.js';
import { enclosedOutlines, extractRoof, filledInkOutline, inkOutlines } from './site-roof.js';

const loopsOf = footprint => !footprint?.length ? [] : Array.isArray(footprint[0][0]) ? footprint : [footprint];
const footprintOf = loops => loops.length === 1 ? loops[0] : loops;
const area = loop => Math.abs(loop.reduce((sum, [x, y], i) => {
  const [u, v] = loop[(i + 1) % loop.length];
  return sum + x * v - y * u;
}, 0)) / 2;

export function fitAnalysisImage(image, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  if (scale === 1) return image;
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = 4 * (Math.floor(y * image.height / height) * image.width + Math.floor(x * image.width / width));
    data.set(image.data.subarray(offset, offset + 4), 4 * (y * width + x));
  }
  return { width, height, data };
}

export function inferPlanFootprint(rect, width, depth, params, darkPlan = false) {
  const image = fitAnalysisImage(rect, 720);
  const walls = wallMask(image, width, depth, { ...params, dark:Math.min(params.dark, 32), close:2 }, [], false);
  const toMeter = (value, source, sample, limit) => Math.min(limit, Math.max(0, Math.round((value * source / sample / RES - MARGIN) * 100) / 100));
  const toFootprints = contours => contours.map(loop => loop.map(([x, y]) => [
      toMeter(x, rect.width, image.width, width), toMeter(y, rect.height, image.height, depth),
    ]).filter((point, i, list) => point.some((v, k) => v !== list[(i + 1) % list.length][k])))
      .filter(loop => loop.length >= 3 && area(loop) >= width * depth * .015);
  if (darkPlan) {
    const filled = filledInkOutline(Uint8Array.from(walls, (_,p) => {
      const o=p*4; return Math.max(image.data[o],image.data[o+1],image.data[o+2]) < 241 ? 1 : 0;
    }),image.width,image.height);
    const [loop] = filled ? toFootprints([filled]) : [];
    if (loop && area(loop) >= width * depth * .12 && area(loop) < width * depth * .8) return loop;
  }
  let best = [], bestCoverage = 0;
  for (const close of [0, 3, 7, 11]) {
    const loops = toFootprints(enclosedOutlines(walls, image.width, image.height, close))
      .filter(loop => !darkPlan || area(loop) < width * depth * .92);
    const coverage = loops.reduce((sum, loop) => sum + area(loop), 0) / (width * depth);
    if (coverage > bestCoverage * 1.18) { best = loops; bestCoverage = coverage; }
    if (bestCoverage > .5) break;
  }
  if (bestCoverage < .28) {
    const ink = Uint8Array.from(walls, (isWall, p) => {
      const o = p * 4;
      return Math.max(image.data[o], image.data[o + 1], image.data[o + 2]) < 163 ? 1 : 0;
    });
    const loops = toFootprints(inkOutlines(ink, image.width, image.height)).sort((a, b) => area(b) - area(a));
    const distinct = loops.filter((loop, i) => !loops.slice(0,i).some(a =>
      overlap([a], [loop], bounds([a, loop])) > .05 || loop.some(([x,y]) => contains(a, x, y))));
    const coverage = distinct.reduce((sum, loop) => sum + area(loop), 0) / (width * depth);
    if (coverage >= .14 && coverage > bestCoverage * 1.35) { best = distinct; bestCoverage = coverage; }
  }
  return bestCoverage >= .12 ? footprintOf(best) : null;
}

export function hasDrawingFrame(footprint, width, depth) {
  return loopsOf(footprint).some(loop => {
    const sides = new Set();
    for (const [x,y] of loop) {
      if (x < width*.025) sides.add('left');
      if (x > width*.975) sides.add('right');
      if (y < depth*.025) sides.add('top');
      if (y > depth*.975) sides.add('bottom');
    }
    return sides.size >= 3;
  });
}

// Align a clean plan outline to a site-heavy drawing of the same building.
// Only accept a match supported by strokes along most of the proposed boundary.
export function registerPlanOutline(rect, reference, width, depth, params) {
  const outlines = loopsOf(reference);
  if (outlines.length !== 1 || outlines[0].length < 6) return null;
  const sample = fitAnalysisImage(rect, 580), { width:w,height:h } = sample;
  const mask = wallMask(sample,width,depth,{...params,close:1},[],false);
  const distance = Float32Array.from(mask,v=>v?0:1000);
  for (let i=0;i<distance.length;i++) {
    if (i%w) distance[i]=Math.min(distance[i],distance[i-1]+1);
    if (i>=w) distance[i]=Math.min(distance[i],distance[i-w]+1);
  }
  for (let i=distance.length-1;i>=0;i--) {
    if (i%w!==w-1) distance[i]=Math.min(distance[i],distance[i+1]+1);
    if (i+w<distance.length) distance[i]=Math.min(distance[i],distance[i+w]+1);
  }
  const outline=outlines[0], box=bounds(outlines);
  const cx=box.x+box.w/2,cy=box.y+box.d/2;
  const points=outline.flatMap(([x,y],i)=>{
    const [a,b]=outline[(i+1)%outline.length], segments=Math.max(1,Math.ceil(Math.hypot(a-x,b-y)/1.8));
    return Array.from({length:segments},(_,j)=>[x+(a-x)*j/segments-cx,y+(b-y)*j/segments-cy]);
  });
  let best=null;
  const search=(scales, xs, ys)=>{
    for(const s of scales) for(const dx of xs) for(const dy of ys){
      let near=0,tight=0,score=0;
      for(const [x,y] of points){
        const X=Math.round((cx+dx+s*x+MARGIN)*RES*w/rect.width), Y=Math.round((cy+dy+s*y+MARGIN)*RES*h/rect.height);
        if(X<3||X>=w-3||Y<3||Y>=h-3)continue;
        const d=distance[Y*w+X];
        if(d<=6)near++;
        if(d<=3)tight++;
        score+=Math.max(0,1-d/10);
      }
      score=score/points.length-Math.abs(s-1)*.015;
      if(!best||score>best.score)best={s,dx,dy,score,near:near/points.length,tight:tight/points.length};
    }
  };
  const steps=(n,fn)=>Array.from({length:n},(_,i)=>fn(i));
  search(steps(11,i=>.68+i*.058),steps(15,i=>(i-7)*width*.018),steps(15,i=>(i-7)*depth*.018));
  const coarse=best;
  search(steps(7,i=>coarse.s+(i-3)*.014),steps(9,i=>coarse.dx+(i-4)*width*.005),steps(9,i=>coarse.dy+(i-4)*depth*.005));
  if(best.near<.61||best.tight<.39)return null;
  return (x,y)=>[cx+best.dx+best.s*(x-cx),cy+best.dy+best.s*(y-cy)];
}

function bounds(loops) {
  const points = loops.flat(), xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w:Math.max(...xs) - x, d:Math.max(...ys) - y };
}

function contains(loop, x, y) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [a, b] = loop[i], [c, d] = loop[j];
    if ((b > y) !== (d > y) && x < a + (c - a) * (y - b) / (d - b)) inside = !inside;
  }
  return inside;
}

function overlap(a, b, box) {
  let common = 0, either = 0;
  for (let j = 0; j < 36; j++) for (let i = 0; i < 36; i++) {
    const x = box.x + (i + .5) * box.w / 36, y = box.y + (j + .5) * box.d / 36;
    const inA = a.some(loop => contains(loop, x, y)), inB = b.some(loop => contains(loop, x, y));
    if (inA || inB) either++;
    if (inA && inB) common++;
  }
  return common / Math.max(1, either);
}

// The photo does not establish scale or north. Only keep candidates that agree with the top plan.
export function inferOverheadRoof(photo, footprint) {
  const reference = loopsOf(footprint);
  if (!reference.length || reference.length > 4) return null;
  const image = fitAnalysisImage(photo, 300), { width, height } = image;
  if (Math.min(width, height) < 40) return null;
  const seeds = [.5, .32, .68, .16, .84].flatMap(y => [.5, .32, .68, .16, .84].map(x => [width * x, height * y]));
  const { levels, axisDeg } = extractRoof(image, seeds, {
    areaRange:[.035, .8], shadow:false, panels:false, snap:false,
  });
  const candidates = levels.filter(({ polygon }) => polygon.length >= 3 && polygon.every(([x,y]) =>
    x > width * .015 && x < width * .985 && y > height * .015 && y < height * .985))
    .sort((a, b) => b.areaPx - a.areaPx).slice(0, 8);
  // A reflective roof can span several brightness bands. Its cool metal tone
  // is more consistent than the brightness of any individual roof facet.
  const cool = Uint8Array.from({length:width*height},(_,i)=>{
    const p=i*4, r=image.data[p], g=image.data[p+1], b=image.data[p+2];
    return b-r>5 && b-g>=0 && (r+g+b)/3>52 ? 1 : 0;
  });
  const metal = reference.length === 1 ? filledInkOutline(cool,width,height,.012) : null;
  if (metal) {
    const shade = [0,0,0]; let count=0;
    for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=2){
      if(!cool[y*width+x]||!contains(metal,x,y))continue;
      count++;
      for(let c=0;c<3;c++)shade[c]+=image.data[(y*width+x)*4+c];
    }
    if(count) candidates.push({polygon:metal,color:'#'+shade.map(x=>Math.round(x/count).toString(16).padStart(2,'0')).join('')});
  }
  const groups = reference.length === 1 ? candidates.map(c => [c]) : candidates.map((_, i) => candidates.slice(i, i + reference.length))
    .filter(group => group.length === reference.length);
  const box = bounds(reference);
  let best = null;
  const turns = [...new Set([0,90,180,270,...Array.from({length:4},(_,i)=>i*90-axisDeg),
    ...Array.from({length:24},(_,i)=>i*15)])];
  for (const group of groups) for (const turn of turns) {
    const angle = turn * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const rotated = group.map(c => c.polygon.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]));
    const src = bounds(rotated);
    const squeeze = Math.abs(Math.log((box.w / box.d) / (src.w / src.d)));
    if (!Number.isFinite(squeeze) || squeeze > .38) continue;
    const mapped = rotated.map(loop => loop.map(([x,y]) => [
      box.x + (x - src.x) * box.w / src.w, box.y + (y - src.y) * box.d / src.d,
    ]));
    // Match each disconnected roof to its own building before the renderer lofts it.
    const available = [...mapped];
    const ordered = reference.map(loop => {
      const b = bounds([loop]);
      const distance = candidate => {
        const c = bounds([candidate]);
        return Math.hypot(b.x + b.w / 2 - c.x - c.w / 2, b.y + b.d / 2 - c.y - c.d / 2);
      };
      available.sort((a, b) => distance(a) - distance(b));
      return available.shift();
    });
    if (reference.some((loop, i) => overlap([loop], [ordered[i]], bounds([loop, ordered[i]])) < .67)) continue;
    const score = overlap(reference, ordered, box) - squeeze * .23;
    if (score >= .65 && (!best || score > best.score)) {
      best = { score, footprint:footprintOf(ordered), color:group[0].color };
    }
  }
  return best;
}

export function applyAutomaticExterior(floors, roof) {
  for (let i = 0; i < floors.length - 1; i++) {
    const floor = floors[i], above = floors[i + 1], a = loopsOf(floor.footprint), b = loopsOf(above.footprint);
    if (floor.topFootprint || floor.below || above.below || floor.open || above.open || a.length !== 1 || b.length !== 1) continue;
    // Rounded plans with a substantial shared footprint can be joined as a sloped shell.
    // Rectangular wings and setbacks retain separate vertical façades.
    if (a[0].length < 9 || b[0].length < 9) continue;
    const match = overlap(a, b, bounds([...a, ...b]));
    if (match > .67 && match < .96) floor.topFootprint = b[0];
  }
  const top = floors.at(-1);
  if (roof && top?.id === roof.floor && !top.open && !top.topFootprint) top.topFootprint = roof.footprint;
}

// A raised, approximately symmetric shape above an otherwise level roofline.
export function inferFacadeDome(photo, footprint, floorHeight) {
  const reference = loopsOf(footprint);
  if (!reference.length) return null;
  const { width:w, height:h, data } = fitAnalysisImage(photo, 440);
  if (w < 100 || w < h * 1.25) return null;
  // 하늘: 파란 낮 하늘, 또는 맨 위 띠의 고른 바탕색(야경의 어두운 하늘·모형 사진의 흰 배경)과 비슷한 색
  const top = [];
  for (let y = 0; y < Math.max(2, Math.round(h * .05)); y++) for (let x = 0; x < w; x += 2) { const p = 4 * (y * w + x); top.push([data[p], data[p + 1], data[p + 2]]); }
  const bg = [0, 1, 2].map(c => top.map(v => v[c]).sort((p, q) => p - q)[top.length >> 1]);
  const plain = top.filter(v => Math.hypot(v[0] - bg[0], v[1] - bg[1], v[2] - bg[2]) > 40).length / top.length < .2;
  const sky = (x, y) => {
    const p = 4 * (y * w + x);
    if (data[p + 2] > data[p] * 1.2 && data[p + 2] > data[p + 1] + 8) return true;
    return plain && Math.hypot(data[p] - bg[0], data[p + 1] - bg[1], data[p + 2] - bg[2]) < 42;
  };
  const skyline = Array.from({ length:w }, (_, x) => {
    let clear = 0, solid = 0;
    for (let y = Math.round(h * .06); y < h * .82; y++) {
      if (sky(x, y)) { clear++; solid = 0; }
      else if (++solid >= 6 && clear >= h * .09) return y - solid + 1;
    }
    return h;
  });
  const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
  const smooth = skyline.map((_, x) => median(skyline.slice(Math.max(0, x - 3), Math.min(w, x + 4))));
  const flank = (from, to) => median(smooth.slice(Math.round(w * from), Math.round(w * to)));
  const left = flank(.12, .34), right = flank(.66, .88), base = (left + right) / 2;
  if (base >= h * .81 || Math.abs(left - right) > h * .045) return null;
  let peak = Math.round(w * .5);
  for (let x = Math.round(w * .3); x <= w * .7; x++) if (smooth[x] < smooth[peak]) peak = x;
  const rise = base - smooth[peak];
  if (rise < h * .13) return null;
  const spanAt = y => {
    let a = peak, b = peak;
    while (a > 0 && smooth[a - 1] < y) a--;
    while (b < w - 1 && smooth[b + 1] < y) b++;
    return [a, b];
  };
  const [a, b] = spanAt(base - rise * .14), span = b - a;
  if (span < w * .065 || span > w * .29 || rise < span * .55 || Math.abs((a + b) / 2 - peak) > span * .19) return null;
  const profile = [0, .16, .32, .49, .64, .77, .89, .96].map(t => {
    const [lo, hi] = spanAt(base - rise * Math.max(.14, t));
    return [(hi - lo) / span, t];
  });
  if (profile[3][0] < .32 || profile[3][0] > .91 || profile.at(-1)[0] > .36) return null;
  const box = bounds(reference), x = box.x + ((a + b) / 2 / w) * box.w, y = box.y + box.d / 2;
  if (!reference.some(loop => contains(loop, x, y))) return null;
  const radius = Math.min(span / w * box.w / 2, box.d * .22);
  profile.push([0, 1]);
  return { x, y, radius, height:Math.min((rise / w) * box.w, floorHeight * 7), profile };
}

// Only use a repeated skyline pattern when it can be separated from a bright sky.
// Heights are stored as a ratio of the photographed front's width.
export function inferFoldedRoof(photo) {
  const { width:w, height:h, data } = fitAnalysisImage(photo, 440);
  if (w < 150 || w < h * 1.25) return null;
  const light = (x, y) => {
    const i = 4 * (y * w + x);
    return .299 * data[i] + .587 * data[i+1] + .114 * data[i+2];
  };
  const median = values => [...values].sort((a,b) => a-b)[values.length >> 1];
  const skyline = Array.from({ length:w }, (_, x) => {
    for (let y = Math.max(5, Math.round(h * .12)); y < Math.min(h - 20, h * .61); y++) {
      const sky = (light(x,y-5) + light(x,y-3) + light(x,y-1)) / 3;
      const face = (light(x,y+4) + light(x,y+7) + light(x,y+10)) / 3;
      if (sky > 160 && sky - face > 26 && sky - (light(x,y+14) + light(x,y+19)) / 2 > 26) return y;
    }
    return null;
  });
  const smooth = skyline.map((_, x) => {
    const batch = skyline.slice(Math.max(0,x-4),x+5).filter(y => y !== null);
    return batch.length >= 5 ? median(batch) : null;
  });
  const central = smooth.slice(Math.round(w * .1), Math.round(w * .9)).filter(y => y !== null);
  if (central.length < w * .64) return null;
  const medianY = median(central);
  let start = Math.round(w * .05), end = Math.round(w * .95);
  while (start < end && (smooth[start] === null || smooth[start] > medianY + h * .13)) start++;
  while (end > start && (smooth[end] === null || smooth[end] > medianY + h * .13)) end--;
  const span = end - start;
  if (span < w * .65) return null;
  const points = [];
  for (let x = start; x <= end; x++) if (smooth[x] !== null && smooth[x] <= medianY + h * .13) points.push([x,smooth[x]]);
  if (points.length < span * .9) return null;
  const simplify = (a, b) => {
    const [x0,y0] = points[a], [x1,y1] = points[b];
    let peak = -1, deviation = h * .018;
    for (let i = a + 1; i < b; i++) {
      const [x,y] = points[i], error = Math.abs(y - (y0 + (y1 - y0) * (x - x0) / (x1 - x0)));
      if (error > deviation) { deviation = error; peak = i; }
    }
    return peak < 0 ? [points[a],points[b]] : [...simplify(a,peak).slice(0,-1),...simplify(peak,b)];
  };
  const roof = simplify(0, points.length - 1);
  const peaks = roof.filter(([,y], i) => i && i < roof.length - 1
    && Math.min(roof[i-1][1], roof[i+1][1]) - y >= h * .022
    && roof[i+1][0] - roof[i-1][0] >= w * .055);
  const base = Math.max(...roof.map(point => point[1]));
  if (peaks.length < 3 || peaks.length > 8 || base - Math.min(...roof.map(point => point[1])) > span * .28) return null;
  return roof.map(([x,y]) => [(x - start) / span, (base - y) / span]);
}

// Width taper for a long, rounded shell silhouetted against sky or vegetation.
export function inferFacadeTaper(photo) {
  const { width:w, height:h, data } = fitAnalysisImage(photo, 380);
  const rows = [];
  for (let y = Math.round(h * .15); y < h * .7; y++) {
    let first = -1, last = -1, gaps = 0, start = 0, width = 0;
    for (let x = 0; x < w; x++) {
      const p = 4 * (y * w + x), r = data[p], g = data[p + 1], b = data[p + 2];
      const material = b - g < 24 && g - r < 37 && r - b < 45 && (r + g + b) / 3 < 220;
      if (material) {
        if (first < 0) first = x;
        last = x; gaps = 0;
        if (last - first > width) { width = last - first; start = first; }
      } else if (++gaps > w * .028) { first = last = -1; }
    }
    rows.push({ y, x:start, width });
  }
  const peak = rows.reduce((best, row) => row.width > best.width ? row : best, { y:0, width:0 });
  if (peak.width < w * .65 || peak.y < h * .21 || peak.y > h * .55) return null;
  const widths = [.07, .11, .15].map(frac => {
    const band = rows.filter(row => Math.abs(row.y - (peak.y + frac * h)) < .024 * h).map(row => row.width).sort((a,b) => a-b);
    return (band[band.length >> 1] || 0) / peak.width;
  });
  if (!(widths[0] >= .64 && widths[0] <= .94 && widths[1] < widths[0] - .06 && widths[1] > .38 && widths[2] < widths[1] + .07)) return null;
  // Sample below the widest rim and inside the detected shell, away from sky and surrounding ground.
  const channels = [[], [], []];
  for (const { x, y, width } of rows) {
    if (y < peak.y + .045 * h || y > peak.y + .105 * h || width < peak.width * .55) continue;
    for (let col = Math.ceil(x + .25 * width); col < x + .75 * width; col += 3) {
      const i = 4 * (y * w + col), r = data[i], g = data[i+1], b = data[i+2];
      if (b-g >= 24 || g-r >= 37 || r-b >= 45) continue;
      channels[0].push(r); channels[1].push(g); channels[2].push(b);
    }
  }
  const color = channels[0].length ? '#' + channels.map(values => {
    values.sort((a,b) => a-b);
    return values[values.length >> 1].toString(16).padStart(2, '0');
  }).join('') : null;
  return { scale:Math.max(.42, widths[1]), color };
}

export function applyFacadeTaper(floors, taper) {
  if (!taper) return;
  const above = floors.filter(floor => !floor.below && !/^B\d+F?$/i.test(floor.id) && !floor.open), highest = above.at(-1);
  const outline = loopsOf(highest?.topFootprint ?? highest?.footprint);
  // The width profile is meaningful only when a rounded plan establishes the shell in plan.
  if (above.length < 2 || outline.length !== 1 || outline[0].length < 10) return;
  const loop = outline[0], box = bounds(outline), ratio = area(loop) / (box.w * box.d);
  if (ratio < .62 || ratio > .86 || box.w / box.d < 1.25) return;
  const cx = box.x + box.w / 2, cy = box.y + box.d / 2;
  const scaled = s => loop.map(([x,y]) => [cx + (x - cx) * s, cy + (y - cy) * s]);
  const position = step => taper + (1 - taper) * Math.sin(step / above.length * Math.PI / 2);
  above.forEach((floor, i) => {
    floor.shellFootprint = scaled(position(i));
    if (i < above.length - 1 || !floor.topFootprint) floor.topFootprint = scaled(position(i + 1));
  });
}

export function floorForRoomDetection(floor) {
  // A projected shell in a section drawing is larger than the walkable floor.
  // Only constrain auto-generated geometry; authored plans keep their own boundaries.
  if (floor.autoSpaces && floor.shellFootprint?.length && !floor.ops?.length) {
    return { ...floor, footprint:floor.shellFootprint };
  }
  return floor;
}
