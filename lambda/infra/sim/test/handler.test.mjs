// infra/sim 핸들러 테스트(Node 내장 테스트, 패키지 설치 없음)
//   bash infra/sim/prepare.sh && node --test infra/sim/test/handler.test.mjs
//   ENERGYPLUS_DIR이 있으면(이 PC: C:/Users/<사용자>/tools/EnergyPlus-24.2.0-...) 실제 EnergyPlus 계산까지 확인
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.TWIN_SRC = path.join(HERE, '..', 'twin');
process.env.TWIN_WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-test-'));
process.env.SIM_SECRET = 's3cret';
const { handler, hostDir, demoDir, BadRequest, load, operationOf, withDashboardOperation, deps, profileOf, mergeProfile } = await import('../handler.mjs');
const realGet = deps.getBuilding;
await load();

const DEMO = JSON.parse(fs.readFileSync(path.join(process.env.TWIN_SRC, 'data', 'busan-station', 'building.json'), 'utf8'));
const host = id => ({ ...structuredClone(DEMO), building:{ ...DEMO.building, id } });
const ev = (method, rawPath, body, secret = 's3cret') => ({ rawPath, requestContext:{ http:{ method } }, headers:secret ? { 'X-Maestro-Sim':secret } : {},
  body:body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), isBase64Encoded:false });
const json = r => JSON.parse(r.body);

test('비밀 헤더가 없거나 다르면 403', async () => {
  assert.equal((await handler(ev('GET', '/api/sim/status', undefined, null))).statusCode, 403);
  assert.equal((await handler(ev('GET', '/api/sim/status', undefined, 'wrong'))).statusCode, 403);
});

test('status와 알 수 없는 경로', async () => {
  const r = await handler(ev('GET', '/api/sim/status'));
  assert.equal(r.statusCode, 200);
  assert.equal(typeof json(r).ok, 'boolean');
  assert.equal((await handler(ev('GET', '/api/sim/compare'))).statusCode, 404);
  assert.equal((await handler(ev('POST', '/other'))).statusCode, 404);
});

test('데모 폴더는 buildings.json 목록만 허용', () => {
  assert.equal(demoDir('data/busan-station/'), 'data/busan-station/');
  assert.equal(demoDir('data/busan-station'), 'data/busan-station/');
  assert.equal(demoDir('data/'), 'data/');
  for (const bad of ['../', 'data/../../etc', 'data/host/x', '/etc/passwd', ''])
    assert.throws(() => demoDir(bad), BadRequest, bad);
});

test('등록 건물 도면 검사', () => {
  const rel = hostDir(host('b-test01'));
  assert.match(rel, /^data\/host\/[0-9a-f]{12}$/);
  const dir = path.join(process.env.TWIN_WORK, rel);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'building.json'), 'utf8')).building.id, 'b-test01');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tariff.json'), 'utf8')).wonPerKwh, 134.2);
  assert.equal(hostDir(host('b-test01')), rel);   // 같은 도면은 같은 폴더(결과 캐시 재사용)
  const bad = [null, [], { ...DEMO, schema:'x' }, host('../../etc'), host('a/b'), host(''), { ...DEMO, floors:[] },
    { ...DEMO, building:{ ...DEMO.building, size:{ w:0, d:10 } } }, { ...DEMO, floors:DEMO.floors.map(f => ({ ...f, rooms:[] })) },
    { ...DEMO, floors:Array.from({ length:61 }, () => DEMO.floors[0]) }];
  for (const b of bad) assert.throws(() => hostDir(b), BadRequest);
});

test('compare 입력 오류는 400', async () => {
  for (const body of ['{', { data:'../x' }, { building:host('../x') }, { building:{ schema:'twin.building/v1' } }]) {
    const r = await handler(ev('POST', '/api/sim/compare', body));
    assert.equal(r.statusCode, 400, JSON.stringify(body).slice(0, 40));
    assert.ok(json(r).error);
  }
  const big = await handler(ev('POST', '/api/sim/compare', 'x'.repeat((3 << 20) + 1)));
  assert.equal(big.statusCode, 413);
});

test('대시보드 운영 시간 → 트윈 operation', () => {
  assert.deepEqual(operationOf({ hours:[8, 21], weekend:true }).weekend, ['08:00', '21:00']);
  assert.deepEqual(operationOf({ hours:[9, 18], weekend:false }), { source:'대시보드 건물 설정(운영 시간·주말 운영)', weekday:['09:00', '18:00'], weekend:null });
  assert.deepEqual(operationOf({ hours:[0, 24], weekend:true }).weekday, ['00:00', '24:00']);
  for (const bad of [null, {}, { hours:[9] }, { hours:[18, 9] }, { hours:[9, 25] }, { hours:[8.5, 18] }]) assert.equal(operationOf(bad), null);
});

test('원본 위에 판매사 수정값을 덮어씀(대시보드와 같은 값)', () => {
  // 2026-11-21 ifc건물: 원본 09~18시·주말 휴무, 판매사 화면에서 02~24시·주말 운영으로 저장(OWNERS overrides)
  const base = profileOf({ hours:{ L:[{ N:'9' }, { N:'18' }] }, weekend:{ BOOL:false } });
  const over = profileOf({ hours:{ L:[{ N:'2' }, { N:'24' }] }, weekend:{ BOOL:true } });
  assert.deepEqual(mergeProfile(base, over), { hours:[2, 24], weekend:true });
  assert.deepEqual(mergeProfile(base, profileOf({ weekend:{ BOOL:true } })), { hours:[9, 18], weekend:true });   // 일부만 수정
  assert.deepEqual(mergeProfile(base, null), base);
  assert.deepEqual(mergeProfile(null, over), over);                                                           // 원본 항목 없음
  assert.equal(mergeProfile(null, null), null);
  assert.equal(profileOf({ name:{ S:'x' } }), null);
});

