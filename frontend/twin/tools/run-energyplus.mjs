// building.json → EnergyPlus 입력(IDF) → (EnergyPlus가 설치돼 있으면) 실행 → 실별 냉방부하 vs 실내기 용량
//   node tools/run-energyplus.mjs [building.json=data/building.json] [출력 폴더=sim/<건물>] [--epw 기상파일.epw]
// EnergyPlus 찾는 순서: 환경변수 ENERGYPLUS_DIR → C:\EnergyPlusV24-2-0 등 기본 설치 폴더 → PATH
// 기상파일이 없으면 부산 설계일(여름·겨울 하루씩)로 돌린다. 있으면 6~9월 실제 기상으로 돌린다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toIdf, readResults } from '../pipeline/energyplus.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) { opt[args[i].slice(2)] = args[i + 1]; args.splice(i, 2); i--; }
const inPath = path.resolve(root, args[0] || 'data/building.json');
const B = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const outDir = path.resolve(root, args[1] || `sim/${B.building.id}`);
fs.mkdirSync(outDir, { recursive:true });

const epw = opt.epw ? path.resolve(root, opt.epw) : null;
const { idf, zones } = toIdf(B, { weatherFile:!!epw });
fs.writeFileSync(path.join(outDir, 'in.idf'), idf);
fs.writeFileSync(path.join(outDir, 'zones.json'), JSON.stringify(zones, null, 1));
console.log(`IDF → ${path.relative(root, path.join(outDir, 'in.idf'))}  (영역 ${zones.zones.length}개 · ${zones.weather})`);

function findEnergyPlus(){
  const exe = process.platform === 'win32' ? 'energyplus.exe' : 'energyplus';
  const cands = [];
  if (process.env.ENERGYPLUS_DIR) cands.push(path.join(process.env.ENERGYPLUS_DIR, exe));
  for (const base of ['C:/', 'C:/Program Files/', os.homedir() + '/', '/usr/local/', '/Applications/']) {
    try { for (const d of fs.readdirSync(base).filter(d => /^EnergyPlus/i.test(d)).sort().reverse()) cands.push(path.join(base, d, exe)); } catch {}
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['energyplus'], { encoding:'utf8', stdio:['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}
const ep = findEnergyPlus();
if (!ep) {
  console.log('EnergyPlus가 설치돼 있지 않아 입력 파일만 만들었습니다.');
  console.log('  설치: https://energyplus.net/downloads (24.2 권장) → 설치 후 이 명령을 다시 실행');
  console.log('  또는 EP-Launch에서 in.idf를 직접 열어 실행할 수 있습니다.');
  process.exit(0);
}
console.log('EnergyPlus:', ep);
const epArgs = ['-r', '-d', outDir, ...(epw ? ['-w', epw] : ['-D']), path.join(outDir, 'in.idf')];
try { execFileSync(ep, epArgs, { stdio:'inherit' }); }
catch { console.log('EnergyPlus 실행 실패 — 자세한 내용은', path.join(outDir, 'eplusout.err')); process.exit(1); }
const csv = path.join(outDir, 'eplusout.csv');
if (!fs.existsSync(csv)) { console.log('결과 CSV 없음 (eplusout.err 확인)'); process.exit(1); }
const res = readResults(fs.readFileSync(csv, 'utf8'), zones);
const simPath = path.join(path.dirname(inPath), 'simulation.json');
fs.writeFileSync(simPath, JSON.stringify(res, null, 1));
const v = Object.values(res.rooms), cnt = k => v.filter(r => r.verdict === k).length;
console.log(`결과 → ${path.relative(root, simPath)}  적정 ${cnt('적정')} · 용량 부족 ${cnt('용량 부족')} · 과대 설치 ${cnt('과대 설치')} · 실내기 없음 ${cnt('실내기 없음')}`);
