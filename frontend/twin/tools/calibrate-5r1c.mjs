// 5R1C ↔ EnergyPlus 보정·검증 (노션 3차 초안: "5R1C 실시간 계산 + EnergyPlus 오프라인 보정, 근거는 EnergyPlus 대비 오차 X%",
//   "보정 기간 / 검증 기간 분리, 검증 오차 CV(RMSE)·NMBE 기록")
//   node tools/calibrate-5r1c.mjs [데이터 폴더=data/]
//   모드(난방·냉방)마다:
//   1) 날씨가 다른 보정일 3일을 EnergyPlus와 5R1C로 같은 조건(오늘 하루 계산과 같은 입력)에서 계산
//   2) 5R1C 계수(열용량·외피 열손실·일사 취득·질량–표면 결합 배율)를 격자로 바꿔 가며 보정일 전체의 시간별 전력 CV(RMSE) + 실온 오차가
//      가장 작은 값을 고르고, 전력 배율(EnergyPlus 합 ÷ 5R1C 합 — 잠열·COP 차이)을 정함
//      what-if에 쓰려면 '설정을 바꿨을 때 전력이 얼마나 변하나'도 맞아야 하므로, 날마다 설정 변경 시나리오(난방 10~12시 +2°C, 냉방 13~15시 +2°C)를
//      두 엔진으로 같이 돌려 그 변화량 오차도 함께 줄임
//   3) 보정에 쓰지 않은 검증일 2일에 그 계수로 오차를 잼
//   기준: ASHRAE Guideline 14 시간 단위 CV(RMSE) ≤ 30%, NMBE ±10% (노션 제안값과 같음)
//   결과: <데이터 폴더>/rc5-calibration.json → 트윈의 5R1C 즉시 계산(채팅 what-if)이 계수를 쓰고 오차를 함께 표시
//   EnergyPlus 결과는 sim/<건물>/runs/에 저장돼 다시 돌릴 땐 바로 나옴
import fs from 'node:fs';
import path from 'node:path';
import { runScenario, ROOT, findEnergyPlus } from './sim-runner.mjs';
import { liveDay, liveBaseline } from '../pipeline/live-day.js';
import { roomParams, simulateDay } from '../pipeline/rc5.js';

const dataDir = process.argv[2] || 'data/', dir = path.resolve(ROOT, dataDir);
const B = JSON.parse(fs.readFileSync(path.join(dir, 'building.json'), 'utf8'));
const read = f => fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null;
const tariff = read('tariff.json'), schedule = read('schedule.json'), ep = findEnergyPlus();
if (!ep) { console.error('EnergyPlus가 없어요 (24.2)'); process.exit(1); }

// 부산 근사 하루 기온: 평균 ± 일교차/2 (14시 최고) · 하늘 상태(1 맑음, 3 구름 많음, 4 흐림) — 실측이 없을 때 liveDay가 예보처럼 씀 (모두 평일)
const day = (date, mean, range, sky) => { const forecast = {};
  for (let h = 0; h < 24; h++) forecast[h] = { TMP:Math.round((mean + range / 2 * Math.cos((h - 14) / 24 * 2 * Math.PI)) * 10) / 10, REH:55, SKY:sky };
  return { schema:'twin.live/v1', date, now:0, forecast, hours:{} }; };
const DAYS = {
  heat:{ calib:[day('2026-11-20', 9, 8, 1), day('2026-12-03', 5, 6, 4), day('2027-01-14', 1, 7, 1)], valid:[day('2026-12-15', 3, 7, 3), day('2027-02-10', 4, 8, 1)] },
  cool:{ calib:[day('2026-07-20', 27, 6, 1), day('2026-08-20', 28, 5, 4), day('2026-06-25', 24, 6, 1)], valid:[day('2026-08-12', 29, 6, 3), day('2026-09-04', 26, 7, 1)] },
};
const r = v => Math.round(v * 1000) / 1000, label = m => m === 'heat' ? '난방' : '냉방';

