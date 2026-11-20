// 트윈 building.json → 대시보드(웹) 데모 상태 (웹 Status 형식). 명령줄(tools/export-web-demo.mjs)과 웹 브라우저(건물 추가) 공용
//   호실 id = 트윈 실 id, idu = 트윈 실내기 id → 웹이 보낸 값을 트윈이 그대로 받아 같은 값을 그림
//   값은 난수 없이 실 id 해시로 정함 (같은 도면이면 항상 같은 기준값). 웹 목업이 여기에 5초마다 ±변동을 줌
export const USE_KO = { office:'연구실', admin:'사무실', lecture:'강의실', lab:'실험실', meeting:'회의실', lounge:'대기·휴게', waiting:'대기·휴게', restaurant:'식당', retail:'상점' };

const area = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; s += x0 * y1 - x1 * y0; } return Math.abs(s) / 2; };
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
const u = (id, k) => hash(`${id}#${k}`);
const hhmm = t => { const [h, m] = String(t).split(':').map(Number); return h + (m || 0) / 60; };
const kstNow = () => new Date(Date.now() + 9 * 3600_000);

// meta: { id, use, basis }
export function webStatus(B, meta = {}){
  const kst = kstNow(), month = kst.getUTCMonth() + 1, cooling = month >= 5 && month <= 9, mode = cooling ? 'cooling' : 'heating';
  const idusOf = {}; for (const a of B.idus || []) (idusOf[a.room] ||= []).push(a);
  const rooms = [];
  for (const f of B.floors) for (const r of f.rooms) {
    const acs = idusOf[r.id] || []; if (r.type !== 'room' || !acs.length) continue;
    const cap = r.capacity || 4;
    const occupants = u(r.id, 'occ') < .3 ? 0 : Math.round(cap * (.15 + .7 * u(r.id, 'n')));
    const onOff = occupants > 0 ? u(r.id, 'on') < .92 : u(r.id, 'on') < .22;   // 빈 방 운전(낭비) 일부
    const setpoint = (cooling ? [24, 25, 25, 26, 26] : [20, 21, 22, 22, 23])[Math.floor(u(r.id, 'sp') * 5)];
    const temp = onOff ? setpoint + (u(r.id, 't') - .5) * 1.6 : (cooling ? 26.5 : 18.2) + u(r.id, 't') * 1.5;
    const rated = acs.reduce((t, x) => t + (x.ratedKw || 2.8), 0);
    rooms.push({ id:r.id, idu:acs[0].id, idus:acs.map(x => x.id), name:r.name || r.id, floor:f.id, use:USE_KO[r.use] || '기타', areaM2:r1(area(r.polygon)), occupants, onOff, mode, setpoint,
      temp:r1(temp), humidity:r1(cooling ? 50 + u(r.id, 'h') * 15 : 33 + u(r.id, 'h') * 15), powerKw:onOff ? r2(rated * (.3 + .45 * u(r.id, 'kw')) * (occupants ? 1 : .6)) : 0, anomaly:null });
  }
  // 이상 1건: 운전 중인 큰 방 하나가 설정온도에 3℃ 넘게 못 미침 (웹의 설정온도 미도달 규칙)
  const bad = rooms.filter(r => r.onOff && r.idus.length >= 2).sort((p, q) => u(p.id, 'bad') - u(q.id, 'bad'))[0];
  if (bad) { bad.temp = r1(bad.setpoint + (cooling ? 3.6 : -3.6)); bad.powerKw = r2(bad.idus.length * 2.8 * .92); bad.anomaly = 'setpoint_unreached'; }
  const floors = B.floors.map(f => f.id), on = rooms.filter(r => r.onOff);
  return {
    generatedAt:kst.toISOString().slice(0, 19) + '+09:00', refreshSeconds:5, virtual:true,
    building:{ id:meta.id || B.building?.id, name:B.building?.name || meta.id, use:meta.use || '기타', virtual:false, basis:meta.basis || '트윈 도면 인식', floors, roomCount:rooms.length, areaM2:r1(rooms.reduce((t, r) => t + r.areaM2, 0)) },
    outdoorTemp:cooling ? 29.5 : 12.5, floors,
    summary:{ on:on.length, off:rooms.length - on.length, anomaly:rooms.filter(r => r.anomaly).length, powerKw:r1(on.reduce((t, r) => t + r.powerKw, 0)) },
    rooms,
  };
}

// 에너지 분석 목업의 건물 프로필 (운영 시간 = building.json operation)
export function webProfile(B, status){
  const op = B.operation?.weekday || ['09:00', '18:00'], s = status.building;
  return { id:s.id, name:s.name, areaM2:s.areaM2, floors:s.floors, uses:[...new Set(status.rooms.map(r => r.use))], hours:[Math.floor(hhmm(op[0])), Math.ceil(hhmm(op[1]))], weekend:!!B.operation?.weekend, waste:.12 };
}
