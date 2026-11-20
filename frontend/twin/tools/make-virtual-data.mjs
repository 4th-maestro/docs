// Generates the virtual (stand-in) data files in the same shape the real sources would deliver.
//   data/schedule.json     학사 시간표 (공공: 부산대 수강편람)
//   data/weather.json      기상청 단기예보 (공공: 공공데이터포털 getVilageFcst 응답 형식)
//   data/tariff.json       한전 전기요금표 (공공)
//   data/maintenance.json  유지보수 이력 (회사 내부: 서비스 이력)
// Run:  node tools/make-virtual-data.mjs [데이터 폴더=data/]   (폴더 안의 building.json을 읽어 같은 폴더에 씀)
import fs from 'node:fs';
const DIR = new URL('../' + (process.argv[2] || 'data/').split('\\').join('/').replace(/\/?$/, '/'), import.meta.url);
const B = JSON.parse(fs.readFileSync(new URL('building.json', DIR), 'utf8'));
const CAMPUS = /대학|공학관/.test(B.building.name + B.building.campus);     // 학교 건물이면 학사 시간표, 아니면 운영시간 기반
const LOC = CAMPUS ? { name:'부산 금정구 장전동', nx:98, ny:76 } : { name:'부산 동구 초량동', nx:98, ny:75 };
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };
const write = (name, obj) => fs.writeFileSync(new URL(name, DIR), JSON.stringify(obj, null, 1));
const DATE = '2026-06-10';            // 시나리오 기준일 (수요일, 1학기 기말 전)

/* ── 학사 시간표 ── */
const SLOTS = [['09:00', '10:15'], ['10:30', '11:45'], ['12:00', '13:15'], ['13:30', '14:45'], ['15:00', '16:15'], ['16:30', '17:45']];
const DAYS = ['월', '화', '수', '목', '금'];
const COURSES = ['자료구조', '알고리즘', '운영체제', '컴퓨터구조', '데이터베이스', '컴퓨터네트워크', '회로이론', '전자회로', '신호및시스템', '디지털논리회로',
  '공학수학', '확률및통계', '기계학습', '임베디드시스템', '소프트웨어공학', '캡스톤디자인', '프로그래밍기초', '객체지향프로그래밍', '전자기학', '반도체공학'];
const NO_CLASS = { '5F-6503': d => d === '수', '3F-6308-1': d => d === '수' };   // 시나리오: 수업 없는데 냉방이 켜질 방
const classes = [];
for (const f of B.floors) for (const r of f.rooms) {
  if (r.use !== 'lecture' && r.use !== 'lab') continue;
  for (const d of DAYS) SLOTS.forEach(([s, e], i) => {
    if (NO_CLASS[r.id]?.(d) && i >= 2) return;
    const p = (r.use === 'lecture' ? .62 : .45) * (i === 2 ? .55 : 1);
    if (hash(`${r.id}|${d}|${i}`) > p) return;
    const course = COURSES[Math.floor(hash(`${r.id}|${d}|${i}|c`) * COURSES.length)];
    classes.push({ room: r.id, day: d, start: s, end: e, course, code: `CSE${Math.floor(1000 + hash(course) * 8999)}`, enrolled: Math.min(r.capacity, Math.round(r.capacity * (.55 + .4 * hash(`${r.id}|${d}|${i}|n`)))) });
  });
}
write('schedule.json', CAMPUS ? { schema: 'twin.schedule/v1', source: '부산대학교 학사 시간표 (수강편람 공개 정보) 형식 — 가상 생성', term: '2026-1', classes }
  : { schema: 'twin.schedule/v1', source: '해당 없음 — 강의실이 없는 건물은 용도별 운영 패턴으로 재실을 판단', term: '-', classes: [] });

