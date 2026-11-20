// 와이파이 접속자 수 ↔ 실별 재실 인원 (트윈 화면·명령줄 공용)
//
//   building.aps = [{ id, floor, pos:[x,y] m, room }]  ← 파이프라인이 와이파이 지도에서 만든 AP 위치
//   AP 한 대의 접속 기기 수는 주변 여러 방 사람들의 합이다. 그래서
//     방의 몫(가중치) = 방 넓이 × 거리 감쇠 exp(-d²/2σ²)  (d = AP에서 방 경계까지 거리, 방 안이면 0)
//                       × AP가 그 방 안에 있으면 3배
//   재실 인원 = Σ_AP (접속 기기 수 − 배경 기기) ÷ 1인당 기기 수 × 그 AP에서 방의 몫(AP별 합 1)
//   AP 반경(기본 18 m) 밖이라 어느 AP에도 안 잡히는 방은 '와이파이 없음' → 시간표·운영 패턴을 쓴다
export const WIFI = { devicesPerPerson:1.3, sigma:6, reach:18, ownRoom:3, background:1.5 };

const area = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; s += x0 * y1 - x1 * y0; } return Math.abs(s) / 2; };
const inPoly = (x, y, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const [xi, yi] = p[i], [xj, yj] = p[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
function distToPoly(x, y, p){
  if (inPoly(x, y, p)) return 0;
  let d = Infinity;
  for (let i = 0; i < p.length; i++) { const [ax, ay] = p[i], [bx, by] = p[(i + 1) % p.length], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)); d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy)); }
  return d;
}

// AP ↔ 방 가중치 표 (건물마다 한 번)
export function wifiModel(B, opt = {}){
  const o = { ...WIFI, ...(B.wifi || {}), ...opt }, aps = B.aps || [];
  if (!aps.length) return null;
  const rooms = Object.fromEntries(B.floors.flatMap(f => f.rooms.filter(r => r.type === 'room').map(r => [r.id, { id:r.id, floor:f.id, area:area(r.polygon), cap:r.capacity || 0, poly:r.polygon }])));
  const perAp = {}, perRoom = {};
  for (const a of aps) {
    const ws = [];
    for (const r of Object.values(rooms)) { if (r.floor !== a.floor) continue;
      const d = distToPoly(a.pos[0], a.pos[1], r.poly); if (d > o.reach) continue;
      ws.push([r.id, r.area * Math.exp(-d * d / (2 * o.sigma * o.sigma)) * (a.room === r.id && d === 0 ? o.ownRoom : 1)]); }
    const mx = Math.max(0, ...ws.map(w => w[1])), keep = ws.filter(w => w[1] >= mx * .02), s = keep.reduce((t, w) => t + w[1], 0);
    perAp[a.id] = Object.fromEntries(keep.map(([id, w]) => [id, w / s]));
    for (const [id, w] of keep) (perRoom[id] ||= {})[a.id] = w;
  }
  for (const m of Object.values(perRoom)) { const s = Object.values(m).reduce((t, w) => t + w, 0); for (const k in m) m[k] /= s; }
  return { opt:o, aps:Object.fromEntries(aps.map(a => [a.id, a])), perAp, perRoom, rooms };
}
export const coveredRooms = M => new Set(Object.keys(M?.perRoom || {}));

// 접속 기기 수 {apId: n} → 재실 인원 {roomId: 명} (와이파이로 잡히는 방만)
//   prior {roomId: 예상 인원} (선택): 학사 시간표처럼 '지금 이 방에 사람이 있을 것'이라는 정보 →
//   한 AP를 여러 방이 나눌 때 수업 중인 방에 더 많이 나눠 줌 (가중치 × (1 + 4 × 예상/정원))
export function occupancyFromWifi(M, wifi, prior = null){
  if (!M || !wifi) return {};
  const occ = {}, dpp = M.opt.devicesPerPerson;
  for (const id of coveredRooms(M)) occ[id] = 0;
  for (const [ap, v] of Object.entries(wifi)) {
    const n = typeof v === 'number' ? v : +(v?.clients ?? v?.count ?? 0), w = M.perAp[ap]; if (!w || !(n > 0)) continue;
    const people = Math.max(0, n - M.opt.background) / dpp;
    let ks = Object.entries(w);
    if (prior) { ks = ks.map(([id, k]) => [id, k * (1 + 4 * Math.min(1, (prior[id] || 0) / Math.max(M.rooms[id]?.cap || 10, 1)))]); const t = ks.reduce((a, x) => a + x[1], 0); ks = ks.map(([id, k]) => [id, k / t]); }
    for (const [id, k] of ks) occ[id] += people * k;
  }
  for (const id in occ) { const cap = M.rooms[id]?.cap; occ[id] = Math.round(cap ? Math.min(occ[id], cap * 1.2) : occ[id]); }
  return occ;
}