// 설정 변경 시나리오: 운전 중인 모든 실을 2시간 동안 +2°C (what-if '지금부터 2시간'과 같은 정의)
const shifted = (base, L, mode) => { const [from, to] = mode === 'heat' ? [10, 12] : [13, 15], sc = { ...base, rooms:{ ...base.rooms } };
  for (const id of Object.keys(L.rooms)) { const b = sc.rooms[id]?.coolSetpoint ?? base.coolSetpoint; sc.rooms[id] = { ...sc.rooms[id], spWindow:{ from, to, sp:b + 2, base:b } }; }
  return sc; };
async function prepare(raw, mode){
  const L = liveDay(B, raw, { schedule }), base = liveBaseline(B, L, mode), alt = shifted(base, L, mode);
  const t0 = Date.now(), e = await runScenario(dataDir, base, { ep, live:L }), te = Date.now() - t0, e2 = await runScenario(dataDir, alt, { ep, live:L });
  return { L, e, e2, te, base, alt };
}
// 여러 날의 운전 시간을 이어 붙여 오차 계산 (ASHRAE G14: CV = √(Σ(m−s)²/(n−1)) / m̄, NMBE = Σ(m−s) / ((n−1)·m̄))
function err(days, qs, f){
  const meas = [], sim = []; let se = 0, k = 0, ep = 0, rc = 0;
  days.forEach((d, i) => { const q = qs[i]; ep += d.e.kpi.elecKwh; rc += q.elecKwh * f;
    for (let h = 0; h < 24; h++) if (d.e.hourlyKwh[h] > .01 || q.hourlyKwh[h] > .01) { meas.push(d.e.hourlyKwh[h]); sim.push(q.hourlyKwh[h] * f); }
    for (const [id, x] of Object.entries(q.rooms)) { const y = d.e.rooms[id]?.hourlyT; if (!y) continue;
      for (let h = 0; h < 24; h++) if (d.L.rooms[id]?.avail?.[h] && y[h] != null) { se += (x.hourlyT[h] - y[h]) ** 2; k++; } } });
  const n = meas.length, mean = meas.reduce((a, b) => a + b, 0) / Math.max(n, 1);
  const cv = n > 1 && mean > 0 ? Math.sqrt(meas.reduce((a, m, i) => a + (m - sim[i]) ** 2, 0) / (n - 1)) / mean * 100 : null;
  const nmbe = n > 1 && mean > 0 ? meas.reduce((a, m, i) => a + (m - sim[i]), 0) / ((n - 1) * mean) * 100 : null;
  // 설정 변경 반응: Σ(시나리오 − 기준) 전력, 5R1C가 EnergyPlus와 몇 % 다른가
  let dE = 0, dR = 0; days.forEach((d, i) => { if (!qs[i].alt) return; dE += d.e2.kpi.elecKwh - d.e.kpi.elecKwh; dR += (qs[i].alt.elecKwh - qs[i].elecKwh) * f; });
  const resp = Math.abs(dE) > .1 ? r((dR - dE) / Math.abs(dE) * 100) : null;
  return { days:days.map(d => d.L.date), hours:n, epDeltaKwh:r(dE), rcDeltaKwh:r(dR), responseErrPct:resp, epKwh:r(ep), rcKwh:r(rc), cvrmsePct:cv == null ? null : r(cv), nmbePct:nmbe == null ? null : r(nmbe), tempRmseC:k ? r(Math.sqrt(se / k)) : null };
}
const run = (P, days) => days.map(d => Object.assign(simulateDay(P, d.L, d.base, { tariff }), { alt:simulateDay(P, d.L, d.alt, { tariff }) }));
const ratio = (days, qs) => { const e = days.reduce((a, d) => a + d.e.kpi.elecKwh, 0), q = qs.reduce((a, x) => a + x.elecKwh, 0); return q > .1 ? Math.min(3, Math.max(.3, e / q)) : 1; };

