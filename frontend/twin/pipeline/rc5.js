/* ═══════════════════════════════════════════════════════════════════════════
   5R1C 즉시 계산 (ISO 13790 시간별 간이법) — 브라우저·명령줄 공용, 1초 안팎
   설계(노션 3차 초안): "실시간·what-if는 5R1C로 즉시 계산, 계수는 오프라인에서 EnergyPlus 결과로 보정"
   - 실 하나 = 5R1C 하나. 파라미터는 EnergyPlus 입력(pipeline/energyplus.js)과 같은 형상·재료·발열·운전 가정에서 뽑음
     → 같은 오늘 하루(pipeline/live-day.js)를 두 엔진이 같은 조건으로 계산하고, 차이는 tools/calibrate-5r1c.mjs가 잼
   - step5R1C: 코덱스 실험 엔진(tools/experiment-5r1c.mjs)의 계산식 그대로 (질량 노드를 구간 안에서 정확 적분)
   - 15분 간격, 같은 하루를 3번 돌려 축열을 맞춘 뒤 4번째 하루를 결과로 씀 (EnergyPlus 설계일 예열과 같은 방식)
   ═══════════════════════════════════════════════════════════════════════════ */
import { EP_USE, BUSAN, priceAt, inFootprint, coveredBy } from './energyplus.js';

