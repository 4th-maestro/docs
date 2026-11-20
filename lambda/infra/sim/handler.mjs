// 운전 시뮬레이션 계산 서버(EnergyPlus) Lambda: 트윈 로컬 서버(twin/tools/sim-server.mjs)의 /api/sim 두 경로를 그대로 제공
//   GET  /api/sim/status                                      → { energyplus, ok }
//   POST /api/sim/compare { data | building, scenario, live? }  → twin.scenario-compare/v1 (sim-runner.compare 결과 그대로)
//
// - 계산 코드는 트윈 것을 수정 없이 사용: 이미지의 /var/task/twin 을 처음 호출 때 /tmp/twin 으로 복사
//   (sim-runner가 결과를 <트윈>/sim/<건물>/runs/<해시>/ 에 쓰는데 Lambda는 /tmp만 쓰기 가능)
// - 건물 지정 두 가지
//   data:     데모 건물 폴더(twin/data/buildings.json 의 data 값만 허용, 예 'data/busan-station/')
//   building: 판매사가 등록한 건물의 도면(twin.building/v1, 대시보드가 GET /buildings/{id}/twin 으로 받아 트윈이 전달)
//             → /tmp/twin/data/host/<내용 해시>/building.json 으로 쓰고 그 폴더로 계산. 요금표는 기본값(일반용 갑)
//             운영 시간(operation)은 대시보드 건물 설정으로 덮어씀: BUILDINGS_TABLE의 hours·weekend 위에
//             판매사가 화면에서 수정한 값(OWNERS_TABLE 항목의 overrides)을 덮어쓴 값(대시보드 src/buildings.py와 같음)
//             도면 변환 기본값(평일 08~21시, 주말 없음)이 남아 있으면 '주말 운영' 건물도 토요일에 난방이 켜지지 않아 절감 0(2026-11-21 확인)
// - 접근: CloudFront가 붙이는 비밀 헤더(x-maestro-sim)가 SIM_SECRET과 같을 때만 처리(Function URL 직접 호출 차단)
// - 동시 실행: Lambda 예약 동시성(template.yaml)으로 제한. 한 실행 환경은 한 번에 한 요청만 받음
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC =process.env.TWIN_SRC || path.join(process.env.LAMBDA_TASK_ROOT || '/var/task', 'twin');
const WORK = process.env.TWIN_WORK || '/tmp/twin';
const MAX_BODY = 3 << 20;            // 3MB (Function URL 요청 한도 6MB, 데모 도면 110~240KB)
const LIMITS = { floors:60, rooms:1500, idus:3000 };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;   // building.id는 결과 저장 경로에 쓰임: 경로 문자 금지

