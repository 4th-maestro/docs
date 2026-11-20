// 부산역 예시 레시피 만들기 (사람이 파이프라인 화면에서 할 입력을 파일로 남긴 것)
//   평면도: 역사 안의 층별 안내도 사진 1장(plans/guide-all.jpg)에 1·2·3층이 같은 축척으로 그려져 있음
//   → 층마다 '색 채움' 모드: 보라색으로 칠한 칸 = 상점·실, 칠하지 않은 칸 = 대합실·통로
//   크기: 건축물대장 미확인. 안내도 1px ≈ 0.1m(상점 한 칸 폭 ≈ 5.5m)로 가정 → 132 × 75 m. building.assumed에 남김
// 좌표는 사진을 잘라 볼 때의 픽셀(잘라낸 원점 + 원본 픽셀)로 적었다. 아래 crop()이 원본 픽셀로 바꾼다.
// Run:  node tools/make-busan-recipe.mjs
import fs from 'node:fs';
import { photoToM } from '../pipeline/pipeline-core.js';

const k = 2000 / 1932;                                     // 화면 축소 배율 → 원본 픽셀
const W = 132, D = 75;
// 2F 틀(원본 px): 서쪽 끝 370, 동쪽 끝 1690, 북쪽 538 ~ 남쪽 1288. 3F는 위로, 1F는 남측 입면이 맞도록 아래로 같은 크기
const frame = top => [[370, top], [1690, top], [1690, top + 750], [370, top + 750]];
const FL = {
  '3F': { crop:[340, 80], corners:frame(93) },
  '2F': { crop:[340, 500], corners:frame(538) },
  '1F': { crop:[340, 1250], corners:frame(954) },
};
const r2 = v => Math.round(v * 20) / 20;
const toM = (fid, pts) => { const f = FL[fid], map = photoToM(f.corners, W, D);
  return pts.map(([cx, cy]) => map(f.crop[0] * k + cx, f.crop[1] * k + cy).map(r2)); };
const pt = (fid, c) => toM(fid, [c])[0];
const rectOp = (fid, a, b, attrs) => { const [p, q] = toM(fid, [a, b]); return { op:'rect', x0:Math.min(p[0], q[0]), y0:Math.min(p[1], q[1]), x1:Math.max(p[0], q[0]), y1:Math.max(p[1], q[1]), ...attrs }; };

// 안내도 범례의 업종 → 용도
const CAT = { bakery:['restaurant', '베이커리', 12], snack:['restaurant', '분식·스낵', 10], cafe:['restaurant', '카페', 16], korean:['restaurant', '한식', 30],
  makgeolli:['restaurant', '막걸리', 20], fast:['restaurant', '패스트푸드', 24], viet:['restaurant', '베트남 음식', 24], food:['restaurant', '식당', 24],
  court:['restaurant', '푸드코트', 120], pharm:['retail', '약국', 6], stat:['retail', '문구·팬시', 8], cvs:['retail', '편의점', 6], beauty:['retail', '뷰티', 8],
  conf:['retail', '제과', 6], flower:['retail', '꽃집', 4], vacant:['retail', '공실(입점 모집)', 0] };
const shop = (fid, no, c, cat) => { const [use, name, capacity] = CAT[cat], [x, y] = pt(fid, c);
  return { op:'label', x, y, type:'room', number:`${fid[0]}${String(no).padStart(2, '0')}`, use, name, capacity }; };

