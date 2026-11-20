import * as THREE from 'three';

// Carry the façade silhouette along the building's principal direction.
// Shift the section along its centerline without squeezing all creases into a narrow tip.
export function foldedRoofGeometry(footprint, profile, width, depth, maxRise) {
  const surface = [], sides = [];
  for (const loop of footprint) {
    if (loop.length < 3) continue;
    const [cx, cy] = loop.reduce(([a,b],[x,y]) => [a+x/loop.length,b+y/loop.length],[0,0]);
    let xx = 0, yy = 0, xy = 0;
    for (const [x,y] of loop) {
      xx += (x-cx)**2;
      yy += (y-cy)**2;
      xy += (x-cx)*(y-cy);
    }
    const angle = .5 * Math.atan2(2*xy,xx-yy), ux = Math.cos(angle), uy = Math.sin(angle);
    const local = ([x,y]) => [x*ux+y*uy,-x*uy+y*ux];
    const perimeter = loop.map(local);
    const longitudinal = perimeter.map(point => point[0]);
    const min = Math.min(...longitudinal), max = Math.max(...longitudinal);
    const boundsAt = value => {
      const t = Math.min(max - 1e-5, Math.max(min + 1e-5, value));
      let left = Infinity, right = -Infinity;
      for (let i = 0; i < perimeter.length; i++) {
        const [a,b] = perimeter[i], [c,d] = perimeter[(i+1)%perimeter.length];
        if ((a > t) === (c > t)) continue;
        const v = b + (d-b)*(t-a)/(c-a);
        left = Math.min(left,v); right = Math.max(right,v);
      }
      return [left,right];
    };
    const widths = [.2,.35,.5,.65,.8].map(f => {const [a,b] = boundsAt(min + (max-min)*f);return b-a;}).sort((a,b)=>a-b);
    const span = widths[2];
    if (!Number.isFinite(span) || span <= .1) continue;
    const slices = Array.from({length:81},(_,i)=>boundsAt(min+(max-min)*i/80));
    const stable = slices.map((_,i)=>{
      const neighbors=slices.slice(Math.max(0,i-8),i+9).filter(([a,b])=>b-a>=span*.5);
      if(!neighbors.length)return (slices[i][0]+slices[i][1])/2;
      return neighbors.reduce((sum,[a,b])=>sum+(a+b)/2,0)/neighbors.length;
    });
    const sectionHeight = point => {
      const [t,v] = local(point), index=Math.min(79.999,Math.max(0,(t-min)/(max-min)*80)), lo=Math.floor(index);
      const weight=index-lo;
      const center=stable[lo]*(1-weight)+stable[lo+1]*weight;
      const s = Math.min(1, Math.max(0, .5+(v-center)/span));
      const i = profile.findIndex(p => p[0] >= s);
      if (i <= 0) return Math.min(maxRise, span * (profile[i === 0 ? 0 : profile.length - 1][1]));
      const [a,b] = profile[i-1], [c,d] = profile[i];
      return Math.min(maxRise,span*(b+(d-b)*(s-a)/(c-a)));
    };
    const vertex = ([x,y], height) => [x-width/2,height,y-depth/2];
    const lift = p => vertex(p,sectionHeight(p));
    const mid = (a,b) => [(a[0]+b[0])/2,(a[1]+b[1])/2];
    const dist = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
    const spacing = Math.max(.55,span/50);
    const triangle = (a,b,c,limit) => {
      if (!limit) {
        surface.push(...lift(a),...lift(c),...lift(b));
        return;
      }
      const ab=mid(a,b), bc=mid(b,c), ca=mid(c,a);
      triangle(a,ab,ca,limit-1); triangle(ab,b,bc,limit-1);
      triangle(ca,bc,c,limit-1); triangle(ab,bc,ca,limit-1);
    };
    const vectors = loop.map(([x,y]) => new THREE.Vector2(x,y));
    const subdivisions = max-min > 80 ? 5 : 4;
    for (const [a,b,c] of THREE.ShapeUtils.triangulateShape(vectors,[])) triangle(loop[a],loop[b],loop[c],subdivisions);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i+1)%loop.length], count = Math.max(1,Math.ceil(dist(a,b)/spacing));
      for (let k = 0; k < count; k++) {
        const point = t => [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
        const p = point(k/count), q = point((k+1)/count);
        const po = vertex(p,0), qo = vertex(q,0), pi = lift(p), qi = lift(q);
        sides.push(...po,...qi,...pi,...po,...qo,...qi);
      }
    }
  }
  const geometry = (positions,weld = false) => {
    const data = new THREE.BufferGeometry();
    if (weld) {
      const indices=[], vertices=[], lookup=new Map();
      for(let i=0;i<positions.length;i+=3){
        const v=positions.slice(i,i+3), key=v.map(value=>Math.round(value*10000)).join(',');
        if(!lookup.has(key)){lookup.set(key,vertices.length/3);vertices.push(...v);}
        indices.push(lookup.get(key));
      }
      data.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
      data.setIndex(indices);
    } else data.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    data.computeVertexNormals();
    return data;
  };
  return surface.length ? { roof:geometry(surface,true), sides:geometry(sides) } : null;
}
