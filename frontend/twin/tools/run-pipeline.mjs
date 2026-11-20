// 레시피 → building.json (명령줄). 브라우저 화면(pipeline.html)과 같은 코어(pipeline/pipeline-core.js)를 쓴다.
//   node tools/run-pipeline.mjs [레시피=source/eng6/recipe.json] [출력=data/building.json] [--model-input 폴더]
//   --model-input: 에어컨 위치 예측 모델에 넣을 패키지(층별 보정 평면도·벽 그림 PNG + 실 다각형 JSON)를 폴더에 쓴다
// 레시피의 acModel.file(twin.acplacement/v1)이 있으면 모델 예측 위치를 쓴다 (도면 표기 > 모델 > 사진 > 추정).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as P from '../pipeline/pipeline-core.js';
import { expandFloorGroups, floorResultFor } from '../pipeline/plan-upload.js';
import { applyAutomaticExterior, applyFacadeTaper, floorForRoomDetection } from '../pipeline/auto-exterior.js';
import { decode, encodePng } from './image-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) { opt[args[i].slice(2)] = args[i + 1]; args.splice(i, 2); i--; }
const recipePath = path.resolve(root, args[0] || 'source/eng6/recipe.json');
const outPath = path.resolve(root, args[1] || 'data/building.json');
const R = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
const base = path.resolve(root, R.base || '');

const imgs = new Map(), img = f => { if (!imgs.has(f)) imgs.set(f, decode(path.resolve(base, f))); return imgs.get(f); };

const W = R.building.size.w, D = R.building.size.d, results = {}, rects = {};
for (const f of R.floors) {
  const rect = f.mode !== 'manual' && f.image && f.corners ? P.rectify(img(f.image), f.corners, W, D, f.darkPlan) : null;
  rects[f.id] = rect;
  results[f.id] = P.floorRooms(f, P.resolveFloor(f, rect, W, D), W, D);
}
for (const p of R.interior || []) for (const k of ['floorBox', 'wallBox']) if (p[k]) p[k === 'floorBox' ? 'floor' : 'wall'] = P.medianColor(img(p.file), p[k]);
// 외부 사진의 창 높이 (pipeline.html의 calcWindow와 같은 계산)
{ const sills = [], heads = [];
  for (const p of R.exterior?.photos || []) { const slabs = p.marks.filter(m => m.kind === 'slab').map(m => m.y).sort((a, b) => a - b);
    for (const m of p.marks.filter(m => m.kind !== 'slab')) { const below = slabs.find(y => y > m.y), above = [...slabs].reverse().find(y => y < m.y);
      if (below != null && above != null) (m.kind === 'sill' ? sills : heads).push((below - m.y) / (below - above)); } }
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length, FH = R.building.floorHeight;
  if (sills.length && heads.length) R.exterior.window = { sill:Math.round(avg(sills) * FH * 20) / 20, head:Math.round(avg(heads) * FH * 20) / 20, n:R.exterior.photos.filter(p => p.marks.length).length }; }
// 모델 예측 결과 파일
if (R.acModel?.file) { const f = path.resolve(base, R.acModel.file); if (fs.existsSync(f)) R.acModel.result = JSON.parse(fs.readFileSync(f, 'utf8')); else console.log('  확인: 모델 결과 파일 없음', R.acModel.file); }

const { recipe, sources } = expandFloorGroups(R), expandedResults = {};
if (R.autoExterior) applyAutomaticExterior(recipe.floors, R.autoRoof);
applyFacadeTaper(recipe.floors, R.facadeTaper);
for (const [index, floor] of recipe.floors.entries()) {
  const src = sources.get(floor.id).id;
  rects[floor.id] = rects[src];
  const bounded = floorForRoomDetection(floor);
  if (bounded === floor) {
    expandedResults[floor.id] = floorResultFor(results[src], src, floor.id);
  } else {
    recipe.floors[index] = bounded;
    expandedResults[floor.id] = P.floorRooms(bounded, P.resolveFloor(bounded, rects[floor.id], W, D), W, D);
  }
}
const out = P.assemble(recipe, expandedResults);
fs.mkdirSync(path.dirname(outPath), { recursive:true });
fs.writeFileSync(outPath, JSON.stringify(out.json, null, 1));
if (out.json.site && R.site?.image) {          // 스카이뷰 사진을 데이터 폴더로 복사 (검증 그림·파이프라인 화면용)
  fs.copyFileSync(path.resolve(root, R.base || '', R.site.image), path.join(path.dirname(outPath), out.json.site.image));
  const S = out.json.site;
  console.log(`스카이뷰 → ${S.image} · 방위 ${S.northDeg}° · 맞춤 오차 ${S.residualM}m${S.check ? ` · 모양 IoU ${S.check.iou}` : ''}`);
  if (S.fitSkipped) console.log(`  모양 보정 안 함: ${S.fitSkipped}`);
}
const hash = crypto.createHash('sha256').update(JSON.stringify(out.json)).digest('hex').slice(0, 16);
const st = out.stats;
for (const z of out.zones || []) console.log(`공조 구역: ${z.room} (실내기 ${z.idus}대) → ${z.zones}개 구역`);
console.log(`${path.relative(root, outPath)}  실 ${st.rooms} · 실내기 ${st.idus} (도면 ${st.plan} · 모델 ${st.model} · 사진 ${st.photo} · 추정 ${st.estimate}) · 해시 ${hash}`);
for (const w of out.warn) console.log('  확인:', w);

if (opt['model-input']) {
  const dir = path.resolve(root, opt['model-input']); fs.mkdirSync(dir, { recursive:true });
  // 모델 입력은 평면도 사진과 같은 좌표(스카이뷰 모양 보정 전)
  const inp = P.modelInput(recipe, out.planFloors);
  for (const f of out.planFloors) {
    const fl = inp.floors.find(x => x.id === f.id);
    if (rects[f.id]) fs.writeFileSync(path.join(dir, fl.plan), encodePng(rects[f.id])); else fl.plan = null;
    fs.writeFileSync(path.join(dir, fl.walls), encodePng(P.renderWalls(f, W, D)));
  }
  fs.writeFileSync(path.join(dir, 'model-input.json'), JSON.stringify(inp, null, 1));
  console.log(`모델 입력 패키지 → ${path.relative(root, dir)} (${inp.floors.length}개 층)`);
}
