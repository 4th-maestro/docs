/* 실내기 유형(cls)별 3D 형상: digital-twin.html 방 화면(buildRoom)에서 사용
   규약: docs/human/reference/plan-ingest.md 3절(cls, rot, size)
   - cls가 없는 기존 데이터는 null을 반환하고, digital-twin.html의 기존 카세트 코드(type 문자열의 1WAY, 4WAY)를 그대로 사용
   - 미확인(unknown)은 천장형 4방향 카세트 형상으로 표시
   - rot: 평면 기준 토출 방향(도). 0은 x+(평면 오른쪽), 90은 y+(평면 아래쪽). 값이 없으면 실 중심 쪽(긴 변 방향)
   - 반환 필드(vanes, slotMat, ledMat, halo, light, dirs, off, wp)는 기존 카세트 객체와 같아 바람, 상태 표시 코드를 공유 */
const WAYS = { cassette_4way:4, cassette_2way:2, cassette_1way:1, unknown:4 };

// 실내기 목록(acs) 표시 필드: 유형 이름과 모델을 함께 표시, 토출 방향 수
export function iduFields(a){
  if (!a.cls) return { ways:/1\s*WAY/i.test((a.type || '') + (a.model || '')) ? 1 : 4 };
  return { cls:a.cls, rot:a.rot, size:a.size, ways:WAYS[a.cls] || 1, model:[a.type, a.model].filter(Boolean).join(' · ') || '실내기' };
}

