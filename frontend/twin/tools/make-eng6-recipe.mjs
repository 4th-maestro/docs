// 제6공학관 예시 레시피 만들기 (사람이 파이프라인 화면에서 할 입력을 파일로 남긴 것)
//   2F·3F: 피난안내도 사진 → 자동 벽 검출 + 라벨 점 + 보정 벽
//   1F·4F·5F: 와이파이맵(선이 흐리고 열지도가 덮여 자동 검출 불가) → 사각형 수동 트레이스
// 라벨의 호실·용도·정원은 학사 시간표·시설 대장에서 옮기는 값이다. 여기서는 기존 data/building.json의 값을 그대로 옮긴다.
// Run:  node tools/make-eng6-recipe.mjs
import fs from 'node:fs';
const B = JSON.parse(fs.readFileSync(new URL('../data/building.json', import.meta.url), 'utf8'));
const k = 2000 / 1932;                       // 사진을 볼 때 쓴 축소 배율 → 원본 픽셀
const px = pts => pts.map(([x, y]) => [Math.round(x * k), Math.round(y * k)]);
const bb = p => ({ x0:Math.min(...p.map(q => q[0])), x1:Math.max(...p.map(q => q[0])), y0:Math.min(...p.map(q => q[1])), y1:Math.max(...p.map(q => q[1])) });
const c = v => Math.round(v * 20) / 20;
const attrs = r => r.type === 'room' ? { type:'room', number:r.number, use:r.use, capacity:r.capacity } : { type:r.type, name:r.name };

const AUTO = {
  '2F': { image:'plans/evac-2F.jpg', corners:px([[316, 410], [1832, 413], [1834, 1556], [346, 1503]]), dark:22, ev:[33.6, 17.2], fixes:[
    { op:'wall', x0:35.1, y0:11.9, x1:35.1, y1:22.6 },                          // '현위치' 스티커가 가린 중정 동쪽 변
    { op:'wall', x0:26.9, y0:0, x1:26.9, y1:4.8 },
    { op:'merge', a:[21, 17.5], b:[33.5, 20.3] },                                  // 스티커 아래로 잘린 중정 조각
    { op:'label', x:39.4, y:22.5, type:'core', name:'계단실' } ] },                  // 동측 계단 옆 좁은 칸                           // 6209 | 6209-1 칸막이 (흐린 선)
  '3F': { image:'plans/evac-3F.jpg', corners:px([[262, 348], [1797, 376], [1735, 1466], [307, 1473]]), dark:22, ev:[32.6, 17.7], fixes:[
    // '현위치' 스티커가 가린 중정 테두리와 엘리베이터 윗변
    { op:'wall', x0:34.1, y0:12.4, x1:34.1, y1:22.4 },
    { op:'wall', x0:31.2, y0:16.4, x1:34.1, y1:16.4 }, { op:'wall', x0:31.2, y0:16.4, x1:31.2, y1:18.95 } ] },
};
const floors = B.floors.map(f => {
  const a = AUTO[f.id];
  if (a) {
    const ops = [...a.fixes];
    for (const r of f.rooms) { const b = bb(r.polygon);
      if (b.x0 < 0 || b.y0 < 0 || b.x1 > B.building.size.w || b.y1 > B.building.size.d) ops.push({ op:'rect', ...b, ...attrs(r) });   // 건물 밖 부속(외부계단)은 사각형 지정
      else ops.push({ op:'label', x:c((b.x0 + b.x1) / 2), y:c((b.y0 + b.y1) / 2), ...attrs(r) }); }
    if (f.atrium) { ops.push({ op:'label', x:c((B.atrium.x0 + B.atrium.x1) / 2 - 3), y:c((B.atrium.y0 + B.atrium.y1) / 2), type:'atrium' });
      ops.push({ op:'label', x:a.ev[0], y:a.ev[1], type:'elevator' }); }
    return { id:f.id, image:a.image, corners:a.corners, mode:'auto', params:{ dark:a.dark, sat:70, close:1, minArea:3.5 }, ops };
  }
  const ops = f.rooms.map(r => { const b = bb(r.polygon); return { op:'rect', ...b, ...attrs(r) }; });
  if (f.atrium) ops.push({ op:'rect', ...B.atrium, type:'atrium' });
  return { id:f.id, image:`plans/wifimap-${f.id}.png`, corners:null, mode:'manual', params:{ dark:40, sat:70, close:1, minArea:3.5 }, ops };
});
const recipe = {
  schema:'twin.pipeline/v1', id:'eng6-2026-11', base:'source/eng6/',
  building:{ id:B.building.id, name:B.building.name, campus:B.building.campus, size:B.building.size, floorHeight:B.building.floorHeight, ceiling:B.building.ceiling },
  operation:B.operation,
  floors,
  exterior:{ photos:[] },
  interior:[
    { file:'photos/interior-8.jpg', use:'lecture', floorBox:[60, 1700, 700, 1960], wallBox:[20, 470, 150, 560] },
    { file:'photos/interior-5.jpg', use:'lab', floorBox:[300, 1640, 1500, 1960], wallBox:[1500, 20, 1900, 70] },
  ],
  acPhotos:[],
};
fs.writeFileSync(new URL('../source/eng6/recipe.json', import.meta.url), JSON.stringify(recipe, null, 1));
console.log(floors.map(f => `${f.id} ${f.mode} ops=${f.ops.length}`).join(' | '));
