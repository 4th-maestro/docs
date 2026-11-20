// 로컬 서버: 화면 파일 + 시뮬레이션 API (python http.server 대신)
//   node tools/sim-server.mjs [포트=8766]
//   GET  /api/sim/status                         → EnergyPlus 위치
//   POST /api/sim/compare { data, scenario, live? } → 기존 운전 vs 선택 운전 (twin.scenario-compare/v1)
//        live(twin.live/v1) = 트윈의 오늘 기록 → 오늘 예보·실측 기상, 실측 재실, 오늘 실제 운전 기준, 실측 전력 보정
// 이 컴퓨터(127.0.0.1)에서만 열림
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { compare, findEnergyPlus, ROOT } from './sim-runner.mjs';

const PORT = +(process.argv[2] || 8766);
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.css':'text/css; charset=utf-8', '.md':'text/plain; charset=utf-8' };
const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type':type, 'Cache-Control':'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const ep = findEnergyPlus();
let busy = Promise.resolve();       // EnergyPlus는 한 번에 한 건씩

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/sim/status') return send(res, 200, { energyplus:ep, ok:!!ep });
  if (url.pathname === '/api/sim/compare' && req.method === 'POST') {
    let body = ''; for await (const c of req) { body += c; if (body.length > 4e6) return send(res, 413, { error:'too large' }); }
    try {
      const { data = 'data/', scenario = {}, live = null, building = null } = JSON.parse(body || '{}');
      // 대시보드가 준 도면(등록 건물)은 배포 계산 서버(Lambda 레포 infra/sim)만 지원: 여기서 data 기본값으로 계산하면 다른 건물 결과가 나옴
      if (building) return send(res, 400, { error:'로컬 서버는 등록 건물 도면 계산을 지원하지 않습니다(배포 환경에서 계산).' });
      const dir = path.resolve(ROOT, String(data));
      if (!dir.startsWith(ROOT) || !fs.existsSync(path.join(dir, 'building.json'))) return send(res, 400, { error:'데이터 폴더를 찾을 수 없음' });
      const job = busy.then(() => compare(path.relative(ROOT, dir) || '.', scenario, { ep, live }));
      busy = job.catch(() => {});
      const out = await job;
      console.log(`[sim] ${out.building}${out.live ? ` 오늘 ${out.live.date} ${Math.floor(out.live.now)}시 · 보정 ×${out.calibration.factor}` : ''} ${out.window ? `지금부터 ${out.window.label} ${out.window.setpoint}°C` : out.scenario.scenario.inherit ? `방 ${(out.scenario.scenario.changed || []).join(',')}` : out.scenario.scenario.coolSetpoint + '°C'} → 절감 ${out.window ? out.window.savedKwh : out.compare.savedKwh}kWh ₩${out.window ? out.window.savedWon : out.compare.savedWon}`);
      return send(res, 200, out);
    } catch (e) { return send(res, e.code === 'NO_EP' ? 503 : 500, { error:e.message }); }
  }
  // 정적 파일
  let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.resolve(ROOT, '.' + p);
  if (!f.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(f, (e, buf) => e ? send(res, 404, 'not found', 'text/plain') : send(res, 200, buf, TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream'));
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}/digital-twin.html  (EnergyPlus: ${ep || '없음 — 시뮬레이션은 scenario.json만 표시'})`));