// a: acs 항목(x, y, cls, rot, size), at: 평면 → 월드 좌표 함수, ceil: 천장고(m), room: 실 경계 상자 {w, h, cx, cy}, mat: 본체 재질
export function iduShape(THREE, a, { at, ceil, room, mat }){
  if (!a.cls) return null;
  const ways = WAYS[a.cls] || 0;
  const deg = Number.isFinite(a.rot) ? a.rot * Math.PI / 180
    : room.w >= room.h ? (room.cx >= a.x ? 0 : Math.PI) : (room.cy >= a.y ? Math.PI / 2 : -Math.PI / 2);
  const ux = Math.cos(deg), uz = Math.sin(deg);
  // size [w, d]: 평면 x, y 방향 길이 → 로컬 [토출 방향 깊이, 폭]
  const dims = def => !a.size ? def : Math.abs(uz) > Math.abs(ux) ? [a.size[1], a.size[0]] : a.size;
  const box = (w, h, d, m = mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  const g = new THREE.Group(); g.rotation.y = Math.atan2(-uz, ux);    // 로컬 x+ = 토출 방향
  const dark = new THREE.MeshStandardMaterial({ color:0x8a929c, roughness:.8 });
  const vaneMat = new THREE.MeshStandardMaterial({ color:0xeef1f5, roughness:.35 });
  const slotMat = new THREE.MeshBasicMaterial({ color:0x8fe6ff, transparent:true, opacity:0 });
  const vanes = [];
  // 토출구: 로컬 방향 (lx, lz), 중심에서 off, 높이 y, 길이 len. 베인은 기존 카세트와 같은 회전축
  const outlet = (lx, lz, off, y, len) => {
    const pivot = new THREE.Group(); pivot.position.set(lx * off, y, lz * off); pivot.rotation.y = Math.atan2(-lz, lx);
    const slot = box(.06, .004, len, slotMat); slot.position.y = .006; pivot.add(slot);
    const vane = box(.075, .012, len, vaneMat); vane.geometry.translate(.035, 0, 0); pivot.add(vane);
    g.add(pivot); vanes.push(vane);
  };
  let local = [[1, 0]], off, y, ledAt;
  if (ways) {                          // 천장형 카세트: 천장면에 붙은 패널, 방향 수만큼 토출구
    const [dx, dz] = dims(ways === 4 ? [.95, .95] : ways === 2 ? [.6, 1.2] : [.5, 1.1]);
    y = ceil - .12;
    g.add(box(dx - .12, .2, dz - .12));
    const panel = box(dx, .03, dz); panel.position.y = -.115; g.add(panel);
    const grille = box(Math.min(.46, dx * .5), .008, Math.min(.46, dz * .5), dark); grille.position.y = -.132; g.add(grille);
    local = ways === 4 ? [[1, 0], [0, 1], [-1, 0], [0, -1]] : ways === 2 ? [[1, 0], [-1, 0]] : [[1, 0]];
    off = ways === 4 ? dx / 2 - .12 : dx / 2 - .08;
    for (const [lx, lz] of local) outlet(lx, lz, off, -.135, ways === 4 ? dx * .63 : dz * .8);
    ledAt = [0, -.137, 0];
  } else if (a.cls === 'ceiling_duct') {   // 천장 매립 덕트: 천장 위 본체, 천장면에 공급구와 흡입구 격자
    const [dx, dz] = dims([.8, 1]);
    y = ceil;
    const body = box(dx, .3, dz); body.position.y = .17; g.add(body);
    const supply = box(.14, .02, dz * .9, dark); supply.position.set(dx / 2 - .1, -.01, 0); g.add(supply);
    const ret = box(dx * .45, .02, dz * .6, dark); ret.position.set(-dx / 4, -.01, 0); g.add(ret);
    for (let i = -2; i <= 2; i++) { const slat = box(dx * .45, .012, .02, mat); slat.position.set(-dx / 4, -.022, i * dz * .12); g.add(slat); }
    off = dx / 2 - .1; outlet(1, 0, off, -.025, dz * .85);
    ledAt = [0, -.025, dz * .4];
  } else if (a.cls === 'wall_mounted') {   // 벽걸이: 벽면 2.2m, 앞면 아래쪽 토출구
    const [dx, dz] = dims([.25, .9]);
    y = Math.min(2.2, ceil - .25);
    g.add(box(dx, .3, dz));
    off = dx / 2 - .03; outlet(1, 0, off, -.15, dz * .85);
    ledAt = [dx / 2 + .002, .05, dz * .35];
  } else {                                 // 스탠드형(floor_standing): 바닥에 선 본체, 위쪽 앞면 토출구
    const [dx, dz] = dims([.3, .5]);
    y = 1.6;
    const body = box(dx, 1.8, dz); body.position.y = -.7; g.add(body);
    const grille = box(.01, .25, dz * .8, dark); grille.position.set(dx / 2 + .005, .05, 0); g.add(grille);
    off = dx / 2; outlet(1, 0, off, -.08, dz * .8);
    ledAt = [dx / 2 + .002, -.3, 0];
  }
  g.position.copy(at(a.x, a.y, y));
  const ledMat = new THREE.MeshStandardMaterial({ color:0x22b07d, emissive:0x22b07d, emissiveIntensity:2.5 });
  const led = new THREE.Mesh(new THREE.CircleGeometry(.05, 16), ledMat); led.position.set(...ledAt);
  if (ways || a.cls === 'ceiling_duct') led.rotation.x = Math.PI / 2; else led.rotation.y = Math.PI / 2;
  g.add(led);
  const halo = new THREE.Mesh(new THREE.RingGeometry(.62, .78, 40), new THREE.MeshBasicMaterial({ color:0x9b7bff, transparent:true, opacity:0, side:THREE.DoubleSide, depthWrite:false }));
  halo.rotation.x = -Math.PI / 2; halo.position.y = -.14; g.add(halo);
  const light = new THREE.PointLight(0x7cc8ff, 0, 4); light.position.y = -.5; g.add(light);
  // 로컬 방향 → 평면 방향(바람 경로 계산용 [x, z])
  const dirs = local.map(([lx, lz]) => [lx * ux - lz * uz, lx * uz + lz * ux]);
  return { g, ways:ways || 1, dirs, off, vanes, slotMat, ledMat, halo, light, wp:g.position.clone() };
}

// 층별 평면도(SVG)의 유형별 2D 기호. 모양은 2D 매핑 화면(src/ingest/UnitSymbol.tsx)과 같음, 오른쪽(x+)이 토출 방향
// 본체 색은 g의 fill(가동 상태 색)을 상속, 선은 #plan .idu의 stroke(바탕색)
const MARK = {
  cassette_4way: 'M.55 -.6V.6M-.55 -.6V.6M-.6 .55H.6M-.6 -.55H.6',
  cassette_2way: 'M.55 -.6V.6M-.55 -.6V.6',
  cassette_1way: 'M.55 -.6V.6',
  ceiling_duct: 'M-.6 -.45H.3M-.6 0H.3M-.6 .45H.3M.6 -.7V.7',
  wall_mounted: 'M.15 -.8V.8',
};
// 범례 이름: src/ingest/hvac-types.json(원본 ml/hvac_types.json)의 name과 같음
export const IDU_NAME = { cassette_4way:'천장형 4방향 카세트', cassette_2way:'천장형 2방향 카세트', cassette_1way:'천장형 1방향 카세트',
  ceiling_duct:'천장 매립 덕트형', wall_mounted:'벽걸이형', floor_standing:'스탠드형' };
export function iduSymbolSvg(a, x, y, s = 10){
  // vector-effect는 상속되지 않아 요소마다 지정(없으면 선 두께가 s배로 커져 기호를 덮음)
  const v = 'vector-effect="non-scaling-stroke"', mk = `fill="none" ${v}`;
  const body = a.cls === 'wall_mounted' ? `<rect x="-.35" y="-1" width=".7" height="2" rx=".1" ${v}/>` : `<rect x="-1" y="-1" width="2" height="2" rx=".15" ${v}/>`;
  const mark = MARK[a.cls] ? `<path d="${MARK[a.cls]}" ${mk}/>` : a.cls === 'floor_standing' ? `<circle r=".45" ${mk}/>` : '';
  const rot = Number.isFinite(a.rot) ? a.rot : 0;
  return `<g class="idu" data-a="${a.id ?? ''}" transform="translate(${x} ${y}) rotate(${rot}) scale(${s})" stroke-width="2">${body}${mark}</g>`;
}