test('등록 건물 도면에 대시보드 운영 시간 적용', async (t) => {
  t.after(() => { deps.getBuilding = realGet; });
  const asked = [];
  deps.getBuilding = async id => { asked.push(id); return { hours:[9, 18], weekend:true }; };
  const B = await withDashboardOperation(host('b-test01'));
  assert.deepEqual(B.operation.weekend, ['09:00', '18:00']);
  assert.deepEqual(asked, ['b-test01']);
  assert.notEqual(DEMO.operation?.source, B.operation.source);   // 원본 도면 객체는 그대로
  deps.getBuilding = async () => null;                            // 대시보드에 없는 건물: 도면 값 유지
  assert.deepEqual((await withDashboardOperation(host('b-none'))).operation, DEMO.operation);
  deps.getBuilding = async () => { throw new Error('denied'); };  // 조회 실패: 도면 값 유지(계산은 계속)
  assert.deepEqual((await withDashboardOperation(host('b-err'))).operation, DEMO.operation);
  // 형식 오류 도면은 조회 없이 400
  asked.length = 0; deps.getBuilding = async id => { asked.push(id); return null; };
  assert.equal((await handler(ev('POST', '/api/sim/compare', { building:host('../x') }))).statusCode, 400);
  assert.deepEqual(asked, []);
});

test('운영 시간은 대시보드 건물 ID(buildingId)로 조회', async (t) => {
  t.after(() => { deps.getBuilding = realGet; });
  const asked = [];
  deps.getBuilding = async id => { asked.push(id); return { hours:[2, 24], weekend:true }; };
  // 2026-11-21 실제 도면: ifc건물 b-41nq2wss의 도면 id는 b-n5zgijwk, pdf건물·레츠고는 'BLDG'
  assert.deepEqual((await withDashboardOperation(host('BLDG'), 'b-41nq2wss')).operation.weekday, ['02:00', '24:00']);
  await withDashboardOperation(host('b-n5zgijwk'));                 // buildingId가 없으면(이전 트윈) 도면 id로 조회
  assert.deepEqual(asked, ['b-41nq2wss', 'b-n5zgijwk']);
  for (const bad of ['../x', 'a/b', '', 5]) {                        // 형식 오류는 조회 없이 400
    asked.length = 0;
    const r = await handler(ev('POST', '/api/sim/compare', { building:host('BLDG'), buildingId:bad }));
    assert.equal(r.statusCode, 400, String(bad));
    assert.deepEqual(asked, []);
  }
});

const EP = process.env.ENERGYPLUS_DIR && fs.existsSync(process.env.ENERGYPLUS_DIR);
test('토요일: 대시보드가 주말 운영이면 난방이 켜져 절감이 생김', { skip:!EP && 'ENERGYPLUS_DIR 없음', timeout:300_000 }, async (t) => {
  t.after(() => { deps.getBuilding = realGet; });
  // 화면 '시간 지정 08:00~21:00, 오늘 실측 기준'과 같은 요청(2026-11-21 토요일 05:40, 실측 기록 없음)
  // 실제 등록 건물처럼 도면 id('BLDG')와 대시보드 건물 id가 다름 → buildingId로 조회해야 함
  const req = { building:host('BLDG'), buildingId:'b-weekend', scenario:{ name:'내 선택', mode:'heat', coolSetpoint:24, hours:['08:00', '21:00'] },
    live:{ schema:'twin.live/v1', date:'2026-11-21', day:'토', now:5.67, forecast:{}, hours:{} } };
  const run = async weekend => { deps.getBuilding = async id => id === 'b-weekend' ? { hours:[8, 21], weekend } : null;
    const r = await handler(ev('POST', '/api/sim/compare', req)); assert.equal(r.statusCode, 200, r.body.slice(0, 300)); return json(r); };
  const off = await run(false), on = await run(true);
  assert.equal(off.compare.savedKwh, 0);                 // 주말 휴무: 기존·선택 모두 난방 안 켬(화면에서 본 0)
  assert.notEqual(on.compare.savedKwh, 0);               // 주말 운영: 08~21시 재실 시간대 난방 → 24℃ 선택과 기존 운전 차이
  assert.ok(on.baseline.kpi.elecKwh > 0);
});


test('EnergyPlus 실제 계산: 데모 건물과 등록 건물 도면', { skip:!EP && 'ENERGYPLUS_DIR 없음', timeout:300_000 }, async () => {
  const scenario = { name:'내 선택', mode:'heat', coolSetpoint:20 };
  const demo = await handler(ev('POST', '/api/sim/compare', { data:'data/busan-station/', scenario }));
  assert.equal(demo.statusCode, 200, demo.body.slice(0, 300));
  const d = json(demo);
  assert.equal(d.schema, 'twin.scenario-compare/v1');
  assert.equal(d.building, DEMO.building.id);
  const reg = await handler(ev('POST', '/api/sim/compare', { building:host('b-test01'), scenario }));
  assert.equal(reg.statusCode, 200, reg.body.slice(0, 300));
  const g = json(reg);
  assert.equal(g.building, 'b-test01');
  assert.ok(Number.isFinite(g.compare.savedKwh));
  assert.ok(JSON.stringify(g.baseline).includes('134.2원/kWh'));   // 등록 건물은 기본 요금표(일반용 갑)
});