const floors = {
  '3F': { footprint:[[10, 10], [720, 10], [720, 390], [530, 390], [530, 150], [48, 150], [48, 45]],   // 회색 보이드(아래층 대합실 위 뚫림)는 윤곽에서 뺌
    ops:[
      shop('3F', 1, [315, 48], 'court'), shop('3F', 2, [633, 48], 'korean'), shop('3F', 3, [613, 190], 'korean'), shop('3F', 4, [615, 350], 'bakery'),
      { op:'label', ...xy('3F', [250, 115]), type:'corridor', name:'전문식당가 통로' },
      { op:'label', ...xy('3F', [560, 280]), type:'corridor', name:'통로' },
      rectOp('3F', [645, 95], [720, 150], { type:'wc', name:'화장실' }),
    ] },
  '2F': { footprint:[[18, 20], [800, 20], [800, 455], [1338, 455], [1338, 625], [630, 770], [630, 690], [535, 690], [535, 770], [180, 725], [195, 640], [35, 470], [180, 462], [60, 330], [60, 85]],
    ops:[
      ...[[1, [203, 435], 'bakery'], [2, [105, 318], 'snack'], [3, [105, 292], 'cafe'], [5, [82, 122], 'bakery'], [6, [98, 93], 'cafe'],
        [7, [218, 47], 'bakery'], [8, [278, 47], 'stat'], [9, [336, 47], 'cafe'], [10, [410, 47], 'cafe'], [11, [425, 122], 'cvs'], [12, [632, 170], 'snack'],
        [13, [545, 305], 'bakery'], [14, [545, 397], 'beauty'], [15, [427, 557], 'bakery'], [16, [482, 557], 'snack'], [17, [268, 651], 'cvs'], [18, [336, 656], 'conf'],
        [19, [516, 672], 'flower'], [20, [510, 708], 'bakery'], [21, [510, 746], 'snack'], [22, [651, 746], 'snack'], [23, [651, 708], 'korean'], [24, [646, 672], 'makgeolli'],
        [25, [820, 574], 'cafe'], [26, [942, 481], 'snack'], [27, [938, 702], 'cafe'], [28, [1006, 688], 'cvs'], [29, [1070, 675], 'korean'], [30, [1138, 658], 'bakery'], [31, [1208, 645], 'fast']]
        .map(([n, c, cat]) => shop('2F', n, c, cat)).filter(o => o.number !== '201'),
      rectOp('2F', [163, 412], [203, 452], { type:'room', number:'201', use:'restaurant', name:'베이커리', capacity:12 }),     // 사선으로 놓인 좁은 칸
      rectOp('2F', [65, 255], [140, 280], { type:'room', number:'204', use:'retail', name:'약국', capacity:6 }),   // 반사에 묻혀 색이 안 잡힌 칸: 사람이 사각형으로 지정
      { op:'label', ...xy('2F', [632, 350]), type:'room', number:'역무실', use:'admin', name:'역무실', capacity:12 },
      { op:'label', ...xy('2F', [705, 478]), type:'room', number:'매표', use:'admin', name:'매표창구', capacity:10 },
      { op:'label', ...xy('2F', [1072, 476]), type:'room', number:'철도경찰', use:'office', name:'철도경찰서', capacity:8 },
      { op:'label', ...xy('2F', [700, 600]), type:'room', number:'대합실', use:'waiting', name:'맞이방', capacity:600 },
      ...[[[650, 40], [720, 75]], [[650, 125], [720, 165]], [[100, 520], [180, 560]], [[160, 590], [225, 625]], [[1270, 510], [1335, 545]], [[1270, 560], [1335, 595]]]
        .map(([a, b]) => rectOp('2F', a, b, { type:'wc', name:'화장실' })),
    ] },
  '1F': { footprint:[[175, 145], [215, 115], [530, 110], [530, 170], [708, 170], [708, 108], [1110, 108], [1110, 75], [1290, 75], [1290, 45], [1360, 45], [1360, 262],
      [1170, 320], [880, 400], [820, 410], [410, 410], [220, 385], [230, 280], [195, 190]],
    ops:[
      ...[[1, [295, 350], 'vacant'], [2, [452, 377], 'cvs'], [3, [566, 350], 'bakery'], [4, [676, 350], 'stat'], [5, [790, 380], 'snack'], [6, [988, 326], 'fast'],
        [7, [1103, 313], 'cvs'], [8, [1270, 226], 'korean'], [9, [1080, 168], 'makgeolli'], [10, [1022, 148], 'food'], [11, [981, 148], 'viet'], [12, [948, 148], 'bakery'],
        [13, [908, 148], 'korean'], [14, [847, 148], 'korean'], [15, [788, 148], 'korean'], [16, [716, 193], 'bakery']].map(([n, c, cat]) => shop('1F', n, c, cat)),
      rectOp('1F', [435, 208], [545, 240], { type:'store', name:'물품보관함' }),       // 칠하지 않은 회색·파란 상자는 사각형으로 지정
      rectOp('1F', [238, 272], [328, 306], { type:'store', name:'KTX특송' }),
      { op:'label', ...xy('1F', [950, 232]), type:'room', number:'맞이방', use:'waiting', name:'전문식당가 맞이방', capacity:200 },
      ...[[[205, 150], [270, 200]], [[205, 205], [270, 250]], [[1290, 45], [1360, 100]], [[1290, 105], [1360, 160]]].map(([a, b]) => rectOp('1F', a, b, { type:'wc', name:'화장실' })),
    ] },
};
function xy(fid, c){ const [x, y] = pt(fid, c); return { x, y }; }

