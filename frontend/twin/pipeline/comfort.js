// 실내 열쾌적도: ISO 7730 PMV/PPD (Fanger 열수지 모델). 트윈 실시간 화면 · 명령줄 공용
//   EnergyPlus 시뮬레이션(Zone Thermal Comfort Fanger Model)과 같은 모델이라 실시간 값과 시뮬레이션 결과를 같은 척도로 비교할 수 있음
//
//   PMV  −3 춥다 · −2 서늘 · −1 약간 서늘 · 0 중립 · +1 약간 따뜻 · +2 따뜻 · +3 덥다
//   PPD  그 조건에서 불만족할 것으로 예상되는 사람 비율 (%), PMV 0일 때 최소 5%
//   ISO 7730 등급: A |PMV|<0.2 (PPD<6%) · B <0.5 (<10%) · C <0.7 (<15%)
//
// 입력 중 재지 않는 값은 가정 (화면에 함께 표시):
//   복사온도 = 실내 온도 (벽·창 표면온도 측정 없음) · 기류 = 운전 중 0.15 m/s, 정지 0.1 m/s
//   옷 = 계절별 (6~9월 0.5clo 여름 옷, 5·10월 0.7, 11~4월 1.0 겨울 옷) · 활동량 = 실 용도별 (아래 MET)
export const MET = { lecture:1.1, meeting:1.1, office:1.1, admin:1.1, lab:1.4, lounge:1.2, waiting:1.4, restaurant:1.4, retail:1.6, none:1.2 };
export const MET_LABEL = { 1.1:'앉아서 수업·사무', 1.2:'앉아 쉬기', 1.4:'서서 가벼운 일', 1.6:'서서 움직임' };
export const cloOf = month => (month >= 6 && month <= 9 ? 0.5 : month === 5 || month === 10 ? 0.7 : 1.0);
export const GRADE = [[0.2, 'A'], [0.5, 'B'], [0.7, 'C']];

// ISO 7730:2005 부록 D 계산 절차 (ta 기온 °C, tr 평균복사온도 °C, vel 기류 m/s, rh 상대습도 %, met, clo)
export function pmvPpd(ta, tr, vel, rh, met, clo, wme = 0){
  if (![ta, tr, vel, rh, met, clo].every(Number.isFinite)) return null;
  const pa = rh * 10 * Math.exp(16.6536 - 4030.183 / (ta + 235));          // 수증기 분압 Pa
  const icl = 0.155 * clo, m = met * 58.15, w = wme * 58.15, mw = m - w;
  const fcl = icl <= 0.078 ? 1 + 1.29 * icl : 1.05 + 0.645 * icl;          // 옷 면적 계수
  const hcf = 12.1 * Math.sqrt(vel), taa = ta + 273, tra = tr + 273;
  const tcla = taa + (35.5 - ta) / (3.5 * icl + 0.1);
  const p1 = icl * fcl, p2 = p1 * 3.96, p3 = p1 * 100, p4 = p1 * taa, p5 = 308.7 - 0.028 * mw + p2 * (tra / 100) ** 4;
  let xn = tcla / 100, xf = tcla / 50, hc = hcf, n = 0;
  while (Math.abs(xn - xf) > 0.00015) {                                     // 옷 표면온도 반복 계산
    xf = (xf + xn) / 2;
    const hcn = 2.38 * Math.abs(100 * xf - taa) ** 0.25; hc = Math.max(hcf, hcn);
    xn = (p5 + p4 * hc - p2 * xf ** 4) / (100 + p3 * hc);
    if (++n > 150) return null;
  }
  const tcl = 100 * xn - 273;
  const hl1 = 3.05e-3 * (5733 - 6.99 * mw - pa);                            // 피부 수분 확산
  const hl2 = mw > 58.15 ? 0.42 * (mw - 58.15) : 0;                         // 땀 증발
  const hl3 = 1.7e-5 * m * (5867 - pa);                                     // 호흡 잠열
  const hl4 = 0.0014 * m * (34 - ta);                                       // 호흡 현열
  const hl5 = 3.96 * fcl * (xn ** 4 - (tra / 100) ** 4);                    // 복사
  const hl6 = fcl * hc * (tcl - ta);                                        // 대류
  const ts = 0.303 * Math.exp(-0.036 * m) + 0.028;
  const pmv = ts * (mw - hl1 - hl2 - hl3 - hl4 - hl5 - hl6);
  const ppd = 100 - 95 * Math.exp(-0.03353 * pmv ** 4 - 0.2179 * pmv ** 2);
  return { pmv:Math.round(pmv * 100) / 100, ppd:Math.round(ppd * 10) / 10 };
}

export const pmvLabel = v => v == null ? '–' : v <= -2.5 ? '춥다' : v <= -1.5 ? '서늘' : v <= -0.5 ? '약간 서늘' : v < 0.5 ? '쾌적' : v < 1.5 ? '약간 따뜻' : v < 2.5 ? '따뜻' : '덥다';
export const gradeOf = v => v == null ? null : (GRADE.find(([k]) => Math.abs(v) < k)?.[1] || '등급 밖');

// 방 하나: { temp, hum, kind, on } + 날짜(월) → { pmv, ppd, met, clo, vel, grade }
export function roomComfort({ temp, hum, kind, on }, month){
  const met = MET[kind] ?? 1.2, clo = cloOf(month), vel = on ? 0.15 : 0.1;
  const r = pmvPpd(temp, temp, vel, hum ?? 50, met, clo);
  return r && { ...r, met, clo, vel, grade:gradeOf(r.pmv) };
}
