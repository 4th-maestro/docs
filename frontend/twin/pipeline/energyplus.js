/* ═══════════════════════════════════════════════════════════════════════════
   building.json (twin.building/v1) → EnergyPlus 입력 파일 (IDF, EnergyPlus 24.2 필드 순서)
   - 냉방 실(type 'room') 하나 = 열 영역(Zone) 하나. 실 다각형을 층고만큼 세워 벽·바닥·천장을 만든다
   - 외벽: 층 윤곽(footprint, 없으면 W×D 사각형) 밖에 닿은 변. 창은 building.window(외부 사진에서 잰 창 높이)
   - 실 사이 벽·중간층 바닥은 단열(Adiabatic)로 둔다 (실별 냉방부하를 보려는 단순 모델)
   - 공조: 실마다 ZoneHVAC:IdealLoadsAirSystem → 그 실에 필요한 냉방량 = 실내기 용량과 비교할 값
   - 기상: 설계일(부산 여름·겨울, 근사값) 또는 EPW 기상파일(실행 시 지정)
   - 운전 시나리오(scenario): 설정온도·운전시간·빈 방 끄기·사전 냉방 → 같은 건물·같은 기상에서 기존 운전과 비교
     냉방 용량은 실에 설치된 실내기 용량 합으로 제한 → 용량이 모자라면 실온이 설정보다 올라간다
     쾌적: EnergyPlus 내장 Fanger 모델(ISO 7730 PMV·PPD) + BOPTEST 방식 열 불쾌도(쾌적 범위 밖 K·h)
   같은 building.json + 같은 시나리오 → 항상 같은 IDF (난수 없음)
   ═══════════════════════════════════════════════════════════════════════════ */