const AIR = 1206;                                    // 공기 열용량 J/(m³·K)
const r3 = v => Math.round(v * 1000) / 1000;
const area = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; s += x0 * y1 - x1 * y0; } return s / 2; };
const inPoly = (x, y, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const [xi, yi] = p[i], [xj, yj] = p[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };

// 재료 = energyplus.js와 같음 (콘크리트 200 + 단열 80 + 석고 13, 복층 로이 U 1.8 · SHGC 0.40), 표면 열저항 Rsi 0.13 · Rse 0.04
export const U = { wall:1 / (.13 + .2 / 1.95 + .08 / .035 + .013 / .16 + .04), roof:1 / (.1 + .08 / .035 + .2 / 1.95 + .04), slab:1 / (.17 + .2 / 1.95), win:1.8 };
const SHGC = .40, ALPHA = .7, RSE = .04;
const GROUND = [18, 18, 19, 20, 21, 22, 23, 24, 24, 23, 21, 19];   // energyplus.js 지면 온도
// 내부 발열 가정 = energyplus.js (사람 120W 중 현열 약 60% · 복사 30%, 조명 복사+가시 60%, 기기 복사 30%)
const PERSON_SENS = 72, PERSON_RAD = .3, LIGHT_RAD = .6, EQUIP_RAD = .3;

// 코덱스 tools/experiment-5r1c.mjs의 계산식 (공기·표면 노드는 대수식, 질량 노드는 구간 안 일정 조건으로 정확 적분)
export function step5R1C(model, massC, forcing, hvacW = 0, stepS = 900) {
  const { air_surface_W_K:hAs, mass_surface_W_K:hMs, mass_outdoor_W_K:hMe, window_outdoor_W_K:hWe, mass_capacity_J_K:capacity } = model;
  const { outdoorC, airExchangeWK:hVe, airGainW, surfaceGainW, massGainW } = forcing;
  const airCoupling = hAs + hVe;
  const airToOut = hAs * (hVe / airCoupling);
  const surfaceCoupling = hMs + hWe + airToOut;
  const airHeat = airGainW + hvacW;
  const surfaceBase = ((hWe + airToOut) * outdoorC + surfaceGainW + hAs / airCoupling * airHeat) / surfaceCoupling;
  const massLoss = hMe + hMs * ((hWe + airToOut) / surfaceCoupling);
  const equilibrium = (hMe * outdoorC + hMs * surfaceBase + massGainW) / massLoss;
  const x = massLoss * stepS / capacity;
  const endWeight = -Math.expm1(-x);
  const meanWeight = x < 1e-4 ? x * (0.5 - x / 6) : 1 - endWeight / x;
  const meanMass = massC + (equilibrium - massC) * meanWeight;
  const meanSurface = surfaceBase + hMs / surfaceCoupling * meanMass;
  return { massC:massC + (equilibrium - massC) * endWeight, meanAirC:(hAs * meanSurface + hVe * outdoorC + airHeat) / airCoupling };
}

/* ── 실별 5R1C 파라미터 (ISO 13790 §12.2, 중량 구조 'medium': Am = 2.5·Af, Cm = 165 kJ/(m²·K)·Af) ──
   외벽·창·지붕·지면은 energyplus.js와 같은 규칙으로 찾음: 층 윤곽 밖에 닿은 변 = 외벽, 1.2m 넘는 외벽엔 창(양끝 0.3m, 창대~창머리),
   위층 윤곽이 덮지 않은 곳 = 지붕, 1층 바닥 = 지면. 실 사이 벽·중간층 바닥은 단열(열은 안 넘김, 축열엔 참여) */
//   k = 보정 계수 { cap 열용량, env 외피·창 열손실, solar 일사 취득, couple 질량–표면 결합(EnergyPlus 자연대류 표면 열전달이 ISO 기본값보다 약함) } (tools/calibrate-5r1c.mjs가 EnergyPlus에 맞춰 정함, 없으면 1)
export function roomParams(B, k = {}){
  const kc = k.cap ?? 1, ke = k.env ?? 1, ks = k.solar ?? 1, km = k.couple ?? 1;
  const W = B.building.size.w, D = B.building.size.d, FH = B.building.floorHeight || 3.6;
  const win = B.building.window || { sill:.8, head:2.3 }, head = Math.min(win.head, FH - .15), sill = Math.min(win.sill, head - .3), wh = head - sill;
  const north = B.site?.northDeg ?? 0, out = {};
  const kw = {}, hkw = {}, inKw = {};
  for (const a of B.idus || []) { kw[a.room] = (kw[a.room] || 0) + (a.coolKw || 0); hkw[a.room] = (hkw[a.room] || 0) + (a.heatKw || (a.coolKw || 0) * 1.1); inKw[a.room] = (inKw[a.room] || 0) + (a.ratedKw || 0); }
  const below = f => f.below === true || /^B\d+F?$/i.test(f.id);      // 지하층: 외벽·바닥이 흙(지면 온도)에 닿고 창·일사·지붕 없음
  B.floors.forEach((f, li) => {
    const under = below(f), above = B.floors[li + 1];
    const covered = (x, y) => coveredBy(above, x, y, W, D), inFoot = (x, y) => inFootprint(x, y, f.footprint, W, D);
    for (const r of f.rooms) {
      if (r.type !== 'room') continue;
      const Af = Math.abs(area(r.polygon)) - (r.holes || []).reduce((t, h) => t + Math.abs(area(h)), 0); if (!(Af > .5)) continue;
      const xs = r.polygon.map(p => p[0]), ys = r.polygon.map(p => p[1]), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const roof = !under && !covered(cx, cy), ground = li === 0;
      let Aop = 0, Agw = 0; const wins = [], walls = [];
      r.polygon.forEach((p, i) => {
        const q = r.polygon[(i + 1) % r.polygon.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]); if (len < .3) return;
        const nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len, mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        const outA = !inFoot(mx + nx * .4, my + ny * .4), outB = !inFoot(mx - nx * .4, my - ny * .4); if (!outA && !outB) return;
        if (under) { Agw += len * FH; return; }                           // 흙에 닿은 벽
        const [ox, oy] = outA ? [nx, ny] : [-nx, -ny];                    // 바깥쪽 법선 (도면: x 동쪽, y 남쪽)
        const az = Math.atan2(-ox, oy) * 180 / Math.PI + north;            // 남쪽 기준 방위각 (서쪽 +)
        const Aw = len >= 1.2 ? (len - .6) * wh : 0;
        Aop += len * FH - Aw; walls.push({ az, a:len * FH - Aw }); if (Aw) wins.push({ az, a:Aw });
      });
      // 실내 표면적: ISO 기본 4.5·Af, 단 작은 칸(매점·키오스크)은 벽이 바닥보다 훨씬 커서 실제 둘레 × 층높이 + 바닥·천장을 씀
      //   (기본값을 그대로 쓰면 1~4 m² 칸에서 표면·열용량이 너무 작아 일사가 갈 곳이 없어 50°C까지 오름 — 부산역 보정에서 발견)
      const perim = r.polygon.reduce((t, p, i) => { const q = r.polygon[(i + 1) % r.polygon.length]; return t + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0);
      const At = Math.max(4.5 * Af, 2 * Af + perim * FH), sA = At / (4.5 * Af);
      const Aw = wins.reduce((t, w) => t + w.a, 0), Hop = U.wall * Aop + (roof ? U.roof * Af : 0), Am = 2.5 * Af * sA, Hms = 9.1 * Am * km;
      const Hem = Hop > 0 ? 1 / (1 / Hop - 1 / Hms) : 0, Hg = (ground ? U.slab * Af : 0) + U.wall * Agw;
      const use = EP_USE[r.use] ? r.use : 'office';
      out[r.id] = { id:r.id, floor:f.id, use, area:r3(Af), volume:r3(Af * FH), people:r.capacity > 0 ? r.capacity : r3(Af * .05), roof, ground, wins, walls, ks,
        model:{ air_surface_W_K:3.45 * At, mass_surface_W_K:Hms, mass_outdoor_W_K:(Hem + Hg) * ke, window_outdoor_W_K:U.win * Aw * ke, mass_capacity_J_K:165000 * Af * sA * kc },
        Hg:Hg * ke, coolW:(kw[r.id] || 0) * 1000, heatW:(hkw[r.id] || 0) * 1000, cop:inKw[r.id] ? kw[r.id] / inKw[r.id] : 3.2,
        lightsW:EP_USE[use].lights * Af, equipW:EP_USE[use].equip * Af };
    }
  });
  return out;
}

/* ── 맑은 하늘 일사 (ASHRAE 1972 월별 A·B·C, energyplus.js 설계일 'ASHRAEClearSky'와 같은 모델) × 하늘 맑음 비율 ── */
const ASH = { A:[1230, 1215, 1186, 1136, 1104, 1088, 1085, 1107, 1151, 1192, 1221, 1233], B:[.142, .144, .156, .180, .196, .205, .207, .201, .177, .160, .149, .142], C:[.058, .060, .071, .097, .121, .134, .136, .122, .092, .073, .063, .057] };
export function sunAt(date, hourKst, site = BUSAN){
  const [y, m, d] = date.split('-').map(Number), n = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
  const rad = Math.PI / 180, decl = 23.45 * Math.sin(rad * 360 / 365 * (284 + n)), B2 = rad * 360 * (n - 81) / 364;
  const eot = 9.87 * Math.sin(2 * B2) - 7.53 * Math.cos(B2) - 1.5 * Math.sin(B2);                    // 균시차 (분)
  const solar = hourKst + (4 * (site.lon - 15 * site.tz) + eot) / 60, H = 15 * (solar - 12) * rad, lat = site.lat * rad, dc = decl * rad;
  const sinAlt = Math.sin(lat) * Math.sin(dc) + Math.cos(lat) * Math.cos(dc) * Math.cos(H);
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dc) * Math.cos(lat)) / rad;   // 남쪽 기준, 서쪽 +
  return { sinAlt, alt:Math.asin(Math.max(-1, Math.min(1, sinAlt))), az, m };
}
function irradiance(sun, clear){
  if (sun.sinAlt <= .02) return { dn:0, dh:0, gh:0 };
  const dn = ASH.A[sun.m - 1] * Math.exp(-ASH.B[sun.m - 1] / sun.sinAlt) * clear, dh = ASH.C[sun.m - 1] * dn;
  return { dn, dh, gh:dn * sun.sinAlt + dh };
}
const onWall = (I, sun, azWall) => { const cos = Math.cos(sun.alt) * Math.cos((sun.az - azWall) * Math.PI / 180);
  return I.dn * Math.max(0, cos) + I.dh * .5 + .2 * I.gh * .5; };                                    // 직달 + 확산(반구 절반) + 지면 반사 0.2

