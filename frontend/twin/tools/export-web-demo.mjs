// 트윈이 인식한 건물 → 대시보드(웹) 데모 데이터
//   node tools/export-web-demo.mjs [--web <웹 프로젝트 폴더>]   (기본: 이 twin 폴더의 상위 = 4th-maestro Frontend)
//
// 트윈이 도면에서 먼저 인식하므로 건물·층·호실·실내기 목록은 트윈이 정하고, 웹은 그걸 따른다.
//   data/buildings.json 의 건물마다 building.json 을 읽어
//     <웹>/public/demo/<id>.json      웹 Status 형식 (pipeline/web-demo.js) — 웹 목업이 여기에 ±변동을 줌
//     <웹>/public/demo/index.json     건물 id 목록 (웹의 건물 선택)
//     <웹>/src/energy/buildings.json  에너지 분석 목업의 건물 프로필
// 화면에 보이는 '실시간' 값은 웹이 만들고 트윈은 받아서 그리기만 한다. (웹에서 '건물 추가'로 넣은 건물은 브라우저가 같은 코드로 만듦)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webStatus, webProfile } from '../pipeline/web-demo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), webArg = args.indexOf('--web');
const web = path.resolve(root, webArg >= 0 ? args[webArg + 1] : '..');
if (!fs.existsSync(path.join(web, 'package.json'))) { console.error(`웹 프로젝트 폴더가 아니에요: ${web} (--web 으로 지정)`); process.exit(1); }

const J = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const index = J('data/buildings.json').buildings, profiles = [];
for (const b of index) {
  const B = J(path.join(b.data, 'building.json'));
  const s = webStatus(B, { id:b.id, use:b.use, basis:b.basis || `트윈 도면 인식 (${b.data}building.json)` });
  fs.writeFileSync(path.join(web, 'public/demo', b.id + '.json'), JSON.stringify(s));
  profiles.push(webProfile(B, s));
  console.log(`${b.id} ${s.building.name}: ${s.floors.join(' ')} · 호실 ${s.rooms.length} · 실내기 ${s.rooms.reduce((t, r) => t + r.idus.length, 0)} · 운전 ${s.summary.on} · ${s.summary.powerKw}kW`);
}
fs.writeFileSync(path.join(web, 'public/demo/index.json'), JSON.stringify(index.map(b => b.id)));
fs.writeFileSync(path.join(web, 'src/energy/buildings.json'), JSON.stringify(profiles, null, 1) + '\n');
console.log('→', path.relative(process.cwd(), path.join(web, 'public/demo')), '· src/energy/buildings.json');