const r3 = v => Math.round(v * 1000) / 1000;
const area = p => { let s = 0; for (let i = 0; i < p.length; i++) { const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length]; s += x0 * y1 - x1 * y0; } return s / 2; };   // 부호 있음
const inPoly = (x, y, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const [xi, yi] = p[i], [xj, yj] = p[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
// 층 윤곽: 다각형 하나 또는 여러 개(떨어진 동). 없으면 W×D 사각형
export const footLoops = (fp, W, D) => !fp?.length ? [[[0, 0], [W, 0], [W, D], [0, D]]] : Array.isArray(fp[0]?.[0]) ? fp.filter(l => l?.length >= 3) : [fp];
export const inFootprint = (x, y, fp, W, D) => footLoops(fp, W, D).some(l => inPoly(x, y, l));
// 위층이 이 점을 덮는지: 지붕 정원·데크(open)는 외기에 열려 있어 덮지 않음
export const coveredBy = (above, x, y, W, D) => !!above && !above.open && inFootprint(x, y, above.footprint, W, D);

// 용도별 가정값 (사람이 바꿀 수 있게 밖으로 뺌)
export const EP_USE = {
  lecture:   { lights:10, equip:5,  occ:[[9, 18, .7]] },
  lab:       { lights:10, equip:15, occ:[[9, 18, .6]] },
  office:    { lights:10, equip:12, occ:[[9, 19, .6]] },
  admin:     { lights:10, equip:12, occ:[[9, 18, .75]] },
  meeting:   { lights:10, equip:5,  occ:[[10, 17, .35]] },
  lounge:    { lights:8,  equip:5,  occ:[[8, 20, .5], [11, 14, .9]] },
  retail:    { lights:15, equip:15, occ:[[7, 22, .85]] },
  restaurant:{ lights:12, equip:30, occ:[[8, 21, .45], [11, 14, .9], [17, 20, .9]] },
  waiting:   { lights:10, equip:5,  occ:[[5, 24, .6], [7, 10, .95], [17, 20, .95]] },
};
// 부산 설계일 (ASHRAE 기후자료 근사값 — 정확한 값은 EPW·기후자료로 교체)
export const BUSAN = { name:'Busan', lat:35.10, lon:129.03, tz:9, elev:69,
  summer:{ month:8, day:5, db:32.0, range:6.0, wb:25.5, wind:3.4, windDir:230 },
  winter:{ month:1, day:21, db:-5.5, range:0, wind:6.0, windDir:320 } };

function hourly(spec){            // [[시작, 끝, 비율], ...] → 24개 값 (뒤의 구간이 앞을 덮음)
  const v = Array(24).fill(.05);
  for (const [a, b, f] of spec) for (let h = a; h < b; h++) v[h % 24] = f;
  return v;
}
function compact(name, limits, vals){   // 24개 값 → Schedule:Compact (같은 값 구간은 묶음)
  const f = [name, limits, 'Through: 12/31', 'For: AllDays'];
  for (let h = 0; h < 24; h++) if (h === 23 || vals[h + 1] !== vals[h]) f.push(`Until: ${String(h + 1).padStart(2, '0')}:00`, String(vals[h]));
  return obj('Schedule:Compact', f);
}
function obj(type, fields){ return `${type},\n${fields.map((v, i) => `    ${v ?? ''}${i === fields.length - 1 ? ';' : ','}`).join('\n')}\n`; }
const hm = s => +s.split(':')[0] + (+s.split(':')[1] || 0) / 60;

// 운전 시나리오 (twin.scenario/v1)
//   coolSetpoint °C · hours [시작, 끝] · offWhenEmpty(재실 20% 미만 시간엔 끔) · precoolMin(사람 오기 전 미리 켜는 분) · rooms{ 실id:{ coolSetpoint, off } }
// 기존 운전(기준) = building.operation (운영시간, coolSetpoint 없으면 24°C 가정)
export const COMFORT = { lower:20, upper:26, source:'정부 권장 여름철 실내 냉방온도 26°C — 상한, 하한 20°C (BOPTEST처럼 재실 시간에만 집계)' };
export const COMFORT_HEAT = { lower:18, upper:24, source:'정부 권장 겨울철 실내 난방온도 20°C — 쾌적 범위 18~24°C (재실 시간에만 집계)' };
// 냉방·난방 모드: 5~9월 냉방, 그 밖 난방 (웹 데모 pipeline/web-demo.js와 같은 기준)
//   시나리오의 coolSetpoint는 모드와 관계없이 '설정온도' (난방이면 난방 설정온도로 씀 — 필드 이름은 호환을 위해 그대로)
export const modeOfMonth = m => (m >= 5 && m <= 9 ? 'cool' : 'heat');
export function baselineOf(B, mode = 'cool'){
  const op = B.operation || {}, heat = mode === 'heat', sp = heat ? op.heatSetpoint : op.coolSetpoint, d = heat ? 20 : 24;
  return { schema:'twin.scenario/v1', name:'기존 운전', mode:heat ? 'heat' : 'cool', coolSetpoint:sp ?? d, hours:op.weekday || ['08:00', '21:00'], offWhenEmpty:false, precoolMin:0, rooms:{},
    note:sp == null ? `설정온도 기록 없음 → ${d}°C 가정 (BMS 설정값으로 바꿀 것)` : 'BMS 운영 설정' };
}
export const occOf = use => hourly((EP_USE[use] || EP_USE.office).occ);
// busy[h] = 그 시간에 사람이 있나 (표준 일정이면 재실 비율 20% 이상, 오늘 실측이면 1명 이상)
//   room.avail(24개 0/1)이 있으면 그대로 씀 = 오늘 실제로 켰던 시간 (실시간 기록)
export function availOf(sc, use, room, busy = occOf(use).map(v => v >= .2 ? 1 : 0)){
  const occ = busy, h0 = hm(sc.hours[0]), h1 = hm(sc.hours[1]) || 24, pre = Math.round((sc.precoolMin || 0) / 60);
  if (room?.off) return Array(24).fill(0);
  if (Array.isArray(room?.avail)) return room.avail.map(v => v ? 1 : 0);
  return Array.from({ length:24 }, (_, h) => {
    const inHours = h >= Math.floor(h0) - pre && h < Math.ceil(h1);
    if (!inHours) return 0;
    if (!sc.offWhenEmpty) return 1;
    for (let k = 0; k <= pre; k++) if (occ[(h + k) % 24]) return 1;
    return 0;
  });
}
// 오늘(실시간) 하루: live = { date, temp[24], hum[24], clear, rooms:{ 실id:{ occ[24] 명 } } } — tools/sim-runner.mjs의 liveDay가 만듦
//   설계일 대신 '오늘 예보·실측 외기'로 하루를 돌리고, 재실 일정은 실별 실측(와이파이·센서) 인원으로 바꾼다

export function toIdf(B, { weatherFile = false, site = BUSAN, cooling = 26, heating = 18, scenario = null, live = null, experiment = null } = {}){
  if (live) weatherFile = false;
  const sc = scenario ? { ...baselineOf(B, scenario.mode), ...scenario, rooms:scenario.rooms || {} } : null;
  const heat = sc?.mode === 'heat', SPN = heat ? 'Heat SP' : 'Cool SP';   // 난방이면 설정온도 = 난방 설정, 냉방은 끔 (Cool SP 40°C)
  const W = B.building.size.w, D = B.building.size.d, FH = B.building.floorHeight || 3.6;
  const win = B.building.window || { sill:.8, head:2.3 }, head = Math.min(win.head, FH - .15), sill = Math.min(win.sill, head - .3);
  const out = [], zones = [];
  const P = ([x, y]) => [r3(x), r3(D - y)];                                 // 도면(y 남쪽) → EnergyPlus(Y 북쪽)
  out.push(`! ${B.building.id} — 디지털 트윈 파이프라인에서 만든 EnergyPlus 입력 (building.json → IDF)\n! 실 ↔ 영역 대응은 같은 폴더의 zones.json\n`);
  out.push(obj('Version', ['24.2']));
  out.push(obj('SimulationControl', ['No', 'No', 'No', experiment ? 'No' : 'Yes', weatherFile ? 'Yes' : 'No', 'No', '1']));
  // North Axis: 도면 위쪽(EnergyPlus +Y)이 진북에서 시계 방향으로 몇 도인지 — 스카이뷰 맞춤(site.northDeg)에서, 없으면 0
  out.push(obj('Building', [B.building.id, String(B.site?.northDeg ?? 0), 'City', '0.04', '0.4', 'MinimalShadowing', '25', '6']));
  out.push(obj('Timestep', ['4']));
  // 좌표계는 Relative여야 Building North Axis가 적용됨 (World면 방위를 무시함 — 원점 0이라 형상은 같음)
  out.push(obj('GlobalGeometryRules', ['UpperLeftCorner', 'Counterclockwise', 'Relative', 'Relative', 'Relative']));
  out.push(obj('Site:Location', [site.name, site.lat, site.lon, site.tz, site.elev, 'No']));
  const S = site.summer, Wn = site.winter;
  if (live) {       // 오늘 하루: 시간별 외기 온도·습도(예보, 지난 시간은 실측) 그대로
    const [, mo, dd] = live.date.split('-').map(Number), t = live.temp, h = live.hum, mx = Math.max(...t), mn = Math.min(...t);
    out.push(obj('Schedule:Day:Hourly', ['Live DB', 'Any', ...t.map(v => r3(v))]), obj('Schedule:Day:Hourly', ['Live RH', 'Any', ...h.map(v => r3(Math.min(100, Math.max(5, v))))]));
    out.push(obj('SizingPeriod:DesignDay', [`Live ${live.date}`, mo, dd, heat ? 'WinterDesignDay' : 'SummerDesignDay', r3(mx), r3(mx - mn), 'TemperatureProfileSchedule', 'Live DB', 'RelativeHumiditySchedule', '', 'Live RH', '', '', '', '100500', live.wind ?? 2.5, 230, live.rain ? 'Yes' : 'No', 'No', 'No', 'ASHRAEClearSky', '', '', '', '', String(live.clear ?? 1)]));
  } else if (!experiment) {
  out.push(obj('SizingPeriod:DesignDay', [`${site.name} Summer Cooling`, S.month, S.day, 'SummerDesignDay', S.db, S.range, 'DefaultMultipliers', '', 'WetBulb', S.wb, '', '', '', '', '100500', S.wind, S.windDir, 'No', 'No', 'No', 'ASHRAEClearSky', '', '', '', '', '1.0']));
  out.push(obj('SizingPeriod:DesignDay', [`${site.name} Winter Heating`, Wn.month, Wn.day, 'WinterDesignDay', Wn.db, Wn.range, 'DefaultMultipliers', '', 'WetBulb', Wn.db, '', '', '', '', '100500', Wn.wind, Wn.windDir, 'No', 'No', 'No', 'ASHRAEClearSky', '', '', '', '', '0.0']));
  }
  if (experiment) out.push(obj('RunPeriod', experiment.runPeriod));
  else if (weatherFile && heat) out.push(obj('RunPeriod', ['Heating Season 1', '1', '1', '', '3', '31', '', '', 'Yes', 'Yes', 'No', 'Yes', 'Yes', 'No', '']), obj('RunPeriod', ['Heating Season 2', '11', '1', '', '12', '31', '', '', 'Yes', 'Yes', 'No', 'Yes', 'Yes', 'No', '']));
  else if (weatherFile) out.push(obj('RunPeriod', ['Cooling Season', '6', '1', '', '9', '30', '', '', 'Yes', 'Yes', 'No', 'Yes', 'Yes', 'No', '']));
  // 재료·구조 (일반적인 철근콘크리트 + 단열, 복층유리)
  out.push(obj('ScheduleTypeLimits', ['Fraction', '0', '1', 'Continuous', '']), obj('ScheduleTypeLimits', ['Temperature', '-60', '200', 'Continuous', 'Temperature']),
    obj('ScheduleTypeLimits', ['ControlType', '0', '4', 'Discrete', '']), obj('ScheduleTypeLimits', ['Any', '', '', 'Continuous', '']));
  out.push(obj('Material', ['Concrete200', 'MediumRough', '0.2', '1.95', '2240', '900', '0.9', '0.7', '0.7']),
    obj('Material', ['Insulation80', 'MediumSmooth', '0.08', '0.035', '30', '1400', '0.9', '0.6', '0.6']),
    obj('Material', ['Gypsum13', 'Smooth', '0.013', '0.16', '800', '1090', '0.9', '0.4', '0.4']),
    obj('WindowMaterial:SimpleGlazingSystem', ['DoubleLowE', '1.8', '0.40', '0.6']));
  out.push(obj('Construction', ['ExtWall', 'Concrete200', 'Insulation80', 'Gypsum13']), obj('Construction', ['Roof', 'Insulation80', 'Concrete200']),
    obj('Construction', ['Slab', 'Concrete200']), obj('Construction', ['Glazing', 'DoubleLowE']), obj('Construction', ['IntWall', 'Gypsum13', 'Gypsum13']));
  // 지면 온도 (부산 근사 — 건물 아래 지면, 월별)
  out.push(obj('Site:GroundTemperature:BuildingSurface', ['18', '18', '19', '20', '21', '22', '23', '24', '24', '23', '21', '19']));
  // 일정: 운영시간(BMS) → 공조 가동, 온도 설정
  const op = B.operation?.weekday || ['08:00', '21:00'], avail = Array.from({ length:24 }, (_, h) => h >= Math.floor(hm(op[0])) && h < Math.ceil(hm(op[1])) ? 1 : 0);
  out.push(compact('HVAC Avail', 'Fraction', avail), obj('Schedule:Constant', ['Always On', 'Fraction', '1']), obj('Schedule:Constant', ['Always Off', 'Fraction', '0']), obj('Schedule:Constant', ['Activity', 'Any', '120']),
    obj('Schedule:Constant', ['Cool SP', 'Temperature', String(sc ? (heat ? 40 : sc.coolSetpoint) : cooling)]), obj('Schedule:Constant', ['Heat SP', 'Temperature', String(sc && heat ? sc.coolSetpoint : heating)]),
    obj('Schedule:Constant', ['Dual Control', 'ControlType', '4']), obj('ThermostatSetpoint:DualSetpoint', ['Dual SP', 'Heat SP', 'Cool SP']),
    // 쾌적 계산(Fanger PMV·PPD) 입력: 옷 여름 0.5clo / 겨울 1.0clo (pipeline/comfort.js와 같은 가정) · 기류 0.15m/s · 일 효율 0
    obj('Schedule:Constant', ['Work Eff', 'Any', '0']), obj('Schedule:Constant', ['Clothing', 'Any', heat ? '1.0' : '0.5']), obj('Schedule:Constant', ['Air Velocity', 'Any', '0.15']));
  const schedOnce = new Map(), sched = (prefix, limits, vals) => { const key = prefix + vals.join(','); if (!schedOnce.has(key)) { const n = `${prefix} ${schedOnce.size + 1}`; schedOnce.set(key, n); out.push(compact(n, limits, vals)); } return schedOnce.get(key); };
  const dual = (n, sp) => obj('ThermostatSetpoint:DualSetpoint', heat ? [n, sp, 'Cool SP'] : [n, 'Heat SP', sp]);
  const spOnce = new Map(), setpoint = v => { if (!spOnce.has(v)) { const n = `Dual SP ${v}`; spOnce.set(v, n); out.push(obj('Schedule:Constant', [`${SPN} ${v}`, 'Temperature', String(v)]), dual(n, `${SPN} ${v}`)); } return spOnce.get(v); };
  // 구간 설정온도: spWindow{ from, to (시, 15분 단위), sp, base } → 그 구간만 sp, 나머지는 base ('지금부터 N시간' 시뮬레이션)
  const hhmmQ = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  const setpointWin = w => { const k = `W ${w.base}-${w.sp}-${w.from}-${w.to}`; if (!spOnce.has(k)) { const n = `Dual SP ${k}`, f = [`${SPN} ${k}`, 'Temperature', 'Through: 12/31', 'For: AllDays'];
      if (w.from > 0) f.push(`Until: ${hhmmQ(w.from)}`, String(w.base)); f.push(`Until: ${hhmmQ(Math.min(24, w.to))}`, String(w.sp)); if (w.to < 24) f.push('Until: 24:00', String(w.base));
      spOnce.set(k, n); out.push(obj('Schedule:Compact', f), dual(n, `${SPN} ${k}`)); } return spOnce.get(k); };
  for (const [u, s] of Object.entries(EP_USE)) out.push(compact(`Occ ${u}`, 'Fraction', hourly(s.occ)), compact(`Light ${u}`, 'Fraction', hourly(s.occ).map(v => Math.max(.1, Math.min(1, v + .2)))));
  // 기기 용량: 실내기 표에서 실별 합
  //   난방 능력: heatKw가 없으면 냉방 능력 × 1.1 (시스템 에어컨 실내기 냉·난방 능력 비 근사)
  const kw = {}, hkw = {}, inKw = {}; for (const a of B.idus || []) { kw[a.room] = (kw[a.room] || 0) + (a.coolKw || 0); hkw[a.room] = (hkw[a.room] || 0) + (a.heatKw || (a.coolKw || 0) * 1.1); inKw[a.room] = (inKw[a.room] || 0) + (a.ratedKw || 0); }

  // 지하층(id 'B1'·'B2'… 또는 below:true): 지면(z=0) 아래로 내려 쌓고, 외벽은 흙에 닿음(Ground, 창·일사·바람 없음)
  const below = f => f.below === true || /^B\d+F?$/i.test(f.id), NB = B.floors.filter(below).length;
  B.floors.forEach((f, li) => {
    const z0 = (li - NB) * FH, z1 = z0 + FH, above = B.floors[li + 1], under = below(f);
    const covered = (x, y) => coveredBy(above, x, y, W, D);
    const ext = (p, q) => { const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, nx = -(q[1] - p[1]) / len * .4, ny = (q[0] - p[0]) / len * .4, mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
      return !inFootprint(mx + nx, my + ny, f.footprint, W, D) || !inFootprint(mx - nx, my - ny, f.footprint, W, D); };
    f.rooms.filter(r => r.type === 'room').forEach((r, ri) => {
      const zn = `Z${f.id}_${String(ri + 1).padStart(3, '0')}`;
      if (experiment && !experiment.rooms.has(r.id)) return;
      let poly = r.polygon.map(P); if (area(poly) < 0) poly = poly.reverse();        // EnergyPlus 좌표에서 반시계
      const net = Math.abs(area(r.polygon)) - (r.holes || []).reduce((t, h) => t + Math.abs(area(h)), 0);
      const use = EP_USE[r.use] ? r.use : 'office', U = EP_USE[use];
      const people = r.capacity > 0 ? r.capacity : r3(net * .05);
      // 오늘 실측 재실(명) → 비율 일정 (정원보다 많으면 정원 기준을 늘림)
      const lo = live?.rooms?.[r.id]?.occ, peak = lo ? Math.max(people, ...lo) : people, occFrac = lo ? lo.map(n => Math.round(Math.min(1, n / peak) * 100) / 100) : null;
      zones.push({ zone:zn, room:r.id, floor:f.id, use:r.use, area:r3(net), people:r3(peak), installedKw:r3(kw[r.id] || 0), cop:inKw[r.id] ? r3(kw[r.id] / inKw[r.id]) : null, ...(occFrac ? { occ:occFrac } : {}) });
      out.push(`! ---- ${zn}\n`, obj('Zone', [zn, '0', '0', '0', '0', '1', '1', r3(FH), r3(net * FH), r3(net), '', '', 'Yes']));
      const V = pts => pts.flatMap(([x, y, z]) => [x, y, r3(z)]);
      const xs = r.polygon.map(p => p[0]), ys = r.polygon.map(p => p[1]), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      // 바닥(아래를 향함 = 위에서 볼 때 시계 방향), 천장·지붕(반시계)
      out.push(obj('BuildingSurface:Detailed', [`${zn} Floor`, 'Floor', 'Slab', zn, '', li === 0 ? 'Ground' : 'Adiabatic', '', 'NoSun', 'NoWind', '0', poly.length, ...V([...poly].reverse().map(([x, y]) => [x, y, z0]))]));
      const roof = !under && !covered(cx, cy);      // 지하층 위가 비어 있어도 흙·광장 아래라 지붕으로 보지 않음
      out.push(obj('BuildingSurface:Detailed', [`${zn} Top`, roof ? 'Roof' : 'Ceiling', roof ? 'Roof' : 'Slab', zn, '', roof ? 'Outdoors' : 'Adiabatic', '', roof ? 'SunExposed' : 'NoSun', roof ? 'WindExposed' : 'NoWind', roof ? '0' : '0', poly.length, ...V(poly.map(([x, y]) => [x, y, z1]))]));
      // 외벽 + 창 (안쪽 벽은 단열로 보고 생략)
      const src = area(r.polygon.map(P)) < 0 ? [...r.polygon].reverse() : r.polygon;       // poly와 같은 순서의 원래 좌표
      const intWall = (p, q, wn) => out.push(obj('BuildingSurface:Detailed', [wn, 'Wall', 'IntWall', zn, '', 'Adiabatic', '', 'NoSun', 'NoWind', '0', 4, ...V([[p[0], p[1], z1], [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1]])]));
      (r.holes || []).forEach((h, hi) => { let hp = h.map(P); if (area(hp) > 0) hp = hp.reverse();     // 구멍(안쪽 다른 실) 둘레 = 안쪽 벽
        hp.forEach((p, i) => { const q = hp[(i + 1) % hp.length]; if (Math.hypot(q[0] - p[0], q[1] - p[1]) >= .3) intWall(p, q, `${zn} H${hi + 1}W${i + 1}`); }); });
      poly.forEach((p, i) => {
        const q = poly[(i + 1) % poly.length], a = src[i], b = src[(i + 1) % src.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]); if (len < .3) return;
        const wn = `${zn} W${i + 1}`;
        if (!ext(a, b)) { intWall(p, q, wn); return; }    // 다른 실과 맞닿은 벽: 단열 경계(열은 안 넘기지만 실 안 복사·축열엔 참여)
        if (under) { out.push(obj('BuildingSurface:Detailed', [wn, 'Wall', 'ExtWall', zn, '', 'Ground', '', 'NoSun', 'NoWind', '0', 4, ...V([[p[0], p[1], z1], [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1]])])); return; }
        out.push(obj('BuildingSurface:Detailed', [wn, 'Wall', 'ExtWall', zn, '', 'Outdoors', '', 'SunExposed', 'WindExposed', 'AutoCalculate', 4, ...V([[p[0], p[1], z1], [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1]])]));
        if (len < 1.2) return;
        const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len, i0 = .3, i1 = len - .3, A = [p[0] + ux * i0, p[1] + uy * i0], Bq = [p[0] + ux * i1, p[1] + uy * i1];
        out.push(obj('FenestrationSurface:Detailed', [`${wn} Win`, 'Window', 'Glazing', wn, '', 'AutoCalculate', '', '1', 4,
          ...V([[A[0], A[1], z0 + head], [A[0], A[1], z0 + sill], [Bq[0], Bq[1], z0 + sill], [Bq[0], Bq[1], z0 + head]].map(([x, y, z]) => [r3(x), r3(y), z]))]));
      });
      if (experiment) {
        experiment.writeZone({ zone:zn, room:r, add:(type, fields) => out.push(obj(type, fields)) });
        return;
      }
      // 내부 발열·재실·침기
      const ppl = occFrac ? ['People', r3(peak), '', ''] : r.capacity > 0 ? ['People', r.capacity, '', ''] : ['People/Area', '', '0.05', ''];
      const occName = occFrac ? sched('Occ live', 'Fraction', occFrac) : `Occ ${use}`, lightName = occFrac ? sched('Light live', 'Fraction', occFrac.map(v => Math.round(Math.max(.1, Math.min(1, v > 0 ? v + .3 : .1)) * 100) / 100)) : `Light ${use}`;
      out.push(obj('People', [`${zn} People`, zn, occName, ...ppl, '0.3', 'AutoCalculate', 'Activity', '', 'No', 'EnclosureAveraged', '', 'Work Eff', 'ClothingInsulationSchedule', '', 'Clothing', 'Air Velocity', 'Fanger']));
      out.push(obj('Lights', [`${zn} Lights`, zn, lightName, 'Watts/Area', '', U.lights, '', '0', '0.42', '0.18', '1']));
      out.push(obj('ElectricEquipment', [`${zn} Equip`, zn, lightName, 'Watts/Area', '', U.equip, '', '0', '0.3', '0']));
      out.push(obj('ZoneInfiltration:DesignFlowRate', [`${zn} Infil`, zn, 'Always On', 'AirChanges/Hour', '', '', '', '0.3', '1', '0', '0', '0']));
      // 공조: 이상 부하 계산기 (운영시간에만)
      const rs = sc?.rooms[r.id] || {};
      const av = sc ? availOf(sc, use, rs, occFrac ? lo.map(n => n >= 1 ? 1 : 0) : undefined) : null;
      const availName = sc ? sched('Avail', 'Fraction', av) : 'HVAC Avail';
      // 냉방을 끈 시간엔 문·복도로 공기가 바뀜 (안쪽 벽을 단열로 봐서, 이게 없으면 꺼진 방이 40°C 넘게 갇힘) — 시간당 2회 환기
      if (sc && av.some(v => !v)) out.push(obj('ZoneVentilation:DesignFlowRate', [`${zn} Vent`, zn, sched('Vent', 'Fraction', av.map(v => v ? 0 : 1)), 'AirChanges/Hour', '', '', '', '2', 'Natural', '0', '1', '1', '0', '0', '0']));
      // 난방철: 냉방이 없으니 사람·기기 열로 실온이 오르면 창을 엶 (실온 25°C 넘고 외기보다 2°C 이상 높을 때 최대 시간당 3회)
      //   이게 없으면 단열 칸막이 모델에서 꽉 찬 강의실이 30°C를 넘어 난방이 전혀 필요 없는 것처럼 계산됨
      if (heat) out.push(obj('ZoneVentilation:DesignFlowRate', [`${zn} Window`, zn, 'Always On', 'AirChanges/Hour', '', '', '', '3', 'Natural', '0', '1', '1', '0', '0', '0', '25', '', '100', '', '2']));
      const sp = sc ? (rs.spWindow ? setpointWin(rs.spWindow) : setpoint(rs.coolSetpoint ?? sc.coolSetpoint)) : 'Dual SP';
      out.push(obj('ZoneControl:Thermostat', [`${zn} Tstat`, zn, 'Dual Control', 'ThermostatSetpoint:DualSetpoint', sp]));
      // 시나리오에서는 냉방 용량 = 설치된 실내기 용량 합 (없으면 냉방 없음) → 부족하면 실온이 올라감. 난방 모드면 난방 능력으로 제한하고 냉방은 끔
      const capW = kw[r.id] ? String(Math.round(kw[r.id] * 1000)) : '', hcapW = hkw[r.id] ? String(Math.round(hkw[r.id] * 1000)) : '';
      out.push(obj('ZoneHVAC:IdealLoadsAirSystem', heat
        ? [`${zn} Ideal`, availName, `${zn} Supply`, '', '', '50', '13', '0.0156', '0.0077', hcapW ? 'LimitCapacity' : 'NoLimit', '', hcapW,
          'NoLimit', '', '', hcapW ? '' : 'Always Off', 'Always Off', 'ConstantSensibleHeatRatio', '0.75', 'None']
        : [`${zn} Ideal`, availName, `${zn} Supply`, '', '', '50', '13', '0.0156', '0.0077', 'NoLimit', '', '',
          sc && capW ? 'LimitCapacity' : 'NoLimit', '', sc ? capW : '', '', sc && !capW ? 'Always Off' : '', 'ConstantSensibleHeatRatio', '0.75', 'None']));
      out.push(obj('ZoneHVAC:EquipmentList', [`${zn} Equipment`, 'SequentialLoad', 'ZoneHVAC:IdealLoadsAirSystem', `${zn} Ideal`, '1', '1', '', '']));
      out.push(obj('ZoneHVAC:EquipmentConnections', [zn, `${zn} Equipment`, `${zn} Supply`, '', `${zn} Air Node`, `${zn} Return`]));
    });
  });
  if (!experiment) {
    if (sc) out.push(obj('Output:Variable', ['Environment', 'Site Outdoor Air Drybulb Temperature', 'Hourly', '']),
      obj('Output:Variable', ['*', 'Zone Ideal Loads Supply Air Total Cooling Energy', 'Hourly', '']),
      obj('Output:Variable', ['*', 'Zone Ideal Loads Supply Air Total Heating Energy', 'Hourly', '']),
      obj('Output:Variable', ['*', 'Zone Thermal Comfort Fanger Model PMV', 'Hourly', '']),
      obj('Output:Variable', ['*', 'Zone Thermal Comfort Fanger Model PPD', 'Hourly', '']));
    out.push(obj('Output:Variable', ['*', 'Zone Ideal Loads Supply Air Total Cooling Rate', 'Hourly', '']),
      obj('Output:Variable', ['*', 'Zone Mean Air Temperature', 'Hourly', '']),
      obj('Output:Variable', ['*', 'Zone Ideal Loads Supply Air Total Heating Rate', 'Hourly', '']),
      obj('Output:Table:SummaryReports', ['AllSummary']), obj('OutputControl:Table:Style', ['CommaAndHTML', 'None']));
  }
  return { idf:out.join('\n'), zones:{ schema:'twin.ep-zones/v1', building:B.building.id, energyplus:'24.2', weather:live ? `오늘 ${live.date} 예보·실측` : weatherFile ? 'EPW' : '설계일(부산 근사값)', scenario:sc, zones,
    ...(live ? { live:{ date:live.date } } : {}) } };
}

// eplusout.csv (ReadVarsESO 결과) → 실별 최대 냉방부하 vs 설치된 실내기 용량
export function readResults(csv, zonesInfo){
  const lines = csv.trim().split(/\r?\n/), head = lines[0].split(',');
  const rows = lines.slice(1).map(l => l.split(','));
  const rooms = {};
  for (const z of zonesInfo.zones) {
    const col = head.findIndex(h => h.toUpperCase().startsWith(`${z.zone} IDEAL:ZONE IDEAL LOADS SUPPLY AIR TOTAL COOLING RATE`.toUpperCase()));
    const tcol = head.findIndex(h => h.toUpperCase().startsWith(`${z.zone}:ZONE MEAN AIR TEMPERATURE`.toUpperCase()));
    if (col < 0) continue;
    let peak = 0, at = '', tmax = -99;
    for (const r of rows) { const v = +r[col] / 1000; if (v > peak) { peak = v; at = r[0].trim(); } if (tcol >= 0) tmax = Math.max(tmax, +r[tcol]); }
    rooms[z.room] = { zone:z.zone, peakCoolKw:r3(peak), peakAt:at, installedKw:z.installedKw, ratio:z.installedKw ? r3(z.installedKw / Math.max(peak, 1e-3)) : null,
      verdict:!z.installedKw ? '실내기 없음' : peak > z.installedKw ? '용량 부족' : peak < z.installedKw * .5 ? '과대 설치' : '적정', maxTempC:tmax > -99 ? r3(tmax) : null };
  }
  return { schema:'twin.simulation/v1', engine:`EnergyPlus ${zonesInfo.energyplus}`, building:zonesInfo.building, weather:zonesInfo.weather, rooms };
}

/* ── 시나리오 결과 → 실온 예측 · 전력 · 요금 · 불쾌도 (BOPTEST KPI 정의를 따름) ──
   ener: 냉방 전력량 kWh = 냉방 열량 ÷ COP. COP = 실내기 정격 냉방능력 ÷ 정격 소비전력(설비대장), 외기온도 보정 EIR(T)=1+0.02(T−35)
   cost: 시간별 전력 × 요금(계시별이면 그 시간 단가)
   tdis: 재실 시간 동안 쾌적 범위 밖으로 벗어난 온도 × 시간 (K·h), 실 평균 = BOPTEST tdis_tot
   PMV·PPD: EnergyPlus Fanger 모델(ISO 7730), 재실 인원 가중 평균. 불쾌 비율 = |PMV| > 0.5 (ISO 7730 B등급 밖) 인원·시간 비율 */
export function priceAt(tariff, month, hour){
  const t = tariff?.tou;
  if (!t) return +tariff?.wonPerKwh || 130;
  const season = t.seasons.find(s => s.months.includes(month)) || t.seasons[0];
  const band = (t.bands[season.bands || 'default'] || t.bands.default).find(b => b.hours.some(([a, z]) => hour >= a && hour < z))?.band || 'off';
  return season.price[band];
}
const eir = T => Math.min(1.2, Math.max(.6, 1 + .02 * (T - 35)));
const eirHeat = T => Math.min(1.4, Math.max(.8, 1 + .02 * (7 - T)));   // 난방: 외기 7°C 정격, 추울수록 효율 떨어짐
export function readScenario(csv, zonesInfo, { tariff = null, comfort = null, defaultCop = 3.2 } = {}){
  const heat = zonesInfo.scenario?.mode === 'heat';
  comfort ||= heat ? COMFORT_HEAT : COMFORT;
  const lines = csv.trim().split(/\r?\n/), head = lines[0].split(',').map(h => h.trim().toUpperCase());
  let rows = lines.slice(1).map(l => l.split(','));
  const when = r => { const m = r[0].trim().match(/(\d+)\/(\d+)\s+(\d+):/); return { month:+m[1], day:+m[2], hour:(+m[3] + 23) % 24 }; };
  // 냉방 기간만 (설계일이면 여름 설계일, EPW면 6~9월) · 난방이면 겨울 설계일, EPW면 11~3월 · 오늘 실시간이면 그 날 하루
  const LD = zonesInfo.live?.date?.split('-').map(Number);
  rows = rows.filter(r => { const w = when(r); return LD ? w.month === LD[1] && w.day === LD[2] : heat ? w.month <= 3 || w.month >= 11 : w.month >= 6 && w.month <= 9; });
  const col = s => head.findIndex(h => h.startsWith(s.toUpperCase()));
  const tout = col('ENVIRONMENT:SITE OUTDOOR AIR DRYBULB TEMPERATURE');
  const rooms = {}; let E = 0, C = 0, Q = 0, tdisSum = 0, nz = 0, ppdW = 0, w = 0, bad = 0;
  const peakT = { t:-99 }, hourly = Array(24).fill(0), hourlyWon = Array(24).fill(0);
  for (const z of zonesInfo.zones) {
    const cq = col(`${z.zone} IDEAL:ZONE IDEAL LOADS SUPPLY AIR TOTAL ${heat ? 'HEATING' : 'COOLING'} ENERGY`), ct = col(`${z.zone}:ZONE MEAN AIR TEMPERATURE`);
    const cpmv = col(`${z.zone} PEOPLE:ZONE THERMAL COMFORT FANGER MODEL PMV`), cppd = col(`${z.zone} PEOPLE:ZONE THERMAL COMFORT FANGER MODEL PPD`);
    if (ct < 0) continue;
    const occ = z.occ || occOf(z.use), cop = z.cop || defaultCop, busy = h => z.occ ? z.occ[h] * z.people >= 1 : occ[h] >= .2;
    let q = 0, e = 0, c = 0, tdis = 0, tmax = -99, tsum = 0, nOcc = 0, zp = 0, zw = 0, zbad = 0;
    const hT = LD ? Array(24).fill(null) : null, hE = LD ? Array(24).fill(0) : null;
    for (const r of rows) {
      const { month, hour } = when(r), T = +r[ct], To = tout >= 0 ? +r[tout] : 30;
      const qk = cq >= 0 ? +r[cq] / 3.6e6 : 0, ek = qk / cop * (heat ? eirHeat(To) : eir(To));
      const won = ek * priceAt(tariff, month, hour);
      q += qk; e += ek; c += won; hourly[hour] += ek; hourlyWon[hour] += won;
      if (hT) { hT[hour] = r3(T); hE[hour] = r3(hE[hour] + ek); }
      if (busy(hour)) {
        nOcc++; tsum += T; tmax = Math.max(tmax, T);
        tdis += Math.max(0, T - comfort.upper) + Math.max(0, comfort.lower - T);
        const n = occ[hour] * z.people, pmv = cpmv >= 0 ? +r[cpmv] : null, ppd = cppd >= 0 ? +r[cppd] : null;
        if (ppd != null && n > 0) { zp += ppd * n; zw += n; if (Math.abs(pmv) > .5) zbad += n; }
      }
    }
    if (tmax > peakT.t) Object.assign(peakT, { t:tmax, room:z.room });
    rooms[z.room] = { zone:z.zone, avgTempC:nOcc ? r3(tsum / nOcc) : null, maxTempC:nOcc ? r3(tmax) : null, coolKwh:r3(q), elecKwh:r3(e), costWon:Math.round(c),
      tdisKh:r3(tdis), ppd:zw ? r3(zp / zw) : null, uncomfortPct:zw ? r3(zbad / zw * 100) : null, ...(hT ? { hourlyT:hT, hourlyKwh:hE } : {}) };
    E += e; C += c; Q += q; tdisSum += tdis; nz++; ppdW += zp; w += zw; bad += zbad;
  }
  const area = zonesInfo.zones.reduce((s, z) => s + z.area, 0), days = new Set(rows.map(r => r[0].trim().slice(0, 5))).size;
  return { schema:'twin.scenario-result/v1', engine:`EnergyPlus ${zonesInfo.energyplus}`, building:zonesInfo.building, weather:zonesInfo.weather, days, scenario:zonesInfo.scenario, mode:heat ? 'heat' : 'cool',
    comfort, tariff:tariff?.tou ? '계시별' : `${+tariff?.wonPerKwh || 130}원/kWh`,
    kpi:{ elecKwh:r3(E), coolKwh:r3(Q), costWon:Math.round(C), enerKwhM2:r3(E / area), tdisKhPerZone:r3(tdisSum / Math.max(nz, 1)), ppd:w ? r3(ppdW / w) : null,
      uncomfortPct:w ? r3(bad / w * 100) : null, hottest:peakT.t > -99 ? { room:peakT.room, tempC:r3(peakT.t) } : null },
    hourlyKwh:hourly.map(r3), hourlyWon:hourlyWon.map(v => Math.round(v)), ...(zonesInfo.live ? { live:zonesInfo.live } : {}), rooms };
}
// 기존 운전 대비 절감
export function compareScenario(base, s){
  const d = (a, b) => r3(a - b), pct = (a, b) => a ? r3((a - b) / a * 100) : 0;
  return { savedKwh:d(base.kpi.elecKwh, s.kpi.elecKwh), savedPct:pct(base.kpi.elecKwh, s.kpi.elecKwh), savedWon:base.kpi.costWon - s.kpi.costWon,
    tdisChange:d(s.kpi.tdisKhPerZone, base.kpi.tdisKhPerZone), ppdChange:s.kpi.ppd != null && base.kpi.ppd != null ? d(s.kpi.ppd, base.kpi.ppd) : null,
    uncomfortChange:s.kpi.uncomfortPct != null && base.kpi.uncomfortPct != null ? d(s.kpi.uncomfortPct, base.kpi.uncomfortPct) : null };
}