const recipe = {
  schema:'twin.pipeline/v1', id:'busan-station-2026-11', base:'source/busan-station/',
  building:{ id:'KORAIL-BUSAN', name:'부산역 역사', campus:'부산 동구', size:{ w:W, d:D }, floorHeight:6.5, ceiling:5,
    assumed:['크기 132×75m: 안내도 축척 가정(상점 폭 ≈ 5.5m) — 건축물대장으로 확인 필요', '층고 6.5m: 외부 사진 비율 추정', '층 사이 위치: 안내도에서 층 그림이 같은 축척·같은 남측 입면이라고 가정'] },
  operation:{ source:'역사 운영시간(가정)', weekday:['05:00', '24:00'], weekend:['05:00', '24:00'] },
  floors:['1F', '2F', '3F'].map(id => ({ id, image:'plans/guide-all.png', corners:FL[id].corners, mode:'fill',
    params:{ fill:'#8389a0', strength:.5, minArea:2 }, footprint:toM(id, floors[id].footprint), ops:floors[id].ops })),
  // 외부 사진: 2층 커튼월 — 2층 바닥 슬래브(y=600)와 지붕 슬래브(y=350) 사이 유리 아래·위
  exterior:{ photos:[{ file:'photos/exterior-1.jpg', marks:[{ kind:'slab', y:760 }, { kind:'slab', y:600 }, { kind:'slab', y:350 }, { kind:'sill', y:590 }, { kind:'head', y:362 }] }] },
  interior:[
    { file:'photos/interior-13.png', use:'waiting', floorBox:[750, 1500, 1950, 1950], wallBox:[560, 420, 840, 1150] },        // 화강석 바닥 · 스테인리스 기둥
    { file:'photos/interior-17.png', use:'restaurant', floorBox:[600, 1600, 1500, 1950] },
    { file:'photos/interior-17.png', use:'retail', floorBox:[600, 1600, 1500, 1950] },
  ],
  acPhotos:[],
  // 스카이뷰(지도 항공사진, 북쪽이 위): 방위·건물 모양·축척 확인용 (화면에 사진은 깔지 않음)
  //   안내도는 축척이 정확하지 않은 그림이라 회전·축척·이동만 맞춤(similarity). 남는 오차(약 12m)는 안내도 단순화 때문
  //   기준점: 북동 모서리 · 서측 외벽 남쪽 끝 · 남쪽 끝 동측 · 지도 상점 표시(아메리칸트레일러 203, 써브웨이 231, 카페스토리웨이 227)
  site:{ image:'photos/skyview.png', size:[799, 1150], mode:'similarity',
    ref:[{ m:[0, 0], px:[750, 140] }, { m:[132, 60.45], px:[169, 1042] }, { m:[132, 43.45], px:[300, 1040] },
      { m:[6.5, 27.1], px:[411, 298] }, { m:[120.6, 61], px:[242, 915] }, { m:[91.6, 66.9], px:[264, 682] }],
    // 모양 검증용: 스카이뷰에서 역사 지붕 윤곽을 따라 찍은 점 (선로 위 승강장 지붕·광장 캐노피 제외)
    outline:[[430, 75], [525, 178], [760, 125], [715, 262], [640, 300], [640, 550], [540, 555], [540, 700], [505, 710], [490, 1030], [160, 1048], [163, 900], [175, 700], [215, 520], [280, 330], [350, 180]] },
  // 에어컨 위치 예측 모델 자리 (아직 없음). 생기면 결과 파일을 여기에 적는다: { name, file:'ac-model.json', minConfidence:.5 }
};
fs.writeFileSync(new URL('../source/busan-station/recipe.json', import.meta.url), JSON.stringify(recipe, null, 1));
console.log(recipe.floors.map(f => `${f.id} ops=${f.ops.length} footprint=${f.footprint.length}점`).join(' | '));
