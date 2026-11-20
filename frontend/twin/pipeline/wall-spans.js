// Returns the solid segments left after subtracting the openings along this edge.
export function wallSpans(a, b, roomId, openings) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx,dy);
  if (len < 0.00001) return [];
  const intervals = [];
  for (const opening of openings) {
    if (!opening.rooms.includes(roomId)) continue;
    const { a:from, b:to } = opening;
    const cross = p => ((p[0]-a[0])*dy - (p[1]-a[1])*dx) / len;
    const along = p => ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (len*len);
    if (Math.max(Math.abs(cross(from)),Math.abs(cross(to))) > .25) continue;
    const [lo,hi] = [along(from),along(to)].sort((u,v) => u-v);
    if (hi > 0 && lo < 1 && hi-lo > 0.00001) intervals.push([Math.max(0,lo),Math.min(1,hi)]);
  }
  const point = t => [a[0]+dx*t,a[1]+dy*t];
  let at = 0;
  const result = [];
  for (const [lo,hi] of intervals.sort(([u],[v]) => u-v)) {
    if (lo > at + 0.00001) result.push([point(at),point(lo)]);
    at = Math.max(at,hi);
  }
  if (at < 1 - 0.00001) result.push([point(at),b]);
  return result;
}
