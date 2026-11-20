function rng(id) {
  let state = 2166136261;
  for (const c of id) state = Math.imul(state ^ c.charCodeAt(0), 16777619);
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function contains([x,y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length-1; i < ring.length; j = i++) {
    const [a,b] = ring[i], [c,d] = ring[j];
    if ((b > y) !== (d > y) && x < a + (c-a)*(y-b)/(d-b)) inside = !inside;
  }
  return inside;
}

function distanceToSegment([x,y], [a,b], [c,d]) {
  const dx = c-a, dy = d-b;
  const t = Math.min(1, Math.max(0, ((x-a)*dx + (y-b)*dy) / (dx*dx+dy*dy || 1)));
  return Math.hypot(x-a-t*dx,y-b-t*dy);
}

const side = ([x,y], [a,b], [c,d]) => (c-a)*(y-b) - (d-b)*(x-a);
const crosses = (a,b,c,d) => side(c,a,b)*side(d,a,b) < 0 && side(a,c,d)*side(b,c,d) < 0;

export function createPeopleWalk(room, partitions = []) {
  const random = rng(String(room.id)), { x,y,w,h } = room.b;
  const holes = room.poly.holes ?? [];
  const edges = [room.poly, ...holes].flatMap(ring => ring.map((a,i) => [a,ring[(i+1)%ring.length]]));
  for (const { a,b } of partitions) {
    if (Math.max(a[0],b[0]) >= x && Math.min(a[0],b[0]) <= x+w &&
        Math.max(a[1],b[1]) >= y && Math.min(a[1],b[1]) <= y+h) edges.push([a,b]);
  }
  const clear = p => contains(p,room.poly) && !holes.some(ring => contains(p,ring)) &&
    edges.every(([a,b]) => distanceToSegment(p,a,b) >= .23);
  const points = [];
  for (let i=0; i<550 && points.length<140; i++) {
    const p = [x+w*random(), y+h*random()];
    if (clear(p)) points.push(p);
  }
  const actors = [];
  const rest = actor => {
    actor.walking = false;
    actor.wait = 2.5 + random() * (room.cls ? 15 : 7);
  };
  function next(actor) {
    if (random() > (room.cls ? .27 : .74)) { rest(actor); return; }
    const start = [actor.x, actor.y];
    for (let i=0; i<16; i++) {
      const p = points[Math.floor(random()*points.length)], distance = Math.hypot(p[0]-actor.x, p[1]-actor.y);
      if (distance < .65 || distance > 7.5 || edges.some(([a,b]) => crosses(start,p,a,b))) continue;
      // Short samples also exclude paths grazing a corner or running too close to a partition.
      const segments = Math.ceil(distance/.32);
      let safe = true;
      for (let j=1; j<segments && safe; j++) {
        const k=j/segments;
        safe = clear([start[0]+(p[0]-start[0])*k,start[1]+(p[1]-start[1])*k]);
      }
      if (!safe) continue;
      actor.target = p; actor.walking = true;
      actor.angle = Math.atan2(p[0]-actor.x,p[1]-actor.y);
      return;
    }
    rest(actor);
  }
  return {
    update(count, dt) {
      const shown = points.length ? Math.max(0, Math.trunc(count) || 0) : 0;
      while (actors.length < shown) {
        const [x,y] = points[actors.length % points.length];
        actors.push({ x,y, angle:random()*Math.PI*2, wait:random()*5, speed:.68+random()*.5, phase:random()*Math.PI*2, walking:false });
      }
      actors.length = shown;
      if (dt > 0) for (const actor of actors) {
        if (!actor.walking) { actor.wait -= dt; if (actor.wait <= 0) next(actor); continue; }
        const dx = actor.target[0]-actor.x, dy = actor.target[1]-actor.y;
        const distance = Math.hypot(dx,dy), step = actor.speed*dt;
        if (step >= distance) { [actor.x,actor.y] = actor.target; rest(actor); continue; }
        actor.x += dx*step/distance; actor.y += dy*step/distance;
        actor.phase = (actor.phase + step * 10) % (2*Math.PI);
      }
      return actors;
    },
  };
}
