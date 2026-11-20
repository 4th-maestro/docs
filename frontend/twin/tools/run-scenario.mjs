// 기존 운전 vs 내가 선택한 운전 — EnergyPlus로 계산해 절감 전력·요금·불쾌도를 비교
//   node tools/run-scenario.mjs [데이터 폴더=data/] [--sp 26] [--start 07:00] [--end 22:00] [--off-empty] [--precool 30] [--epw 기상.epw]
//   결과: <데이터 폴더>/scenario.json (트윈의 '시뮬레이션' 화면이 서버 없이도 읽는 파일)
//   오늘 실측으로: --live <파일>  (twin.live/v1 또는 trend가 든 twin.realtime/v1)
//                  --room <실id> --room-sp 26  (그 방만 설정온도 바꿔 보기, 나머지는 오늘 실제 운전 그대로)
//                  결과는 <데이터 폴더>/live-scenario.json
import fs from 'node:fs';
import path from 'node:path';
import { compare, liveFromRealtime, ROOT } from './sim-runner.mjs';

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) { const k = args[i].slice(2), v = args[i + 1];
  if (v == null || v.startsWith('--')) { opt[k] = true; args.splice(i, 1); } else { opt[k] = v; args.splice(i, 2); } i--; }
const dataDir = (args[0] || 'data/').split('\\').join('/').replace(/\/?$/, '/');
const scenario = { name:opt.name || '내 선택', ...(opt.sp ? { coolSetpoint:+opt.sp } : {}), ...(opt.start || opt.end ? { hours:[opt.start, opt.end] } : {}),
  offWhenEmpty:!!opt['off-empty'], precoolMin:+(opt.precool || 0) };
let live = null;
if (opt.live) {
  const J = f => JSON.parse(fs.readFileSync(path.join(ROOT, dataDir, f), 'utf8')), has = f => fs.existsSync(path.join(ROOT, dataDir, f));
  const B = J('building.json'), weather = has('weather.json') ? J('weather.json') : null;
  const src = JSON.parse(fs.readFileSync(path.resolve(ROOT, opt.live), 'utf8'));
  live = src.schema === 'twin.live/v1' ? src : await liveFromRealtime(B, src, { weather });
  if (opt.room) { scenario.inherit = 'live'; scenario.rooms = { [opt.room]:{ coolSetpoint:+(opt['room-sp'] || 26) } }; scenario.name = `${opt.room} ${opt['room-sp'] || 26}°C`; }
}
const res = await compare(dataDir, scenario, { epw:opt.epw ? path.resolve(ROOT, opt.epw) : null, live });
fs.writeFileSync(path.join(ROOT, dataDir, live ? 'live-scenario.json' : 'scenario.json'), JSON.stringify(res, null, 1));
if (res.live) console.log(`오늘 ${res.live.date}(${res.live.day}) ${Math.floor(res.live.now)}시 기준 · 외기 ${res.live.weather.min}~${res.live.weather.max}°C · 실측 ${res.live.measuredHours}시간 · 보정 ×${res.calibration.factor} (${res.calibration.note}${res.calibration.cvrmsePct != null ? `, CV(RMSE) ${res.calibration.cvrmseRawPct}% → ${res.calibration.cvrmsePct}%` : ''})`);
const k = r => r.kpi, c = res.compare, f = v => v.toLocaleString('ko-KR', { maximumFractionDigits:1 });
console.log(`${res.building} · ${res.baseline.weather} · ${res.baseline.days}일`);
for (const [n, r] of [['기존', res.baseline], ['선택', res.scenario]])
  console.log(`  ${n} ${r.scenario.name} ${r.scenario.coolSetpoint}°C ${r.scenario.hours.join('~')}${r.scenario.offWhenEmpty ? ' 빈방OFF' : ''}${r.scenario.precoolMin ? ` 사전${r.scenario.precoolMin}분` : ''}: 전력 ${f(k(r).elecKwh)}kWh · ₩${f(k(r).costWon)} · 불쾌 ${f(k(r).tdisKhPerZone)}K·h/실 · PPD ${f(k(r).ppd)}% · 최고 ${k(r).hottest?.tempC}°C (${k(r).hottest?.room})  [${r.run.seconds}s${r.cached ? ' 캐시' : ''}, 경고 ${r.run.warnings}, 심각 ${r.run.severe}]`);
console.log(`  절감 ${f(c.savedKwh)}kWh (${f(c.savedPct)}%) · ₩${f(c.savedWon)} · 불쾌도 ${c.tdisChange >= 0 ? '+' : ''}${f(c.tdisChange)}K·h/실 · PPD ${c.ppdChange >= 0 ? '+' : ''}${f(c.ppdChange)}%p`);
if (res.restOfDay) console.log(`  남은 시간(${res.restOfDay.fromHour}시~) 절감 ${f(res.restOfDay.savedKwh)}kWh · ₩${f(res.restOfDay.savedWon)}`);
if (opt.room && res.scenario.rooms[opt.room]) { const a = res.baseline.rooms[opt.room], b = res.scenario.rooms[opt.room];
  console.log(`  ${opt.room}: 재실 평균 ${a.avgTempC} → ${b.avgTempC}°C · 최고 ${a.maxTempC} → ${b.maxTempC}°C · 전력 ${a.elecKwh} → ${b.elecKwh}kWh`); }
console.log('→', path.join(dataDir, live ? 'live-scenario.json' : 'scenario.json'));