// fs.cpSync 대신 직접 복사: Windows Node 22에서 한글 경로의 cpSync가 프로세스를 종료시킴(세그폴트, 2026-11-21 로컬 테스트)
function copyDir(src, dst){
  fs.mkdirSync(dst, { recursive:true });
  for (const e of fs.readdirSync(src, { withFileTypes:true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

let runner = null;
export async function load(){
  if (runner) return runner;
  if (!fs.existsSync(path.join(WORK, 'tools', 'sim-runner.mjs'))) copyDir(SRC, WORK);
  runner = await import(pathToFileURL(path.join(WORK, 'tools', 'sim-runner.mjs')).href);
  return runner;
}

export class BadRequest extends Error {}

// 데모 건물 폴더: buildings.json 목록 값만 허용
export function demoDir(data){
  const list = JSON.parse(fs.readFileSync(path.join(WORK, 'data', 'buildings.json'), 'utf8')).buildings.map(b => b.data);
  const norm = String(data || '').replace(/^\.?\//, '');
  const hit = list.find(d => d === norm || d === norm + '/');
  if (!hit) throw new BadRequest(`데모 건물 폴더가 아님: ${norm || '(없음)'}`);
  return hit;
}

// 등록 건물 도면 검사(형식 오류는 BadRequest)
export function checkBuilding(B){
  if (!B || typeof B !== 'object' || Array.isArray(B)) throw new BadRequest('building은 객체여야 함');
  if (B.schema !== 'twin.building/v1') throw new BadRequest('building.schema는 twin.building/v1');
  const id = B.building?.id, size = B.building?.size;
  if (typeof id !== 'string' || !ID.test(id)) throw new BadRequest('building.building.id 형식 오류(영문·숫자·._- 80자 이하)');
  if (!(size && Number.isFinite(+size.w) && Number.isFinite(+size.d) && +size.w > 0 && +size.d > 0)) throw new BadRequest('building.building.size(w, d) 필요');
  if (!Array.isArray(B.floors) || !B.floors.length) throw new BadRequest('building.floors 필요');
  const rooms = B.floors.reduce((n, f) => n + (Array.isArray(f?.rooms) ? f.rooms.length : 0), 0);
  if (B.floors.length > LIMITS.floors || rooms > LIMITS.rooms || (B.idus || []).length > LIMITS.idus)
    throw new BadRequest(`도면이 너무 큼(층 ${LIMITS.floors}, 실 ${LIMITS.rooms}, 실내기 ${LIMITS.idus} 이하)`);
  if (!rooms) throw new BadRequest('building.floors에 실(rooms)이 없음');
}

// 등록 건물 도면 검사 → /tmp 폴더에 쓰고 상대 경로 반환
export function hostDir(B){
  checkBuilding(B);
  const json = JSON.stringify(B);
  const rel = `data/host/${crypto.createHash('sha1').update(json).digest('hex').slice(0, 12)}`;
  const dir = path.join(WORK, rel);
  if (!fs.existsSync(path.join(dir, 'building.json'))) {
    fs.mkdirSync(dir, { recursive:true });
    fs.copyFileSync(path.join(HERE, 'default-tariff.json'), path.join(dir, 'tariff.json'));
    fs.writeFileSync(path.join(dir, 'building.json'), json);
  }
  return rel;
}

// 대시보드 건물 설정 → 트윈 operation
//   hours [시작, 종료] 0~24 정수 → 'HH:00', weekend true면 주말도 같은 시간, false면 주말 운영 없음(null)
export function operationOf(item){
  const h = (item?.hours || []).map(Number);
  if (h.length !== 2 || !h.every(v => Number.isInteger(v) && v >= 0 && v <= 24) || h[0] >= h[1]) return null;
  const span = h.map(v => `${String(v).padStart(2, '0')}:00`);
  return { source:'대시보드 건물 설정(운영 시간·주말 운영)', weekday:span, weekend:item.weekend === true ? span : null };
}

// DynamoDB 항목의 hours·weekend → { hours?, weekend? } (없는 필드는 빼서 덮어쓰기에 쓰임)
export function profileOf(m){
  if (!m) return null;
  const out = {};
  if (Array.isArray(m.hours?.L)) out.hours = m.hours.L.map(x => +x.N);
  if (typeof m.weekend?.BOOL === 'boolean') out.weekend = m.weekend.BOOL;
  return Object.keys(out).length ? out : null;
}

// 대시보드와 같은 값: 원본(BUILDINGS_TABLE) 위에 판매사 수정값(OWNERS_TABLE 항목의 overrides)을 덮어씀(src/buildings.py와 같은 규칙)
export function mergeProfile(base, overrides){
  if (!base && !overrides) return null;
  return { ...(base || {}), ...(overrides || {}) };
}

// 테스트에서 바꿔 끼우는 조회 함수: 건물 ID → { hours, weekend }(없으면 null)
export const deps = {
  async getBuilding(id){
    const bt = process.env.BUILDINGS_TABLE, ot = process.env.OWNERS_TABLE;
    if (!bt && !ot) return null;
    const { DynamoDBClient, GetItemCommand } = await import('@aws-sdk/client-dynamodb');
    deps.client ||= new DynamoDBClient({});
    const get = (TableName, ProjectionExpression) => TableName
      ? deps.client.send(new GetItemCommand({ TableName, Key:{ buildingId:{ S:id } }, ProjectionExpression })).then(r => r.Item || null) : null;
    const [b, o] = await Promise.all([get(bt, 'hours, weekend'), get(ot, 'overrides')]);
    return mergeProfile(profileOf(b), profileOf(o?.overrides?.M));
  },
};

// 등록 건물 도면에 대시보드 운영 시간을 적용한 복사본(조회 실패·항목 없음이면 도면 값 그대로)
//   id: 대시보드 건물 ID(트윈이 보낸 buildingId). 도면 안 building.id는 도면 변환이 붙인 값이라 다를 수 있음
//   (2026-11-21: ifc건물 b-41nq2wss의 도면 id b-n5zgijwk, pdf건물·레츠고는 'BLDG') → 없을 때만 도면 id로 조회
export async function withDashboardOperation(B, buildingId = null){
  const id = buildingId ?? B?.building?.id;
  if (typeof id !== 'string' || !ID.test(id)) return B;
  try {
    const op = operationOf(await deps.getBuilding(id));
    return op ? { ...B, operation:op } : B;
  } catch (e) {
    console.error(JSON.stringify({ sim:'operation-lookup-failed', building:id, message:String(e?.message).slice(0, 200) }));
    return B;
  }
}

const reply = (code, body) => ({ statusCode:code, headers:{ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }, body:JSON.stringify(body) });

export async function handler(event){
  const secret = process.env.SIM_SECRET;
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (secret && headers['x-maestro-sim'] !== secret) return reply(403, { error:'forbidden' });
  const method = event.requestContext?.http?.method || 'GET', p = event.rawPath || '/';
  const sim = await load();
  if (p.endsWith('/api/sim/status')) { const ep = sim.findEnergyPlus(); return reply(200, { energyplus:ep, ok:!!ep }); }
  if (!(p.endsWith('/api/sim/compare') && method === 'POST')) return reply(404, { error:'not found' });
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  if (Buffer.byteLength(raw) > MAX_BODY) return reply(413, { error:'too large' });
  const t0 = Date.now();
  try {
    let req; try { req = JSON.parse(raw || '{}'); } catch { throw new BadRequest('JSON 형식 오류'); }
    const { scenario = {}, live = null, building = null, data = 'data/', buildingId = null } = req;
    if (buildingId != null && (typeof buildingId !== 'string' || !ID.test(buildingId))) throw new BadRequest('buildingId 형식 오류');
    // 검사 먼저(잘못된 도면은 조회 없이 400), 운영 시간을 바꾼 도면으로 폴더를 만듦(설정이 바뀌면 내용 해시가 달라져 결과 캐시도 새로 계산)
    if (building) checkBuilding(building);
    const B = building ? await withDashboardOperation(building, buildingId) : null;
    const dir = B ? hostDir(B) : demoDir(data);
    const out = await sim.compare(dir, scenario, { ep:sim.findEnergyPlus(), live });
    console.log(JSON.stringify({ sim:'compare', building:out.building, buildingId, operation:B?.operation?.source ? { weekday:B.operation.weekday, weekend:B.operation.weekend } : null,
      host:!!building, live:!!out.live, ms:Date.now() - t0,
      runs:[out.baseline?.run?.seconds, out.scenario?.run?.seconds], cached:[!!out.baseline?.cached, !!out.scenario?.cached] }));
    return reply(200, out);
  } catch (e) {
    if (e instanceof BadRequest) return reply(400, { error:e.message });
    console.error(JSON.stringify({ sim:'error', code:e.code || null, message:String(e.message).slice(0, 500), ms:Date.now() - t0 }));
    return reply(e.code === 'NO_EP' ? 503 : 500, { error:e.message });
  }
}
