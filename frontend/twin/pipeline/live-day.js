// 오늘(실시간) 하루 만들기 — 계산 서버(tools/sim-runner.mjs, EnergyPlus)와 브라우저(pipeline/rc5.js, 5R1C 즉시 계산) 공용
import { baselineOf, occOf, modeOfMonth } from './energyplus.js';

/* ═════════════ 오늘(실시간) 하루 만들기 ═════════════
   트윈이 보낸 오늘 기록(twin.live/v1: 시간별 평균 재실·실내기 가동·설정온도·전력·외기 + 기상 예보)
   → EnergyPlus 하루 입력: 외기 24시간(지난 시간 = 실측, 남은 시간 = 예보), 실별 재실 24시간(지난 = 실측, 남은 = 시간표·용도 패턴 × 오늘 보정비),
     실별 가동 24시간(지난 = 실측, 남은 = 사람 있을 때 + 켜 두는 습관), 실별 설정온도(오늘 평균), 실측 냉방 전력(보정용) */
export const hmm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
export function liveDay(B, live, { schedule = null } = {}){
  const H = live.hours || {}, at = h => H[h] || H[String(h)], date = String(live.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('live.date가 없음 (YYYY-MM-DD)');
  const day = live.day || ['일', '월', '화', '수', '목', '금', '토'][new Date(date + 'T12:00:00Z').getUTCDay()];
  const now = Math.min(24, Math.max(0, +live.now || 0)), F = live.forecast || {};
  const series = (k, fk, d) => { const v = Array.from({ length:24 }, (_, h) => { const o = at(h)?.out?.[k]; return typeof o === 'number' ? o : typeof F[h]?.[fk] === 'number' ? F[h][fk] : null; });
    for (let h = 0; h < 24; h++) if (v[h] == null) { let a = h, b = h; while (a >= 0 && v[a] == null) a--; while (b < 24 && v[b] == null) b++; v[h] = a >= 0 && b < 24 ? v[a] + (v[b] - v[a]) * (h - a) / (b - a) : a >= 0 ? v[a] : b < 24 ? v[b] : d; }
    return v.map(x => Math.round(x * 10) / 10); };
  // 실측·예보가 하나도 없으면 계절 기본값 (냉방철 26°C·65%, 난방철 10°C·50%). 예보가 없으면 남은 시간은 마지막 실측값을 이어 씀
  const summer = modeOfMonth(+date.slice(5, 7)) === 'cool';
  const temp = series('temp', 'TMP', summer ? 26 : 10), hum = series('hum', 'REH', summer ? 65 : 50);
  const sky = Object.entries(F).filter(([h]) => h >= 9 && h <= 17).map(([, v]) => v.SKY).filter(Number.isFinite), skyAvg = sky.length ? sky.reduce((a, b) => a + b, 0) / sky.length : 1;
  const clear = Math.round((skyAvg <= 1.5 ? 1 : skyAvg <= 3.3 ? .7 : .45) * 100) / 100;
  const rain = Object.values(F).some(v => v.PTY > 0);
  const op = B.operation?.[day === '토' || day === '일' ? 'weekend' : 'weekday'], opH = h => !!op && h >= Math.floor(hmm(op[0]) / 60) && h < Math.ceil(hmm(op[1]) / 60);
  const cls = {}; for (const c of schedule?.classes || []) if (c.day === day) (cls[c.room] ||= []).push(c);
  const rooms = {}, hvac = Array(24).fill(null), measuredHours = [];
  for (let h = 0; h < 24; h++) { const x = at(h); if (!x?.rooms) continue; let k = 0, any = false;
    for (const v of Object.values(x.rooms)) if (typeof v.kw === 'number') { k += v.kw; any = true; }
    if (any && (x.minutes ?? 60) >= 10) { hvac[h] = Math.round(k * 100) / 100; measuredHours.push(h); } }
  for (const f of B.floors) for (const r of f.rooms) { if (r.type !== 'room') continue;
    const cap = r.capacity > 0 ? r.capacity : Math.max(1, Math.round(areaOf(r.polygon) * .05)), U = occOf(r.use);
    const expect = h => { if (cls[r.id]) { let n = 0; for (const c of cls[r.id]) { const o = Math.max(0, Math.min((h + 1) * 60, hmm(c.end)) - Math.max(h * 60, hmm(c.start))) / 60; n = Math.max(n, c.enrolled * .9 * o); } return n; }
      return U[h] > .05 ? U[h] * cap : 0; };
    const meas = h => { const v = at(h)?.rooms?.[r.id]; return typeof v?.occ === 'number' ? v.occ : null; };
    let sm = 0, se = 0; for (let h = 0; h < 24; h++) { const m = meas(h); if (m != null && !cls[r.id]) { sm += m; se += expect(h); } }
    const ratio = se > .5 ? Math.min(2, Math.max(.3, sm / se)) : 1;
    const occ = Array.from({ length:24 }, (_, h) => { const m = meas(h); return Math.round((m != null ? m : expect(h) * (cls[r.id] ? 1 : ratio)) * 10) / 10; });
    // 가동: 지난 시간 = 실측(30분 이상 켬), 남은 시간 = 운영시간 안에서 사람 있을 때 (+ 빈 방에 켜 두는 습관이면 계속)
    let habit = 0, onAny = false, sp = 0, sw = 0;
    for (let h = 0; h < 24; h++) { const v = at(h)?.rooms?.[r.id]; if (typeof v?.on !== 'number') continue; onAny = true;
      if (v.on >= .5 && (meas(h) ?? 1) < 1) habit++; if (typeof v.set === 'number' && v.on > 0) { sp += v.set * v.on; sw += v.on; } }
    const avail = Array.from({ length:24 }, (_, h) => { const v = at(h)?.rooms?.[r.id];
      if (h < Math.floor(now) && typeof v?.on === 'number') return v.on >= .5 ? 1 : 0;
      return opH(h) && (occ[h] >= 1 || habit >= 2) ? 1 : 0; });
    rooms[r.id] = { occ, avail, measured:onAny, ...(sw ? { set:Math.round(sp / sw * 2) / 2 } : {}) };
  }
  return { date, day, now, temp, hum, clear, rain, rooms, measured:{ hours:measuredHours, hvacKw:hvac } };
}
export const areaOf = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; s += x0 * y1 - x1 * y0; } return Math.abs(s) / 2; };
// 오늘 실제 운전 = 실별 실측 가동 시간·설정온도
export function liveBaseline(B, L, mode = modeOfMonth(+L.date.slice(5, 7))){
  const b = baselineOf(B, mode), rooms = {}; let t = 0, n = 0, h0 = 24, h1 = 0;
  for (const [id, x] of Object.entries(L.rooms)) { rooms[id] = { avail:x.avail, ...(x.set != null ? { coolSetpoint:x.set } : {}) };
    if (x.set != null) { t += x.set; n++; } x.avail.forEach((v, h) => { if (v) { h0 = Math.min(h0, h); h1 = Math.max(h1, h + 1); } }); }
  const p = v => String(v).padStart(2, '0') + ':00';
  return { ...b, name:'오늘 실제 운전', coolSetpoint:n ? Math.round(t / n * 2) / 2 : b.coolSetpoint, hours:h0 < h1 ? [p(h0), p(h1)] : b.hours, rooms, live:L.date,
    note:`오늘 ${L.date} 중앙제어기 기록(가동 시간·설정온도) + ${Math.floor(L.now)}시 이후는 재실 예상으로 이어서` };
}
