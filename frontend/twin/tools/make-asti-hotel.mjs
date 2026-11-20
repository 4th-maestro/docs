import fs from 'node:fs';
import { assemble } from '../pipeline/pipeline-core.js';

// Photo traces in local metres. The plan photos have no scale bar.
const podium = [[0,0],[44,0],[46,6],[46,11],[48,14],[46,18],[46,23],[43,28],[0,28],[0,19],[1,14],[0,9]];
const tower = [[2,1],[43,1],[44.5,2.5],[44.5,25.5],[43,27],[2,27],[2,19],[0,14],[2,10]];
const rect = (x0,y0,x1,y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const room = (key,name,use,capacity,polygon) => ({ key,name,type:'room',use,capacity,polygon });
const space = (key,name,type,polygon) => ({ key,name,type,polygon });
const repeat = [
  ...[1, 2].flatMap(row => {
    const edges = row === 1 ? [2,6,9.7,13.5,17.2,20.8,24.4,28,31.6,35.2,39.6,44.5]
      : [2,6,9.8,13.4,17,20.6,24.2,27.8,31.4,35,39.5,44.5];
    return edges.slice(0,-1).map((x,i) => {
      const roof = (x,y) => (x === 44.5 && (y === 1 || y === 27)) ? 43 : x;
      const next = edges[i+1], top = row === 1 ? 1 : 20.1, bottom = row === 1 ? 8 : 27;
      const poly = [[roof(x,top),top],[roof(next,top),top],...(next === 44.5 ? [[next,row === 1 ? 2.5 : 25.5]] : []),
        [roof(next,bottom),bottom],[roof(x,bottom),bottom]];
      return room('guest-' + row + '-' + (i+1),'객실 ' + (row === 1 ? 'A' : 'B') + (i+1),'guestroom',2,poly);
    });
  }),
  room('guest-c1','객실 C1','guestroom',3,[[2,10],[13.8,10],[13.8,14],[0,14]]),
  room('guest-c2','객실 C2','guestroom',3,[[0,14],[13.8,14],[13.8,18],[1.6,18]]),
  space('upper-corridor','객실 복도','corridor',rect(2,8,44.5,10)),
  space('lower-corridor','객실 복도','corridor',rect(2,18.4,44.5,20.1)),
  space('cross-corridor','승강기 홀','corridor',rect(29.5,10,33.4,18.4)),
  space('core-a','계단·승강기 코어','core',rect(13.8,10,29.5,18.4)),
  space('core-b','계단·승강기 코어','core',rect(33.4,10,44.5,18.4)),
];
const coreA = space('core-a','계단·승강기 코어','core',rect(6,10,17,18));
const coreB = space('core-b','계단·승강기 코어','core',rect(21,10,33,18));
const documented = {
  1: { note:'105~108호가 표시된 안내도 기준. 상가 배치와 치수 근사.', zones:[
    room('105','105호 상가','retail',30,rect(1,1,25,10)),
    room('106','106호 상가','retail',20,[[25,1],[43,1],[45,6],[46,8],[40,10],[25,10]]),
    room('107','107호 상가','retail',20,[[25,21],[40,21],[37,27],[25,27]]),
    room('108','108호 상가','retail',20,[[12,23],[14,21],[25,21],[25,27],[12,27]]),
    coreA,coreB,space('walk','공용 복도','corridor',rect(3,18,39,21)),
  ]},
  2: { note:'부분 도면 기준. 구역 간 상대 위치는 임시 배치이며 나머지 평면은 미확인.', zones:[
    room('restaurant','영동밀면 식당 구역','restaurant',22,[[24,3],[40,3],[43,8],[41,13],[33,15],[33,10],[24,10]]),
    space('partial-hall','안내도에 나온 공용 구역','corridor',[[3,4],[22,4],[22,9],[11,9],[11,12],[3,11]]),
  ]},
  3: { note:'메인 로비·갤러리 안내도 기준. 치수 근사.', zones:[
    room('lobby','메인 로비','lounge',40,rect(7,1,45,9)),
    room('lounge','로비 라운지','lounge',20,[[36,9],[46,9],[46,11],[48,14],[46,17],[36,17]]),
    room('reservation','연회 예약실','admin',12,rect(14,21,25,27)),
    room('gallery','다목적 갤러리','meeting',40,rect(27,20,45,27)),
    coreA,coreB,space('escalator','에스컬레이터 홀','corridor',rect(1,2,6,25)),
    space('walk','공용 복도','corridor',rect(6,18,33,20)),
  ]},
  4: { note:'피트니스 센터가 있는 층. 상세 평면은 미확인으로 윤곽만 표시.', zones:[] },
  21: { note:'레스토랑·주방 안내도 기준. 치수와 공조 구성은 추정.', zones:[
    room('restaurant','레스토랑','restaurant',128,[[2,1],[43,1],[44.5,2.5],[44.5,25.5],[43,27],[33,27],[33,18],[36,18],[36,9],[2,9]]),
    room('kitchen','주방','restaurant',12,rect(2,20,33,27)),
    coreA,coreB,space('walk','공용 복도','corridor',rect(2,18,33,20)),
  ]},
  22: { note:'부대시설 창고·사무실 안내도 기준. 치수 근사.', zones:[
    room('office','호텔 사무실','admin',12,rect(24,19,40,26)),
    space('storage','호텔 창고','store',rect(3,16,10,26)),
    space('wc','화장실','wc',rect(11,20,23,26)),
    space('upper-core','계단·승강기 코어','core',rect(3,3,39,13)),
    space('walk','공용 복도','corridor',rect(10,13,40,16)),
  ]},
  23: { note:'23층 높이와 외곽만 표시. 상세 평면은 미확인.', zones:[] },
  24: { note:'24층 안내도 기준. 공용 구역 용도·설비 미확인.', zones:[
    space('upper','북측 공용 구역','corridor',rect(3,2,41,9)),
    space('lower','남측 공용 구역','corridor',rect(10,18,41,26)),
    space('cross','승강기 홀','corridor',rect(16,9,19,18)),
    coreA,coreB,space('wc','화장실','wc',rect(3,20,9,26)),
  ]},
};
const floors = Array.from({length:24},(_,i) => {
  const n = i + 1, id = n + 'F', isGuestFloor = n >= 5 && n <= 20;
  const { note,zones } = isGuestFloor ? {note:'5~20층 공통 객실 평면. A·B·C는 모델 구역 번호.',zones:repeat} : documented[n];
  return { id, note, footprint:n <= 4 ? podium : tower,
    zones:zones.map(({key,...zone}) => ({ ...zone, id:id+'-'+key })) };
});
const recipe = {
  id:'asti-hotel-busan-photo-trace',
  building:{ id:'ASTI-BUSAN', name:'부산 아스티 호텔', size:{w:48,d:28},
    floorHeight:3.35, ceiling:2.65, assumed:[
      '첨부 안내도, 전면 및 상공 사진을 바탕으로 수동 트레이스. 호텔 타워만 모델링.',
      '48×28m 및 층고 3.35m는 축척이 없는 사진을 모델에 맞춘 가정값.',
      '운전 데이터, 냉방 용량과 실내외기 연결은 모두 데모 추정값.',
    ] },
  floors,
  exterior:{ window:{sill:.35,head:2.55,n:1}, facade:{glassColor:'#4b9caa', mullionColor:'#a9c2cf', glassOpacity:.19} },
  interior:[{use:'guestroom',floor:'#766e6b',wall:'#c2b49d'}],
  operation:{source:'호텔 데모 운전 시간 가정',weekday:['00:00','24:00'],weekend:['00:00','24:00'],coolSetpoint:25},
  zoning:{enabled:false},
};
const floorResults = Object.fromEntries(floors.map(f => [f.id,{rooms:f.zones,meta:{},warn:[]}]));
const {json} = assemble(recipe,floorResults);
for (const [i,f] of json.floors.entries()) f.note = floors[i].note;
json.source = '첨부한 아스티호텔 안내도, 전면 사진, 상공 사진을 바탕으로 수동 작성';
const output = new URL('../data/asti-hotel-busan/building.json',import.meta.url);
fs.mkdirSync(new URL('.',output),{recursive:true});
fs.writeFileSync(output,JSON.stringify(json,null,1)+'\n');
console.log('아스티 호텔: ' + json.floors.length + '개 층 · ' + json.idus.length + '개 추정 실내기');