const out = { schema:'twin.rc5-calibration/v1', building:B.building.id, generatedAt:new Date().toISOString(), engine:'5R1C (ISO 13790) vs EnergyPlus 24.2',
  criteria:'ASHRAE Guideline 14 시간 단위: CV(RMSE) ≤ 30%, NMBE ±10% (노션 3차 초안 제안값과 같음) · 보정일 3일과 검증일 2일은 서로 다른 날·날씨',
  response:'설정 변경 반응 = 운전 중 전 실 2시간 +2°C일 때 하루 전력 변화, 오차 ±25% 이내를 목표로 둠(우리 기준)',
  params:'k = { cap 열용량, env 외피·창 열손실, solar 일사 취득, couple 질량–표면 결합 } 배율 · factor = 전력 배율(잠열·COP 차이)', modes:{} };
for (const mode of ['heat', 'cool']) {
  const C = [], V = [];
  for (const raw of DAYS[mode].calib) C.push(await prepare(raw, mode));
  for (const raw of DAYS[mode].valid) V.push(await prepare(raw, mode));
  let best = null; const t0 = Date.now();
  for (const cap of [.5, 1, 1.5, 2, 3]) for (const env of [.7, .85, 1, 1.2, 1.4, 1.7]) for (const solar of [.5, .75, 1, 1.25, 1.5]) for (const couple of [.1, .15, .25, .4, .6, 1]) {
    const k = { cap, env, solar, couple }, qs = run(roomParams(B, k), C), e1 = err(C, qs, ratio(C, qs));
    const score = (e1.cvrmsePct ?? 999) + 10 * (e1.tempRmseC ?? 9) + Math.abs(e1.responseErrPct ?? 100) / 2;   // 전력 모양 + 실온(1°C = 10%p) + 설정 변경 반응 오차(절반 가중)
    if (!best || score < best.score) best = { k, score };
  }
  const PK = roomParams(B, best.k), qc = run(PK, C), f = ratio(C, qc), vv = err(V, run(PK, V), f);
  const t1 = performance.now(); run(PK, [C[0]]); const tq = performance.now() - t1;
  out.modes[mode] = { k:best.k, factor:r(f), calib:err(C, qc, f), valid:vv, pass:vv.cvrmsePct != null && vv.cvrmsePct <= 30 && Math.abs(vv.nmbePct) <= 10, responsePass:vv.responseErrPct != null && Math.abs(vv.responseErrPct) <= 25,
    seconds:{ energyplus:r(Math.max(...C.map(d => d.te)) / 1000), rc5:r(tq / 1000) } };
  console.log(`${label(mode)}: 계수 ${JSON.stringify(best.k)} 전력 ×${r(f)} (맞춤 ${Math.round((Date.now() - t0) / 1000)}s)`);
  console.log(`  보정 ${out.modes[mode].calib.days.join(', ')}: CV(RMSE) ${out.modes[mode].calib.cvrmsePct}% · 실온 RMSE ${out.modes[mode].calib.tempRmseC}°C · 설정 변경 반응 오차 ${out.modes[mode].calib.responseErrPct}%`);
  console.log(`  검증 ${vv.days.join(', ')}: CV(RMSE) ${vv.cvrmsePct}% · NMBE ${vv.nmbePct}% · 실온 RMSE ${vv.tempRmseC}°C · 설정 변경 반응 ${vv.rcDeltaKwh} vs EnergyPlus ${vv.epDeltaKwh}kWh (${vv.responseErrPct}%) → ${out.modes[mode].pass ? '합격' : '기준 밖'}`);
}
fs.writeFileSync(path.join(dir, 'rc5-calibration.json'), JSON.stringify(out, null, 1) + '\n');
console.log('→', path.relative(ROOT, path.join(dir, 'rc5-calibration.json')));
