// 실제 부산 기상(EPW)판 5R1C 보정 — calibrate-5r1c.mjs와 같은 방법, 날씨 입력만 EPW 실측 기반으로 바꿈
//   EPW_FILE=<부산 EPW 경로> ENERGYPLUS_DIR=<EnergyPlus 24.2 폴더> node tools/calibrate-5r1c-epw.mjs [데이터 폴더=data/]
//   EPW: Climate.OneBuilding KOR_PU_Busan-Daecheongdong.WS.471590_TMYx.2011-2025 (저장소에 넣지 않음, 직접 내려받아 경로 지정)
//   보정일·검증일: 난방 2026-01-05~13 / 01-19~27, 냉방 07-14~22 / 07-27~08-04 평일 7일씩(서로 다른 주), 하루 기온·습도·하늘(전운량)은 EPW 값
//   결과는 원본과 같은 <데이터 폴더>/rc5-calibration.json (2026-11-21 결과: 난방 검증 CV 25.2%·NMBE 0.1%, 냉방 12.2%·-4.0% 합격)
//   원본 설명 ↓
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

// 실제 부산 기상(EPW, Climate.OneBuilding 대청동 TMYx 2011-2025)에서 하루 기온·습도·하늘 상태를 뽑아 보정일·검증일을 만듦
//   (원본은 평균 ± 일교차 코사인의 가상 하루. 하늘: EPW 전운량(1/10) 0~5 맑음 1, 6~8 구름 많음 3, 9~10 흐림 4 — 기상청 SKY 기준)
const EPW = fs.readFileSync(process.env.EPW_FILE, 'latin1').split(/\r?\n/).slice(8).filter(Boolean).map(l => l.split(','));
const epwDay = date => { const [, m, d] = date.split('-').map(Number), forecast = {};
  for (const f of EPW) if (+f[1] === m && +f[2] === d) { const h = +f[3] - 1, cover = +f[22];
    forecast[h] = { TMP:+f[6], REH:+f[8], SKY:cover <= 5 ? 1 : cover <= 8 ? 3 : 4 }; }
  if (Object.keys(forecast).length !== 24) throw new Error('EPW 하루 24시간 없음 ' + date);
  return { schema:'twin.live/v1', date, now:0, forecast, hours:{} }; };
// 평일만(운영 일정·수업표가 요일을 따름). 난방 2026-01-05~01-30, 냉방 2026-07-14~08-07 — 앞 7일 보정, 뒤 7일 검증(서로 다른 주)
const weekdays = (from, to) => { const out = []; for (let t = Date.parse(from + 'T12:00:00Z'); t <= Date.parse(to + 'T12:00:00Z'); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); } return out; };
const DAYS = {
  heat:{ calib:weekdays('2026-01-05', '2026-01-13').map(epwDay), valid:weekdays('2026-01-19', '2026-01-27').map(epwDay) },
  cool:{ calib:weekdays('2026-07-14', '2026-07-22').map(epwDay), valid:weekdays('2026-07-27', '2026-08-04').map(epwDay) },
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
  criteria:'ASHRAE Guideline 14 시간 단위: CV(RMSE) ≤ 30%, NMBE ±10% (노션 3차 초안 제안값과 같음) · 실제 부산 기상(EPW 대청동 TMYx 2011-2025) 평일 보정 7일·검증 7일, 서로 다른 주',
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