/* ── 하루 계산 ──
   L = liveDay() 결과(오늘 외기 24시간·실별 재실·가동), sc = 운전(liveBaseline 형식: mode, coolSetpoint, rooms{ avail, coolSetpoint, spWindow })
   only = 이 실들만 계산 (나머지는 결과에 없음, 서로 열을 주고받지 않으니 결과는 같음) */
export function simulateDay(P, L, sc, { tariff = null, only = null } = {}){
  const heat = sc.mode === 'heat', month = +L.date.slice(5, 7), Tg = GROUND[month - 1], clear = L.clear ?? 1;
  const SUB = 4, dt = 3600 / SUB, ids = (only || Object.keys(P)).filter(id => P[id]);
  const sunH = Array.from({ length:24 * SUB }, (_, k) => { const s = sunAt(L.date, (k + .5) / SUB); return { s, I:irradiance(s, clear) }; });
  const eir = T => heat ? Math.min(1.4, Math.max(.8, 1 + .02 * (7 - T))) : Math.min(1.2, Math.max(.6, 1 + .02 * (T - 35)));
  const spOf = (id, t) => { const rs = sc.rooms?.[id] || {}, w = rs.spWindow; if (w && t >= w.from && t < w.to) return w.sp; return w ? w.base : rs.coolSetpoint ?? sc.coolSetpoint; };
  const rooms = {}, hourlyKwh = Array(24).fill(0), hourlyWon = Array(24).fill(0);
  for (const id of ids) {
    const p = P[id], live = L.rooms[id] || {}, occ = live.occ || Array(24).fill(0), avail = sc.rooms?.[id]?.avail || live.avail || Array(24).fill(0);
    const peak = Math.max(p.people, ...occ, 1e-6), cap = heat ? p.heatW : p.coolW * .75;              // 냉방 = 현열 능력 (EnergyPlus SHR 0.75)
    let mass = L.temp[0], air = L.temp[0];
    const hT = Array(24).fill(0), hE = Array(24).fill(0), hQ = Array(24).fill(0);
    for (let day = 0; day < 4; day++) for (let k = 0; k < 24 * SUB; k++) {
      const h = Math.floor(k / SUB), t = k / SUB, To = L.temp[h], { s, I } = sunH[k];
      const frac = occ[h] / peak, lf = Math.max(.1, Math.min(1, frac > 0 ? frac + .3 : .1));
      const ppl = occ[h] * PERSON_SENS, lights = p.lightsW * lf, equip = p.equipW * lf;
      const solarWin = p.wins.reduce((a, w) => a + onWall(I, s, w.az) * w.a, 0) * SHGC * p.ks;
      const solAir = p.ks * ALPHA * RSE * (U.wall * p.walls.reduce((a, w) => a + onWall(I, s, w.az) * w.a, 0) + (p.roof ? U.roof * p.area * I.gh : 0));
      const rad = ppl * PERSON_RAD + lights * LIGHT_RAD + equip * EQUIP_RAD + solarWin;
      const on = !!avail[h];
      // 환기: 침기 0.3회/h + 운전 안 하는 시간 문·복도 2회/h + 난방철 실온 25°C 넘고 외기보다 2°C 높으면 창 3회/h (energyplus.js와 같은 가정)
      const ach = .3 + (sc.rooms && !on ? 2 : 0) + (heat && air > 25 && air > To + 2 ? 3 : 0);
      const forcing = { outdoorC:To, airExchangeWK:AIR * ach * p.volume / 3600, airGainW:ppl * (1 - PERSON_RAD) + lights * (1 - LIGHT_RAD) + equip * (1 - EQUIP_RAD),
        surfaceGainW:rad / 2, massGainW:rad / 2 + solAir + p.Hg * (Tg - To) };
      const free = step5R1C(p.model, mass, forcing, 0, dt);
      let res = free, q = 0;
      if (on && cap > 0) { const sign = heat ? 1 : -1, sp = spOf(id, t), need = (sp - free.meanAirC) * sign;
        if (need > 0) { const full = step5R1C(p.model, mass, forcing, sign * cap, dt), chg = (full.meanAirC - free.meanAirC) * sign;
          q = chg <= need ? cap : cap * need / chg; res = q === cap ? full : step5R1C(p.model, mass, forcing, sign * q, dt); } }
      mass = res.massC; air = res.meanAirC;
      if (day === 3) { hT[h] += air / SUB; const e = q * dt / 3.6e6, el = e / p.cop * eir(To); hQ[h] += e; hE[h] += el; }
    }
    rooms[id] = { hourlyT:hT.map(r3), hourlyKwh:hE.map(r3), hvacKwh:r3(hQ.reduce((a, b) => a + b, 0)), elecKwh:r3(hE.reduce((a, b) => a + b, 0)) };
    hE.forEach((v, h) => { hourlyKwh[h] += v; hourlyWon[h] += v * priceAt(tariff, month, h); });
  }
  return { engine:'5R1C', mode:heat ? 'heat' : 'cool', rooms, hourlyKwh:hourlyKwh.map(r3), hourlyWon:hourlyWon.map(v => Math.round(v)), elecKwh:r3(hourlyKwh.reduce((a, b) => a + b, 0)) };
}