/* ── 기상청 단기예보 (부산 금정구 장전동 nx=98, ny=76) ── */
const items = [];
for (let h = 0; h < 24; h++) {
  const k = (1 - Math.cos(((h - 5 + 24) % 24) / 24 * 2 * Math.PI)) / 2;     // 05시 최저 → 17시 최고
  const tmp = +(20.6 + 7.4 * Math.pow(k, 1.15)).toFixed(1), reh = Math.round(86 - 28 * k);
  const t = String(h).padStart(2, '0') + '00', base = { baseDate: DATE.replaceAll('-', ''), baseTime: '0500', fcstDate: DATE.replaceAll('-', ''), fcstTime: t, nx: LOC.nx, ny: LOC.ny };
  items.push({ ...base, category: 'TMP', fcstValue: String(tmp) }, { ...base, category: 'REH', fcstValue: String(reh) },
    { ...base, category: 'SKY', fcstValue: h >= 10 && h <= 16 ? '1' : '3' }, { ...base, category: 'PTY', fcstValue: '0' });
}
write('weather.json', { schema: 'kma.getVilageFcst', source: '기상청 단기예보 조회서비스 응답 형식 — 가상 값', location: LOC.name,
  response: { header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' }, body: { dataType: 'JSON', items: { item: items } } } });

/* ── 한전 요금 ── */
// 일반용(을) 고압A 선택Ⅱ 계시별 전력량요금 (한전 전기요금표, 적용일 2023-11-09 — 최신 단가는 한전에서 확인). 기본요금(8,320원/kW)·부가세·기금은 절감 비교에서 제외
const TOU = { source:'한전 전기요금표 일반용(을) 고압A 선택Ⅱ (https://cyber.kepco.co.kr/ckepco/front/jsp/CY/E/E/CYEEHP00102.jsp)',
  seasons:[{ name:'여름', months:[6, 7, 8], price:{ off:87.3, mid:140.2, peak:222.3 } }, { name:'봄·가을', months:[3, 4, 5, 9, 10], price:{ off:87.3, mid:109.8, peak:140.5 } },
    { name:'겨울', months:[11, 12, 1, 2], bands:'winter', price:{ off:94.3, mid:140.4, peak:197.9 } }],
  bands:{ default:[{ band:'peak', hours:[[11, 12], [13, 18]] }, { band:'mid', hours:[[8, 11], [12, 13], [18, 22]] }],
    winter:[{ band:'peak', hours:[[10, 12], [17, 20], [22, 23]] }, { band:'mid', hours:[[8, 10], [12, 17], [20, 22]] }] } };
write('tariff.json', CAMPUS ? { schema: 'twin.tariff/v1', source: '한전 전기요금표 교육용(갑) 기준 단순화', wonPerKwh: 130, note: '계절·시간대·기본요금 미반영 평균 단가 가정' }
  : { schema: 'twin.tariff/v1', source: '한전 전기요금표 일반용(을) 고압A 선택Ⅱ', wonPerKwh: 150, note: '화면의 시간당 요금은 평균 단가, 시뮬레이션 절감액은 계시별 단가(tou)로 계산', tou: TOU });

/* ── 유지보수 이력 ── */
const maint = {};
for (const a of B.idus) {
  const h = hash(a.id + ':rh'), filterHours = Math.round(200 + 2700 * Math.pow(h, 1.6));
  const runHours = Math.round(14000 + hash(a.id + ':run') * 16000);
  const daysAgo = Math.round(filterHours / 9);
  const last = new Date(Date.parse(DATE) - daysAgo * 864e5).toISOString().slice(0, 10);
  const faults = hash(a.id + ':f') > .86 ? [{ date: `2025-0${7 + Math.floor(hash(a.id + ':fm') * 3)}-1${Math.floor(hash(a.id + ':fd') * 9)}`, code: ['CH05', 'CH01', 'CH04'][Math.floor(hash(a.id + ':fc') * 3)], action: '현장 조치 완료' }] : [];
  maint[a.id] = { installed: '2016-08', runHours, filterHours, lastFilterClean: last, faults };
}
write('maintenance.json', { schema: 'twin.maintenance/v1', source: '설비 유지보수·서비스 이력 (회사 내부) 형식 — 가상 값', filterLimitHours: 2500, idus: maint });
console.log('classes', classes.length, 'weather items', items.length, 'idus', Object.keys(maint).length);
