// 운전 시나리오 시뮬레이션 실행기 (명령줄·서버 공용)
//   building.json + 시나리오 → EnergyPlus IDF → 실행 → 실온·전력·요금·불쾌도
//   같은 건물·같은 시나리오·같은 기상 → 결과를 sim/<건물>/runs/<해시>/result.json 에 저장해 두고 다시 쓴다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toIdf, readScenario, compareScenario, baselineOf, COMFORT, COMFORT_HEAT, modeOfMonth } from '../pipeline/energyplus.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function findEnergyPlus(){
  const exe = process.platform === 'win32' ? 'energyplus.exe' : 'energyplus';
  const cands = [];
  if (process.env.ENERGYPLUS_DIR) cands.push(path.join(process.env.ENERGYPLUS_DIR, exe));
  for (const base of ['C:/', 'C:/Program Files/', os.homedir() + '/', '/usr/local/', '/Applications/']) {
    try { for (const d of fs.readdirSync(base).filter(d => /^EnergyPlus/i.test(d)).sort().reverse()) cands.push(path.join(base, d, exe)); } catch {}
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['energyplus'], { encoding:'utf8', stdio:['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

const readJson = f => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
// cwd를 실행마다 따로: EnergyPlus의 ReadVarsESO가 readvars.audit를 현재 폴더에 써서, 두 개를 동시에 돌리면 서로 파일을 잠가 실패함
const run = (exe, args, cwd) => new Promise((ok, no) => execFile(exe, args, { maxBuffer:64 << 20, cwd }, (e, out, err) => e ? no(Object.assign(e, { out, err })) : ok(out)));

// 시나리오 입력 정리 (화면에서 온 값은 범위를 확인)
//   inherit:'live' = 오늘 실제 운전(실시간 기록)을 그대로 두고 rooms에 적은 방만 바꿈 (방별 '설정온도 바꿔 보기')
export function cleanScenario(s = {}, B, base = baselineOf(B)){
  const hhmm = v => /^\d{1,2}:\d{2}$/.test(v || '') ? v : null, num = (v, a, b, d) => Number.isFinite(+v) && v !== '' && v != null ? Math.min(b, Math.max(a, +v)) : d;
  const rooms = {};
  for (const [id, r] of Object.entries(s.rooms || {})) rooms[id] = { ...(r.coolSetpoint != null ? { coolSetpoint:num(r.coolSetpoint, 18, 30, base.coolSetpoint) } : {}), ...(r.off ? { off:true } : {}),
    ...(Array.isArray(r.avail) && r.avail.length === 24 ? { avail:r.avail.map(v => v ? 1 : 0) } : {}) };
  if (s.inherit === 'live' && base.live) {
    const merged = JSON.parse(JSON.stringify(base.rooms));
    for (const [id, r] of Object.entries(rooms)) merged[id] = { ...merged[id], ...r };
    return { ...base, name:String(s.name || '내 선택').slice(0, 40), inherit:'live', rooms:merged, changed:Object.keys(rooms) };
  }
  return { schema:'twin.scenario/v1', name:String(s.name || '내 선택').slice(0, 40), mode:base.mode || 'cool', coolSetpoint:num(s.coolSetpoint, 18, 30, base.coolSetpoint),
    hours:[hhmm(s.hours?.[0]) || base.hours[0], hhmm(s.hours?.[1]) || base.hours[1]], offWhenEmpty:!!s.offWhenEmpty, precoolMin:num(s.precoolMin, 0, 180, 0), rooms };
}

// 오늘(실시간) 하루: pipeline/live-day.js (브라우저 5R1C 즉시 계산과 같이 씀)
import { liveDay, liveBaseline, hmm } from '../pipeline/live-day.js';
export { liveDay, liveBaseline };

// 실측 냉방 전력으로 보정: 지난 시간들의 (실측 합 ÷ 시뮬레이션 합) = 보정 계수 → 두 결과 모두에 곱함
export function calibrate(base, sc, L){
  const hs = L.measured.hours.filter(h => base.hourlyKwh[h] > .01 || L.measured.hvacKw[h] > .01);
  const sm = hs.reduce((t, h) => t + L.measured.hvacKw[h], 0), ss = hs.reduce((t, h) => t + base.hourlyKwh[h], 0);
  if (hs.length < 1 || ss < .5 || sm < .5) return { factor:1, hours:hs.length, note:'실측 전력 기록이 부족해 보정 안 함' };
  const f = Math.min(3, Math.max(.3, sm / ss)), mean = sm / hs.length;
  const cv = Math.sqrt(hs.reduce((t, h) => t + (L.measured.hvacKw[h] - f * base.hourlyKwh[h]) ** 2, 0) / hs.length) / mean;
  const raw = Math.sqrt(hs.reduce((t, h) => t + (L.measured.hvacKw[h] - base.hourlyKwh[h]) ** 2, 0) / hs.length) / mean;
  const r = v => Math.round(v * 1000) / 1000;
  for (const R of [base, sc]) {
    R.raw = { elecKwh:R.kpi.elecKwh, costWon:R.kpi.costWon };
    R.kpi.elecKwh = r(R.kpi.elecKwh * f); R.kpi.costWon = Math.round(R.kpi.costWon * f); R.kpi.enerKwhM2 = r(R.kpi.enerKwhM2 * f);
    R.hourlyKwh = R.hourlyKwh.map(v => r(v * f)); R.hourlyWon = R.hourlyWon.map(v => Math.round(v * f));
    for (const x of Object.values(R.rooms)) { x.elecKwh = r(x.elecKwh * f); x.costWon = Math.round(x.costWon * f); if (x.hourlyKwh) x.hourlyKwh = x.hourlyKwh.map(v => r(v * f)); }
  }
  return { factor:r(f), hours:hs.length, measuredKwh:r(sm), simKwh:r(ss), cvrmsePct:r(cv * 100), cvrmseRawPct:r(raw * 100),
    note:`지난 ${hs.length}시간 실측 실내기 전력 ${r(sm)}kWh ÷ 시뮬레이션 ${r(ss)}kWh` };
}

export async function runScenario(dataDir, scenario, { epw = null, ep = findEnergyPlus(), live = null } = {}){
  const dir = path.resolve(ROOT, dataDir);
  const B = readJson(path.join(dir, 'building.json')), tariff = readJson(path.join(dir, 'tariff.json'));
  if (!B) throw new Error(`building.json 없음: ${dataDir}`);
  if (!ep) throw Object.assign(new Error('EnergyPlus가 설치돼 있지 않습니다 (https://energyplus.net/downloads, 24.2)'), { code:'NO_EP' });
  const { idf, zones } = toIdf(B, { weatherFile:!!epw && !live, scenario, live });
  if (live) epw = null;
  // 캐시 키 = 실제로 돌릴 IDF 내용 + 결과 해석에 쓰는 값 (IDF 만드는 코드가 바뀌어도 자동으로 다시 계산)
  const key = crypto.createHash('sha1').update(JSON.stringify([idf, zones, tariff, epw && fs.statSync(epw).size, COMFORT, COMFORT_HEAT, readScenario.toString()])).digest('hex').slice(0, 12);
  const out = path.join(ROOT, 'sim', B.building.id, 'runs', key), cached = path.join(out, 'result.json');
  if (fs.existsSync(cached)) return { ...readJson(cached), cached:true };
  // 같은 입력이 동시에 두 번 오면(기존 = 선택 등) 한 번만 돌리고 결과 파일을 같이 씀
  if (INFLIGHT.has(key)) { await INFLIGHT.get(key); return { ...readJson(cached), cached:true }; }
  let done; INFLIGHT.set(key, new Promise(r => done = r));
  try { return await execRun(); } finally { INFLIGHT.delete(key); done(); }
  async function execRun(){
  fs.mkdirSync(out, { recursive:true });
  fs.writeFileSync(path.join(out, 'in.idf'), idf);
  fs.writeFileSync(path.join(out, 'zones.json'), JSON.stringify(zones, null, 1));
  const t0 = Date.now();
  try { await run(ep, ['-r', '-d', out, ...(epw ? ['-w', epw] : ['-D']), path.join(out, 'in.idf')], out); }
  catch (e) { const err = fs.existsSync(path.join(out, 'eplusout.err')) ? fs.readFileSync(path.join(out, 'eplusout.err'), 'utf8').split('\n').filter(l => /Severe|Fatal/.test(l)).slice(0, 5).join('\n') : e.message;
    throw new Error(`EnergyPlus 실행 실패\n${err}`); }
  const res = readScenario(fs.readFileSync(path.join(out, 'eplusout.csv'), 'utf8'), zones, { tariff });
  const errTxt = fs.readFileSync(path.join(out, 'eplusout.err'), 'utf8'), m = errTxt.match(/(\d+) Warning; (\d+) Severe/);
  res.run = { id:key, seconds:+((Date.now() - t0) / 1000).toFixed(1), warnings:m ? +m[1] : null, severe:m ? +m[2] : null, dir:path.relative(ROOT, out).split(path.sep).join('/') };
  fs.writeFileSync(cached, JSON.stringify(res, null, 1));
  return JSON.parse(JSON.stringify(res));
  }
}
const INFLIGHT = new Map();

// 실시간 스냅샷(twin.realtime/v1, trend 포함) → twin.live/v1 (명령줄용 — 화면은 트윈이 직접 만듦)
export async function liveFromRealtime(B, snap, { weather = null } = {}){
  const { wifiModel, occupancyFromWifi } = await import('../pipeline/occupancy.js');
  const WM = wifiModel(B), byIdu = {}; for (const a of B.idus) byIdu[a.id] = a.room;
  const roomsOf = s => { const w = s.wifi && WM ? occupancyFromWifi(WM, s.wifi) : {}, out = {};
    for (const [id, v] of Object.entries(s.idus || {})) { const r = byIdu[id]; if (!r) continue; const x = out[r] ||= { kw:0, on:0, n:0, set:0 };
      x.kw += +v.kw || 0; x.on += v.onFrac ?? (v.power === 'on' ? 1 : 0); x.set += v.setTemp ?? 24; x.n++; }
    for (const x of Object.values(out)) { x.on /= x.n; x.set /= x.n; delete x.n; }
    for (const [id, n] of Object.entries(w)) (out[id] ||= {}).occ = n;
    for (const [id, v] of Object.entries(s.rooms || {})) if (typeof v.occupancy === 'number') (out[id] ||= {}).occ = v.occupancy;
    return out; };
  const hours = {};
  for (const t of snap.trend?.hours || []) hours[t.h] = { minutes:t.minutes || 60, out:t.outdoor, rooms:roomsOf(t) };
  const forecast = {}; for (const it of weather?.response?.body?.items?.item || []) (forecast[+String(it.fcstTime).slice(0, 2)] ||= {})[it.category] = +it.fcstValue;
  const time = snap.time || '';
  return { schema:'twin.live/v1', date:time.slice(0, 10), now:+time.slice(11, 13) + +time.slice(14, 16) / 60, forecast, hours };
}

// 계산 구간(window) 안의 전력·요금·실온: 시간별 값 × 구간과 겹치는 비율, 실온은 그 시간 켜진 방 평균
//   after = 구간이 끝난 뒤 오늘 끝까지 (설정을 되돌리면 실온을 다시 맞추느라 전력이 늘 수 있음)
function windowKpi(b, s, L, w){
  const r = v => Math.round(v * 1000) / 1000, part = h => Math.max(0, Math.min(h + 1, w.to) - Math.max(h, w.from));
  const sum = (a, f = part) => a.reduce((t, v, h) => t + v * f(h), 0);
  const temps = R => { let t = 0, n = 0, mx = null;
    for (const [id, x] of Object.entries(R.rooms)) { if (!x.hourlyT || (w.rooms && !w.rooms.includes(id))) continue;
      for (let h = Math.floor(w.from); h < Math.ceil(w.to); h++) { const T = x.hourlyT[h], p = part(h); if (T == null || !p || !L.rooms[id]?.avail[h]) continue; t += T * p; n += p; mx = Math.max(mx ?? T, T); } }
    return { avgT:n ? r(t / n) : null, maxT:mx }; };
  const side = R => ({ kwh:r(sum(R.hourlyKwh)), won:Math.round(sum(R.hourlyWon)), ...temps(R) });
  const B = side(b), S = side(s), after = h => h >= Math.ceil(w.to) ? 1 : 0;
  const hhmm = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  return { from:w.from, to:w.to, hours:w.hours, rooms:w.rooms || null, label:`${hhmm(w.from)}~${hhmm(w.to)}`, clipped:w.to - w.from < w.hours, setpoint:w.sp, base:B, scenario:S,
    savedKwh:r(B.kwh - S.kwh), savedWon:B.won - S.won, savedPct:B.kwh >= .5 ? r((B.kwh - S.kwh) / B.kwh * 100) : null,   // 기준이 거의 0이면 % 무의미
    afterSavedKwh:r(sum(b.hourlyKwh, after) - sum(s.hourlyKwh, after)) };
}

// 기존 운전 vs 선택한 운전 (둘 다 같은 건물·같은 기상)
//   opts.live(twin.live/v1)가 있으면: 기상 = 오늘 예보·실측, 재실 = 실측, 기존 운전 = 오늘 실제 운전, 결과는 실측 전력으로 보정
export async function compare(dataDir, scenario, opts = {}){
  const dir = path.resolve(ROOT, dataDir), B = readJson(path.join(dir, 'building.json'));
  const L = opts.live ? liveDay(B, opts.live, { schedule:readJson(path.join(dir, 'schedule.json')) }) : null;
  // 냉방·난방: 화면이 보낸 mode > 오늘 날짜(실시간) > 냉방 (설계일 비교는 지금까지처럼 여름)
  const mode = ['cool', 'heat'].includes(scenario?.mode) ? scenario.mode : ['cool', 'heat'].includes(opts.live?.mode) ? opts.live.mode : L ? modeOfMonth(+L.date.slice(5, 7)) : 'cool';
  const base = L ? liveBaseline(B, L, mode) : baselineOf(B, mode);
  // '지금부터 N시간': 기준 = 현재 설정을 그대로 유지했을 때의 예측(오늘 실제 운전 + 이후 재실 예상), 선택 = 같은 운전에서 그 구간만 설정온도 변경
  //   구간은 15분 단위(EnergyPlus Timestep 4), 오늘 24시를 넘기면 24시까지만
  const win = L && scenario?.window ? (() => { const n = Math.min(12, Math.max(.25, +scenario.window.hours || 2)), from = Math.floor(L.now * 4) / 4;
    // window.rooms: 이 방들만 바꿈 (채팅 what-if "3층 강의실 18도로 낮추면?"), 없으면 건물 전체
    const only = Array.isArray(scenario.window.rooms) ? scenario.window.rooms.filter(id => L.rooms[id]) : [];
    return { from, to:Math.min(24, from + Math.round(n * 4) / 4), hours:n, sp:Math.min(30, Math.max(18, +scenario.coolSetpoint || base.coolSetpoint)), rooms:only.length ? only : null }; })() : null;
  const sc = win ? { ...JSON.parse(JSON.stringify(base)), name:`지금부터 ${win.hours}시간 ${mode === 'heat' ? '난방' : '냉방'} ${win.sp}°C`, inherit:'live', window:{ from:win.from, to:win.to, hours:win.hours, sp:win.sp, ...(win.rooms ? { rooms:win.rooms } : {}) } }
    : cleanScenario(scenario, B, base);
  if (win) { base.name = '현재 설정 유지 (예측)';
    for (const id of win.rooms || Object.keys(L.rooms)) sc.rooms[id] = { ...sc.rooms[id], spWindow:{ from:win.from, to:win.to, sp:win.sp, base:sc.rooms[id]?.coolSetpoint ?? base.coolSetpoint } }; }
  // 오늘 실측 기준에서 건물 전체 조건을 바꿀 땐: 방마다 오늘 실제로 켠 시간은 그대로 두고
  //   운전 시간대 밖은 끄고, '사람 적은 시간 끄기'면 실측·예상 재실 0명인 시간을 끄고, 사전 냉방이면 사람 오기 전 시간을 켬
  if (L && sc.inherit !== 'live' && !win) {
    const h0 = Math.floor(hmm(sc.hours[0]) / 60), h1 = Math.ceil(hmm(sc.hours[1]) / 60) || 24, pre = Math.round((sc.precoolMin || 0) / 60);
    for (const [id, x] of Object.entries(L.rooms)) { if (sc.rooms[id]?.off || sc.rooms[id]?.avail) continue;
      const soon = h => { for (let k = 0; k <= pre; k++) if (x.occ[(h + k) % 24] >= 1) return true; return false; };
      const avail = x.avail.map((v, h) => h < h0 || h >= h1 ? 0 : sc.offWhenEmpty ? (soon(h) && (v || pre) ? 1 : 0) : v || (pre && soon(h) && x.avail.some(Boolean)) ? 1 : 0);
      sc.rooms[id] = { ...sc.rooms[id], avail }; }
  }
  const o = { ...opts, live:L };
  const [b, s] = await Promise.all([runScenario(dataDir, base, o), runScenario(dataDir, sc, o)]);
  const out = { schema:'twin.scenario-compare/v1', building:B.building.id, mode, baseline:b, scenario:s };
  if (L) {
    out.calibration = calibrate(b, s, L);
    const from = Math.floor(L.now), sum = (a, k) => a.slice(k).reduce((t, v) => t + v, 0), r = v => Math.round(v * 1000) / 1000;
    out.live = { date:L.date, day:L.day, now:L.now, occSource:opts.live.occupancy?.source || null, weather:{ max:Math.max(...L.temp), min:Math.min(...L.temp), clear:L.clear }, measuredHours:L.measured.hours.length,
      occupied:Object.values(L.rooms).filter(x => x.occ.some(v => v >= 1)).length,
      busy:Object.fromEntries(Object.entries(L.rooms).map(([id, x]) => [id, x.occ.map(v => v >= 1 ? 1 : 0).join('')])) };
    out.restOfDay = { fromHour:from, savedKwh:r(sum(b.hourlyKwh, from) - sum(s.hourlyKwh, from)), savedWon:sum(b.hourlyWon, from) - sum(s.hourlyWon, from),
      baseKwh:r(sum(b.hourlyKwh, from)), scenarioKwh:r(sum(s.hourlyKwh, from)) };
  }
  if (win) out.window = windowKpi(b, s, L, win);
  out.compare = compareScenario(b, s);
  return out;
}