/* ── 지금부터 N시간 what-if (EnergyPlus 경로 tools/sim-runner.mjs compare의 window와 같은 정의) ──
   기준 = 현재 설정 유지(오늘 실제 운전 + 이후 재실 예상), 선택 = 대상 실만 그 구간 설정온도 변경
   calib = tools/calibrate-5r1c.mjs 결과(rc5-calibration.json) → 그 모드의 계수 k로 파라미터를 맞추고 전력에 factor를 곱함. 없으면 ISO 기본값 그대로 */
export function whatIf(B, L, base, { rooms = null, setpoint, hours = 2, tariff = null, calib = null } = {}){
  const C = calib?.modes?.[base.mode === 'heat' ? 'heat' : 'cool'] || null, P = roomParams(B, C?.k);
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const n = Math.min(12, Math.max(.25, +hours || 2)), from = Math.floor(L.now * 4) / 4, to = Math.min(24, from + Math.round(n * 4) / 4);
  const sp = Math.min(30, Math.max(16, +setpoint)), targets = (rooms?.length ? rooms : Object.keys(L.rooms)).filter(id => P[id]);
  const sc = { ...base, rooms:{ ...base.rooms } };
  for (const id of targets) sc.rooms[id] = { ...sc.rooms[id], spWindow:{ from, to, sp, base:sc.rooms[id]?.coolSetpoint ?? base.coolSetpoint } };
  const b = simulateDay(P, L, base, { tariff, only:targets }), s = simulateDay(P, L, sc, { tariff, only:targets });
  const f = C?.factor ?? 1, r = v => Math.round(v * 1000) / 1000, part = h => Math.max(0, Math.min(h + 1, to) - Math.max(h, from));
  const side = R => { let t = 0, w = 0, mx = null;
    for (const id of targets) { const x = R.rooms[id]; for (let h = Math.floor(from); h < Math.ceil(to); h++) { const p = part(h); if (!p || !L.rooms[id]?.avail?.[h]) continue; t += x.hourlyT[h] * p; w += p; mx = Math.max(mx ?? -99, x.hourlyT[h]); } }
    return { kwh:r(R.hourlyKwh.reduce((a, v, h) => a + v * part(h), 0) * f), won:Math.round(R.hourlyWon.reduce((a, v, h) => a + v * part(h), 0) * f), avgT:w ? r(t / w) : null, maxT:mx }; };
  const BS = side(b), SS = side(s), after = (R) => R.hourlyKwh.reduce((a, v, h) => a + (h >= Math.ceil(to) ? v : 0), 0) * f;
  const hhmm = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  return { engine:'5R1C', mode:b.mode, calibration:f, accuracy:C ? { cvrmsePct:C.valid?.cvrmsePct ?? null, nmbePct:C.valid?.nmbePct ?? null, tempRmseC:C.valid?.tempRmseC ?? null, pass:!!C.pass } : null, ms:Math.round((typeof performance !== 'undefined' ? performance : Date).now() - t0),
    window:{ from, to, hours:n, rooms:targets, label:`${hhmm(from)}~${hhmm(to)}`, clipped:to - from < n, setpoint:sp, base:BS, scenario:SS,
      savedKwh:r(BS.kwh - SS.kwh), savedWon:BS.won - SS.won, savedPct:BS.kwh >= .5 ? r((BS.kwh - SS.kwh) / BS.kwh * 100) : null, afterSavedKwh:r(after(b) - after(s)) } };
}
