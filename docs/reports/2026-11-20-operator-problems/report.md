---
title: 건물 운영자 문제 전수조사
subtitle: 2026년 11월
org: Maestro 팀
code: 해커톤 조사 보고서
layout: compact
---

<style>
@font-face { font-family: 'Pre'; src: url("../fonts/Pretendard-Regular.ttf"); font-weight: 400; }
@font-face { font-family: 'Pre'; src: url("../fonts/Pretendard-Bold.ttf"); font-weight: 700; }
@font-face { font-family: 'Myeongjo'; src: url("../fonts/NanumMyeongjo-Regular.ttf"); }
:root { --sans: 'Pre', sans-serif; --serif: 'Myeongjo', 'Pre', serif; }
strong, .conclusion { font-family: var(--sans); }
@page { @bottom-right { font-family: 'Pre', sans-serif; } }
@page :left { @bottom-left { font-family: 'Pre', sans-serif; } }
p.key { margin-bottom: 1.2mm; }
.fig:only-child:has(img) { flex-basis: 100%; }
.fig img { border: 0.5pt solid #C5CCDA; }
</style>

# 조사의 핵심 전제 {.front}

- **[조사 범위]**

  2026-11-20에 에이전트 4개가 국내 자료, 해외 업계 설문, 정성 연구, 정량 연구를 조사했습니다. 자료 155건을 검토해 99건을 수록했습니다.

⇒ 주 작업자가 핵심 문장 35건을 원문과 대조했고, 25건은 원문 강조 캡처로 첨부했습니다.

- **[운영자 정의]**

  시설관리자(FM), 건물 운영·설비 엔지니어, 관리사무소장, 학교·공공기관 시설 담당자입니다.

⇒ 정비 기술자의 문제는 2026-11-19 정비 문제 배경 조사에서 다뤘습니다.

- **[수치 출처]**

  해외 업계 설문 27건 중 19건은 판매 기업 조사입니다.

⇒ 판매 기업 수치는 그림과 표의 자료 표기에 함께 표시했습니다.

# 요약 {.front}

::: summary
- 운영자는 공간·설비 상태를 BMS보다 재실자 민원으로 파악합니다.
  - 독일 운영자 인터뷰에서 재실자 피드백 언급은 BMS 데이터 언급의 2배였습니다. 온도는 FM 설문 3건에서 모두 불만 1위입니다.
- 상태 파악이 어려운 원인은 데이터 분산, 쓰기 어려운 도구와 과다 경보, 낭비 위치 미파악, 인력·숙련 부족 4가지입니다.
  - 국내 학교 43곳 중 BEMS 기능을 잘 활용한다는 응답은 32%이고, 현장 5곳 중 4곳은 BEMS를 사용하지 않았습니다.
- 운영자 요구는 통합 화면, 고장 조회와 일괄 on/off, 재실 확인, 민원 위치 기록입니다.
  - 3D 화면과 자연어 질의를 직접 요구한 조사는 없습니다. 모니터링 용도는 2D가 3D보다 빠르다는 평가가 있습니다.

| 항목 | 값 | 비교 기준 |
|---|---|---|
| 온도가 최대 민원이라는 FM 응답 | 68% | 화장실 10%, 주차 5% |
| 온도 민원 1건 대응 시간 | 더움 1.6시간, 추움 2.1시간 | 인건비 35달러/시간 기준 비용 환산 |
| BEMS 기능을 잘 활용하는 학교 | 32% | BEMS 인지 81% |
| 건물 시스템을 완전히 통합한 조직 | 10% | 3,445명, 25개국(판매 기업 조사) |
| 예약 시간 중 빈 회의실 | 31.2% | 실제 사용 68.8% |
:::

# 운영자 문제

## 문제 지도

**수록 자료 99건을 문제 유형 9개로 분류하면 인력 부족이 48건으로 가장 많습니다.**

파란 막대는 과제 문제 정의인 상태 파악과 직접 연결되는 유형입니다.

::: figure 문제 유형별 근거 자료 수 | 인력 48건, 예산·보고 33건, 온도 민원 28건 순
image: ../../human/explanation/research/img/d-o-freq.png
자료: 이 보고서의 수록 자료 99건 분류
:::

<div></div>

**과제 문제 정의인 상태 파악 어려움은 원인 4가지의 결과입니다.**

운영자는 현재 민원 접수, BMS 확인, 현장 확인 순서의 수작업 경로로 상태를 파악합니다.

::: figure 운영자의 상태 파악 경로와 원인 4가지 | 민원이 상태 파악의 주된 경로
image: ../../human/explanation/research/img/d-o-cause.png
자료: B3, B2, D2, C3, B13, A1, A21, A7
:::

## 상태 파악 경로

**운영자 인터뷰 연구에서 운영자는 문제 위치를 주로 재실자 알림으로 파악했습니다.**

Annex 79의 7개국 운영자 72명 인터뷰에서 일부 운영자는 재실자가 알리기 전까지 문제 위치를 알기 어렵다고 답했습니다.

::: figure C3 논문 원문 | 재실자가 알리기 전까지 문제 위치 파악 어려움
image: ../../human/explanation/research/img/o-c3-where.png
자료: Ruiz 외, Energy Research & Social Science(2022)
:::

<div></div>

::: figure C2 논문 원문 | 재실자 피드백 언급이 BMS 데이터의 2배
image: ../../human/explanation/research/img/o-c2-feedback.png
자료: Hahn 외, Frontiers in Built Environment(2022), 독일 운영자 10명
:::

<div></div>

::: figure C6 보고서 원문 | BMS 화면이 정상이면 민원 종결
image: ../../human/explanation/research/img/o-c6-green.png
자료: Moezzi 외, CARB 최종 보고서(2014)
:::

**온도 민원은 운영자 업무에서 가장 큰 비중을 차지합니다.**

::: table 온도 민원 관련 조사 결과
| 조사 | 표본 | 결과 |
|---|---|---|
| BOM 2014 | FM 응답 134~318명 | 최대 민원 온도 68% |
| IFMA 2009 | IFMA 회원 473명 | 추움 94%, 더움 91% |
| Building Engines·BOMA 2024 | 236명 | 임차인 요청 1위 쾌적성 66% |
| JLL Technologies 2023 | 북미 FM | 반응형 작업지시 1위 HVAC 72.4% |
| Federspiel 1998 | 690동, 23,500명 | 열감 민원이 전체 민원 1위 |
| CBE 2021 | 897동, 93,662건 | 온도 불만족 39% |
| 위성곤 의원실 2025 | 공무원 12,027명 | 냉방 규정 부적절 84.6% |
주: Building Engines, JLL Technologies는 판매 기업. IFMA 2009와 위성곤 의원실 설문은 2차 보도.
:::

::: figure B3 업계지 원문 | 최대 민원 온도 68%
image: ../../human/explanation/research/img/o-b3-temp.png
자료: Building Operating Management(2014)
:::

<div></div>

::: figure B11 보고서 원문 | 반응형 작업지시 1위 HVAC 72.4%
image: ../../human/explanation/research/img/o-b11-jll.png
자료: JLL Technologies(2023), 판매 기업
:::

<div></div>

::: figure D2 논문 원문 | 민원 1건 대응 1.6시간, 2.1시간
image: ../../human/explanation/research/img/o-d2-time.png
자료: Federspiel, HVAC&R Research(2000)
:::

## 데이터 분산

**운영자는 BAS, 계량기, 작업지시, 도면, 스프레드시트를 오가며 상태를 확인합니다.**

건물 시스템을 완전히 통합한 조직은 10%입니다(JCI·Forrester 2023, 판매 기업). IFMA·Autodesk 조사에서 60% 이상이 데이터 문제로 자원 시간 10~20%를 낭비한다고 추정했습니다.

::: figure B12 보고서 원문 | 데이터 품질·통합 문제로 자원 시간 10~20% 낭비
image: ../../human/explanation/research/img/o-b12-ifma.png
자료: IFMA·Autodesk(2023), 212명
:::

<div></div>

::: figure B1 보고서 원문 | 현장 엔지니어 하루 15% 이상 정보 추적
image: ../../human/explanation/research/img/o-d17-nist.png
자료: NIST GCR 04-867(2004)
:::

<div></div>

::: figure A4 기사 원문 | 데이터를 쌓기만 하고 확인하지 않음
image: ../../human/explanation/research/img/o-a4-data.png
자료: 기계설비신문(2026-11-02), 서울에너지드림센터장
:::

## 기존 도구

**국내 학교 BEMS는 설치 후에도 대부분 사용하지 않습니다.**

학교 43곳 중 BEMS 인지는 81%, 기능 활용은 32%였습니다. 응답자는 대시보드 복잡성, 전문인력 부재(71%), 인수인계 어려움을 문제로 기록했습니다.

::: figure A1 논문 원문 | BEMS 기능 활용 32%
image: ../../human/explanation/research/img/o-a1-use.png
자료: 김성중·이승민, 교육녹색환경연구(2022)
:::

<div></div>

::: figure A1 논문 원문 | 현장 5곳 중 4곳 미사용, 대시보드 복잡
image: ../../human/explanation/research/img/o-a1-site.png
자료: 김성중·이승민, 교육녹색환경연구(2022)
:::

**경보는 너무 많고, 운영자는 경보보다 경험으로 판단합니다.**

영국 FM 100명 조사에서 BMS가 HVAC 문제 식별에 매우 도움이 된다는 응답은 24%였습니다.

::: figure B8 보고서 원문 | BMS 경보 하루 평균 12.5건
image: ../../human/explanation/research/img/o-b8-cim.png
자료: CIM, The Energy Blind Spots(2022), 판매 기업
:::

<div></div>

::: figure C1 논문 원문 | 한 시스템에 경보 10만 건 이상 누적
image: ../../human/explanation/research/img/o-c1-alerts.png
자료: Balaji 외, arXiv 1612.06025(2016)
:::

<div></div>

::: figure D24 논문 원문 | 경보 과다, 평면도 위 경보·고장 표시 요구
image: ../../human/explanation/research/img/o-d24-floor.png
자료: Li 외, CMU 캠퍼스 BAS 경보 관리
:::

<div></div>

::: figure C11 논문 원문 | 높은 비용, 나쁜 사용자 경험, 조치 전환 어려움
image: ../../human/explanation/research/img/o-c11-fm.png
자료: Roth 외, Applied Energy(2020), 학교구 FM 10명
:::

## 빈 공간 운전

**운영자는 비효율 운전 건물이 있다고 인정하지만 어느 건물인지 알지 못합니다.**

::: figure C1 논문 원문 | 비효율 건물의 위치와 정도 미파악
image: ../../human/explanation/research/img/o-c1-ineff.png
자료: Balaji 외, arXiv 1612.06025(2016), 운영자 10명
:::

**실측 결과 빈 공간 운전은 상시 발생합니다.**

::: table 빈 공간 운전 측정 결과
| 측정 | 결과 | 비교 기준 |
|---|---|---|
| 국내 대학 강의실 292개 | 빈 강의실 123개 중 40% 에어컨 가동 | 설정온도 22.75℃, 권장 26℃ |
| 스웨덴 회의실 7개 | 예약 시간의 31.2% 빈 방 | 실제 사용 68.8% |
| 미국 사무실 17동 | 비점유 부하 평균 47.4% | 분석가 가정 10~20% |
| Butlr 2026 | 미사용 사무 공간 24% 냉난방 | 공간 계획 데이터 사용 19% |
주: Butlr는 재실 센서 판매 기업.
:::

::: figure A21 기사 원문 | 빈 강의실 40% 에어컨 가동
image: ../../human/explanation/research/img/o-a21-room.png
자료: 투데이에너지(2015-09-17), 에너지시민연대 조사
:::

<div></div>

::: figure D13 논문 원문 | 예약 시간 31.2% 빈 방
image: ../../human/explanation/research/img/o-d13-room.png
자료: Shokrollahi 외, Internet of Things(2025)
:::

**재실 정보로 운전을 바꾸면 현장 실증에서 HVAC 에너지가 17.8~55.47% 감소했습니다.**

WiFi 재실 추정 제어는 1일 실험에서 17.8%, 13개월 실증은 평일 43.48%와 주말 55.47%를 절감했습니다.

## 인력·숙련

**국내 기계설비 유지관리자의 72%가 50대 이상입니다.**

::: table 국내 운영 인력 현황
| 자료 | 결과 | 비교 기준 |
|---|---|---|
| 기계설비 경력수첩(2024-03) | 50대 이상 48,087명, 72% | 20~30대 약 6,500명 |
| 관리사무소장 설문 | 인력 부족 56% | 업무 부담 1위 노후 시설 수선 89% |
| 충남교육청 시설관리직 | 2013년 665명 | 1999년 1,785명 |
| 학교 BEMS 설문 | 전문인력 없음 71% | 설비 담당자 겸임 11% |
:::

::: figure A7 기사 원문 | 60대 이상 24,531명, 50대 23,556명
image: ../../human/explanation/research/img/o-a7-age.png
자료: 기계설비신문(2024-04-15), 대한기계설비건설협회 집계
:::

<div></div>

::: figure C8 논문 원문 | 숙련 운영자 1명 이탈의 영향
image: ../../human/explanation/research/img/o-c8-staff.png
자료: Dyson 외, ACEEE Summer Study(2022), 매사추세츠 26곳
:::

# 운영자 요구와 서비스 시사점

## 운영자 요구

**가장 많이 언급된 요구는 통합 단일 화면이고, 국내 학교 운영자는 고장 조회와 일괄 on/off를 가장 필요한 기능으로 선택했습니다.**

::: table 운영자 요구와 근거 수
| 요구 | 근거 수 | 대표 수치 |
|---|---|---|
| 통합 단일 화면 | 14건 | 단일 플랫폼 희망 52%, 파트너 역량 1위 74% |
| 고장·상태 조회, 일괄·원격 제어 | 6건 | 고장 조회 95%, 일괄 on/off 93% |
| 실별 재실·공간 이용 정보 | 8건 | 교실 재실 확인 88% |
| 민원의 위치·시간 기록 | 6건 | 재실자와 체계적 소통 수단 희망 90% |
| 빠르고 쉬운 시각화 | 7건 | 데이터 시각화 영향 클 것 56% |
| 예지 정비·FDD | 8건 | 업계 설문 8건 |
| 경보 우선순위, 평면도 위 표시 | 4건 | C1, C9, C13, D24 |
| 조작 시 에너지·비용 영향 표시 | 3건 | C1, C6, C11 |
| 인수인계·학습 지원 | 6건 | A2, A4, A5, C1, C6, C8 |
주: 근거 수는 수록 자료 중 해당 요구를 언급한 자료 수. 3D 화면과 자연어 질의를 직접 요구한 자료는 없음.
:::

## 도구 효과

**AR·BIM 도구는 설비 위치 찾기에서 시간을 51~65% 단축했지만, 모니터링에서 3D가 2D보다 낫다는 근거는 없습니다.**

::: table 시각화·질의 도구 실험 결과
| 실험 | 조건 | 결과 |
|---|---|---|
| Lee·Akin 2011 | AR, BAS 연동 | 위치 찾기 시간 51% 절감(초록) |
| Gheisari 외 2014 | 8명, AR과 종이 | 128초와 336초 |
| Chen 외 2019 | 48명, AR과 2D 도면 | 31.1초와 89.8초 |
| Halmetoja 외 2020 | GUI 6종 평가 | 모니터링은 2D가 3D보다 빠름(초록) |
| Kapalo 외 2022 | 소방관 64명 | 2D와 3D 작업 부하 차이 없음(p=0.924) |
| Ly 외 2026 | SUS 12명 | 디지털트윈 82, AI 비서 79.6, 비교 조건 없음 |
| Neubauer 외 2026 | 논문 66편 | HVAC 운영 LLM 즉시 도입 가능 0편 |
:::

::: figure D21 논문 원문 | AR 31.1초, 2D 도면 89.8초
image: ../../human/explanation/research/img/o-d21-ar.png
자료: Chen 외, ITcon(2019)
:::

## 서비스 시사점

**서비스 기능 4개는 조사된 문제와 요구에 대응하며, 경보와 인력 문제는 현재 범위 밖입니다.**

::: figure 문제, 운영자 요구, 서비스 기능 연결 | 점선 칸은 현재 서비스 범위 밖
image: ../../human/explanation/research/img/d-o-map.png
자료: 이 보고서 2장 운영자 요구 표
:::

**검증 지표는 3D 화면의 시각 효과보다 운영 과업의 시간과 탐지량으로 정합니다.**

::: table 검증 지표 후보
| 지표 | 비교 기준 | 근거 |
|---|---|---|
| 민원 호실의 상태 확인 시간 | 2D 도면과 BMS 화면 조합 | D2, C3 |
| 빈 공간 운전 탐지 수와 낭비 kWh | 운영자 수동 탐색 | C1, A21, D13 |
| 상태 확인에 필요한 화면 수 | 현재 사용 시스템 수 | B13, B21 |
| 신규 운영자의 과업 완료 시간 | 숙련 운영자 | A1, C8 |
:::

⇒ 3D 단독 화면의 근거가 약하므로, 같은 데이터를 2D 평면으로 보는 화면 전환을 요구사항 검토에서 판단합니다.

## 제한 사항과 다음 작업

**판매 기업 자료가 22건이고, 운영자 대상 3D·자연어 질의 비교 실험은 찾지 못했습니다.**

- 국내 감사원·국정감사의 BEMS 미운영 지적, 냉난방 민원 건수 통계, 오피스 시설팀의 직접 발언은 찾지 못했습니다.
- 유료·회원 자료(DBpia, RISS, Verdantix, IWFM)는 열람하지 않았습니다.

::: table 다음 작업
| 작업 | 기한 | 담당 |
|---|---|---|
| 서비스 기획 2절 문제 근거 표 갱신 여부 결정 | 미정 | 미정 |
| 2D 평면 보기 전환 요구사항 검토 | 미정 | 미정 |
| 검증 지표 4개 측정 방법 확정 | 미정 | 미정 |
| BECON 팀에 운영자 민원 처리 방식 확인 | 미정 | 미정 |
:::
