---
title: AI 디지털트윈 공간 가시화·운영 최적화 조사
subtitle: 2026년 11월
org: Maestro 팀
code: 해커톤 사전 조사 보고서
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

  2026-11-18 웹 검색 41회. 뉴스, 기업 자료, 논문, 시장 보고서를 조사했습니다.

⇒ 논문 수치는 초록 기준입니다. 원문 캡처는 확인한 문장에 노란색으로 표시했습니다.

- **[해커톤 조건]**

  공고의 기간, 제공 데이터, 심사 기준은 확인하지 못했습니다.

⇒ 주제 후보 평가는 공개 데이터 사용을 전제로 했습니다.

- **[수치 출처]**

  시장 규모와 오피스 활용률 수치 일부는 조사·판매 기업 자료입니다.

⇒ 같은 시장도 기관마다 정의가 달라 범위로 표시했습니다.

# 요약 {.front}

::: summary
- 현장 문제는 정적 3D 모델, 비표준 설비 데이터, 실행으로 연결되지 않는 가시화 3가지가 공통입니다.
  - 국토부 3D 지도 오차는 도심 1m, 비도심 5m이고 건물 정보는 2014년 이후 갱신되지 않았습니다.
- 2025~2026 논문은 LLM을 트윈의 질의·시나리오·규칙 생성 계층으로 사용합니다.
  - 공조 절감률은 시뮬레이션 10~35%, 현장 실증은 한 자릿수~10%대 초반입니다.
- 권장 주제는 "재실 기반 공간 운영 에이전트"입니다.
  - 5개 기준 평가에서 25점 만점 중 21점으로 1위입니다. 경쟁 제품은 측정·대시보드 중심이고 자동 제안·실행 기능이 적습니다.

| 항목 | 값 | 비교 기준 |
|---|---|---|
| 세계 디지털트윈 시장 | 211억~362억 달러(2025) | 2030년 1,316억~1,803억 달러 |
| 오피스 평균 활용률 | 54%(2025, JLL) | 2024년 49%, 기업 목표 79% |
| 권장 후보 평가 점수 | 21점 | 2위 후보 D 19점 |
:::

# 현장 문제

## 문제 구조

**문제 8가지는 데이터, 활용, 조직 3개 계층에 분포합니다.**

아래 계층 문제가 위 계층 결과의 신뢰도를 낮춥니다.

::: figure 현장 문제 8가지의 계층 구조 | 조직 문제는 데이터 갱신을, 데이터 문제는 가시화 신뢰도를 낮춤
image: ../../human/explanation/research/img/d-problems.png
자료: 이 보고서 2~4장의 원문 자료
:::

## 데이터 계층 문제

**공공 3D 지도는 오차가 1~5m이고 건물 정보가 2014년에서 멈췄습니다.**

같은 지역의 민간 3D 지도 오차는 2~10cm입니다.

::: figure P1 국토부 3D 지도와 민간 3D 지도 비교 | 다리 겹침, 둔치 입체감 누락
image: ../../human/explanation/research/img/p1-hankyung-map.jpg
자료: 한국경제(2025-01-14) 기사 그래픽
:::

<div></div>

::: figure 기사 원문 | 오차 1~5m, 건물 정보 2014년 조사에서 중단
image: ../../human/explanation/research/img/p1-hankyung-text.png
자료: 한국경제(2025-01-14) 정부 3D맵 보도
:::

**설비 데이터는 제조사마다 이름 형식이 달라 매핑에 수작업이 필요합니다.**

테스트 건물의 설비 포인트 948개 중 763개(80.5%)만 명명 규칙을 따랐습니다(TU Delft).

::: figure P2 논문 원문 | 표준 클래스 936개, 매핑 검증에 수작업 필요
image: ../../human/explanation/research/img/p2-brick-dicl.png
자료: Brick-DICL(arXiv 2606.17637) 초록
:::

## 활용 계층 문제

**트윈의 예측 결과가 정비 시스템과 연결되지 않으면 참고 화면에 그칩니다.**

가시화 다음 단계인 조치 연결이 빠진 상태입니다.

::: figure P3 업계 자료 원문 | 예측 결과와 정비 일정 시스템 미연결
image: ../../human/explanation/research/img/p3-alchera.png
자료: 알체라 블로그, "멈춰 있는 3D 모델은 끝"
:::

**오피스 공간의 절반가량은 평균적으로 사용되지 않습니다.**

2025년 활용률 54%는 기업 목표 79%보다 25%p 낮습니다.

::: figure P4 보고서 원문 | 활용률 54%, 목표 79%
image: ../../human/explanation/research/img/p4-jll.png
자료: JLL 2025 Occupancy Planning Benchmark 보도자료
:::

<div></div>

::: figure 오피스 평균 활용률 | 2025년 53~54%, 목표 79% 대비 미달
```json
{"type": "bar", "unit": "%", "x": ["2023", "2024", "2025"],
 "series": [{"name": "CBRE", "values": [35, 38, 53]},
            {"name": "JLL", "values": [null, 49, 54]},
            {"name": "JLL 기업 목표", "values": [null, null, 79], "color": "#8eaadb"}],
 "yMin": 0, "yMax": 100}
```
자료: CBRE, JLL(조사·중개 기업 자료)
:::

**인파 관리 시스템은 밀집도를 지도에 표시하고, 대응은 사람이 판단합니다.**

기지국 접속 데이터로 밀집도를 계산해 4단계 경보를 표시합니다.

::: figure P8 기사 원문 | 기지국 데이터와 공간정보로 밀집도 산출
image: ../../human/explanation/research/img/p8-fnnews.png
자료: 파이낸셜뉴스(2023-05-10), 행정안전부 현장인파관리시스템
:::

## 조직 계층 문제

**시설 운영 인력의 68%가 45세 이상입니다.**

숙련자의 지식이 시스템이 아닌 사람에게 남아 있어 인수인계가 어렵습니다.

::: figure P5 업계지 원문 | 미국 시설 운영·기술 인력 68%가 45세 이상
image: ../../human/explanation/research/img/p5-ifma.png
자료: IFMA FMJ, "Addressing the FM Labor Shortage"
:::

**준공 30년 이상 시설 비중은 2044년 75.3%에 도달합니다.**

중대 결함은 2020년 275건에서 2024년 935건으로 3.4배 증가했습니다.

::: figure P6 기사 원문 | 중대 결함 4년간 3.4배, 2044년 노후 시설 75.3%
image: ../../human/explanation/research/img/p6-asiae.png
자료: 아시아경제(2026-07-13), 국토안전관리원 자료 인용
:::

<div></div>

::: figure 시설물 중대 결함 건수 | 2020년 275건에서 2024년 935건
```json
{"type": "bar", "unit": "건", "x": ["2020", "2024"],
 "series": [{"name": "중대 결함", "values": [275, 935]}], "yMin": 0, "yMax": 1000}
```
자료: 국토안전관리원(아시아경제 인용)
:::

::: figure 준공 30년 이상 시설 비중 | 2034년 49.9%, 2044년 75.3% 전망
```json
{"type": "bar", "unit": "%", "x": ["2034", "2044"],
 "series": [{"name": "30년 이상 비중", "values": [49.9, 75.3], "color": "#c00000"}], "yMin": 0, "yMax": 100}
```
자료: 국토안전관리원(아시아경제 인용)
:::

**도입 장벽은 기술보다 조직, 조달, 인력 역량에 있습니다.**

공공 의료 시설의 트윈 사업 대부분은 시범 단계에 머물러 있습니다.

::: figure P7 논문 원문 | 기술 역량만으로 설명되지 않는 도입 장벽
image: ../../human/explanation/research/img/p7-frontiers.png
자료: Frontiers in Built Environment(2026)
:::

# 기술 동향

## 기술 지도

**LLM은 공간 그래프 위에서 질의·시나리오·규칙을 생성하는 계층입니다.**

계산과 제어는 기존 시뮬레이터와 제어기가 수행합니다.

::: figure 기술 동향 10가지의 계층과 해결 문제 | LLM 계층이 P3 실행 단절과 P5 인력 부족을 담당
image: ../../human/explanation/research/img/d-tech.png
자료: 각 논문 초록
:::

## 대표 연구

**도면과 사진에서 공간 그래프를 만들고 자연어로 조회하는 연구가 2025년 이후 증가했습니다.**

FloorplanVLM은 도면을 좌표 JSON으로, KeySG는 건물을 층·실·객체 그래프로 변환합니다.

::: figure FloorplanVLM(arXiv 2602.06507) | 도면 이미지를 벽·문 좌표로 변환
image: ../../human/explanation/research/img/t-floorplanvlm.png
자료: arXiv 2602.06507 그림 1
:::

::: figure KeySG(arXiv 2510.01049) | 층·실·객체 계층 그래프와 자연어 질의
image: ../../human/explanation/research/img/t-keysg.jpg
자료: arXiv 2510.01049 그림 1
:::

**운영 자동화 연구는 규칙 생성과 시뮬레이션 학습 환경으로 나뉩니다.**

PILLM은 LLM이 이상 탐지 규칙을 생성·수정하고, NVIDIA Mega는 공장 트윈에서 로봇 제어를 학습합니다.

::: figure PILLM(arXiv 2510.17146) | 물리 제약 기반 이상 탐지 규칙 진화
image: ../../human/explanation/research/img/t-pillm.png
자료: arXiv 2510.17146 그림 1
:::

::: figure NVIDIA Mega 블루프린트(2025-01) | 공장 트윈에서 로봇 군집 시뮬레이션
image: ../../human/explanation/research/img/t-mega.jpg
자료: NVIDIA 블로그
:::

**트윈 기반 제어의 절감률은 시뮬레이션과 현장 실증의 차이가 큽니다.**

장비 교체 12%와 강화학습 결합 32% 사례에서 강화학습 단독 효과는 분리되지 않았습니다.

::: figure 트윈 기반 제어의 에너지 절감률 | 시뮬레이션 최대 35%, 장비 교체 효과와 분리 필요
```json
{"type": "bar", "unit": "%", "x": ["RL 리뷰 하한", "RL 리뷰 상한", "트윈+유전 알고리즘", "장비 교체", "교체+RL"],
 "series": [{"name": "절감률", "values": [10, 35, 25, 12, 32]}], "yMin": 0, "yMax": 40}
```
자료: Sensors 2025 리뷰, JESA 2025, IEEE 2025(Loffa 외)
:::

# 시장·경쟁

## 시장 규모

**디지털트윈 시장은 2030년까지 연 34~48% 성장이 전망됩니다.**

빌딩 관리 시스템 시장은 2025년 디지털트윈 시장보다 크지만 성장률은 낮습니다.

::: figure 시장별 2025년·2030년 규모 | 디지털트윈 7배, 빌딩 관리 2.8배 성장 전망
```json
{"type": "bar", "unit": "십억 달러", "x": ["디지털트윈", "빌딩 관리 시스템", "빌딩 에너지 관리"],
 "series": [{"name": "2025", "values": [21.1, 41.9, 29.6]},
            {"name": "2030", "values": [149.8, 116.7, 58.4]}], "yMin": 0}
```
자료: MarketsandMarkets, Mordor Intelligence, Knowledge Sourcing
:::

::: table 시장 규모 추정 범위
| 시장 | 2025 | 2030 | 연평균 성장률 | 자료 |
|---|---|---|---|---|
| 세계 디지털트윈 | 211억~362억 달러 | 1,316억~1,803억 달러 | 34~48% | MarketsandMarkets, Mordor, 360iResearch |
| 빌딩 관리 시스템(BMS) | 419억 달러 | 1,167억 달러 | 22.8% | Mordor Intelligence |
| 빌딩 에너지 관리(BEMS) | 296억 달러 | 584억 달러 | 14.5% | Knowledge Sourcing |
| 재실 분석 소프트웨어 | 28억~42억 달러 | 미정 | 14.8~18.5% | Market Intelo(신뢰도 낮음) |
| 국내 디지털트윈 | 1.76조 원 | 미정 | 2020년 0.07조 원 | 한국경제 그래픽 |
주: 재실 분석 수치는 같은 기관 보고서끼리 값이 중복되어 참고용
:::

## 후보별 경쟁 제품

**경쟁 제품은 측정·대시보드 영역과 3D 트윈 영역으로 나뉩니다.**

공간 활용 측정과 자동 운영 제안을 함께 제공하는 제품은 적습니다.

::: figure 경쟁 제품 위치 | 후보 B는 가시화와 자동 제안을 함께 제공하는 영역
image: ../../human/explanation/research/img/d-position.png
자료: 각 기업 홈페이지 제품 설명, 위치는 작성자 판단
:::

::: table 후보별 경쟁 제품
| 후보 | 경쟁 제품 | 특징 | 후보의 차이 |
|---|---|---|---|
| A 대화형 공간 트윈 | Matterport, Willow, 이에이트 NDX Pro | 3D 캡처, 지식 그래프, 시뮬레이션 트윈 | 도면 이미지만으로 생성, 자연어 조회 |
| B 재실 기반 공간 운영 | VergeSense, Density, Butlr | 재실 센서, 활용률 대시보드, 공간 계획 | 센서 없이 예약·계량 데이터로 시작, 통합안과 kWh 계산 |
| C what-if 시뮬레이터 | NVIDIA Omniverse, 이에이트 NFLOW, AnyLogic | 물리·이산 사건 시뮬레이션 | 자연어 시나리오 입력, 대리 모델 즉시 계산 |
| D 이상 징후 작업 지시 | Facilio, SkySpark, Clockworks | 규칙 기반 고장 진단, FM 에이전트 | LLM 규칙 생성, 3D 위치와 작업 지시 연결 |
| E 인파 안전 트윈 | 인텔리빅스, 플럭시티 Safers, 뷰런 | CCTV·라이다 밀집 분석, 통합관제 | 공간 그래프 기반 대피 경로 계산 |
주: Butlr는 2024-08 Series B 3,800만 달러 투자 유치. 인텔리빅스 AI 관제 시스템은 지자체 68.5% 도입(2025-12 보도)
:::

**후보 B의 경쟁 제품은 재실 센서 판매를 전제로 합니다.**

VergeSense와 Density는 센서 설치 후 활용률을 보여 주고, 공간 계획 판단은 사용자가 수행합니다.

::: figure VergeSense 홈페이지 | 공간 계획 의사결정 지원
image: ../../human/explanation/research/img/c-vergesense.jpg
자료: vergesense.com(2026-11-18 캡처)
:::

::: figure Density 홈페이지 | 레이더 인원 계수 센서
image: ../../human/explanation/research/img/c-density.jpg
자료: density.io(2026-11-18 캡처)
:::

**3D 트윈 제품은 운영 AI를 결합하는 방향으로 이동하고 있습니다.**

Willow는 지식 그래프, 이에이트는 온톨로지 기반 판단 기능을 강조합니다.

::: figure Willow 홈페이지 | 건물 운영 AI
image: ../../human/explanation/research/img/c-willow.jpg
자료: willowinc.com(2026-11-18 캡처)
:::

::: figure 이에이트 홈페이지 | AI 기반 운영 인텔리전스
image: ../../human/explanation/research/img/c-e8.jpg
자료: e8ight.co.kr(2026-11-18 캡처)
:::

**고장 진단과 인파 관제 분야도 AI 에이전트·영상 분석 제품이 운영 중입니다.**

Facilio는 FM 에이전트, 인텔리빅스는 지자체 AI 영상 관제를 제공합니다.

::: figure Facilio 홈페이지 | FM 에이전트 AI 플랫폼
image: ../../human/explanation/research/img/c-facilio.jpg
자료: facilio.com(2026-11-18 캡처)
:::

::: figure 인텔리빅스 홈페이지 | AI 영상 관제
image: ../../human/explanation/research/img/c-intellivix.jpg
자료: intellivix.ai(2026-11-18 캡처)
:::

# 주제 제안

## 후보 평가

**5개 기준 평가에서 후보 B가 21점으로 1위, 후보 D가 19점으로 2위입니다.**

기준은 시장성, 기술적 독창성, 구현력, 난이도, 주제 관계성이며 각 1~5점입니다. 난이도는 쉬울수록 높은 점수입니다.

::: table 후보별 점수와 근거
| 후보 | 시장성 | 독창성 | 구현력 | 난이도 | 관계성 | 합계 | 근거 |
|---|---:|---:|---:|---:|---:|---:|---|
| A 대화형 공간 트윈 | 3 | 4 | 3 | 2 | 4 | 16 | 3D 생성 품질 확보 부담, 최적화 결과 수치화 약함 |
| B 재실 기반 공간 운영 | 5 | 3 | 4 | 4 | 5 | 21 | 활용률 54% 대 목표 79%, 공개 계량 데이터, 가시화와 최적화 모두 해당 |
| C what-if 시뮬레이터 | 3 | 5 | 2 | 2 | 4 | 16 | 대리 모델 학습 데이터와 시간 부족 |
| D 이상 징후 작업 지시 | 4 | 4 | 4 | 3 | 4 | 19 | 인력 고령화 문제 근거 명확, 3D 표현 비중 낮음 |
| E 인파 안전 트윈 | 3 | 3 | 3 | 3 | 4 | 16 | 공공 수요 중심, 기존 관제 제품 다수 |
주: 점수는 조사 근거 기준 작성자 판단. 공고의 심사 기준 확인 후 재평가
:::

::: figure 후보별 평가 점수 | 후보 B 21점, 후보 D 19점
```json
{"type": "bar", "stacked": true, "unit": "점", "x": ["A", "B", "C", "D", "E"],
 "series": [{"name": "시장성", "values": [3, 5, 3, 4, 3]},
            {"name": "독창성", "values": [4, 3, 5, 4, 3]},
            {"name": "구현력", "values": [3, 4, 2, 4, 3]},
            {"name": "난이도", "values": [2, 4, 2, 3, 3]},
            {"name": "관계성", "values": [4, 5, 4, 4, 4]}],
 "yMin": 0, "yMax": 25}
```
자료: Maestro 팀
:::

## 권장 주제 구성

**후보 B는 히트맵으로 가시화하고, 에이전트가 통합안과 절감량을 제안합니다.**

1~3단계가 공간 가시화, 4~5단계가 운영 최적화에 해당합니다.

::: figure 후보 B 처리 흐름 | 데이터 수집에서 일정 변경 요청까지 6단계
image: ../../human/explanation/research/img/d-flow.png
자료: Maestro 팀
:::

<div></div>

::: figure 후보 B 화면 예시 | 재실 히트맵과 에이전트 제안을 한 화면에 표시
image: ../../human/explanation/research/img/d-mock.png
주: 수치는 설명용 가상 데이터
자료: Maestro 팀
:::

::: table 사용할 공개 데이터와 제약
| 데이터 | 내용 | 제약 |
|---|---|---|
| Building Data Genome Project 2 | 비주거 건물 1,636개, 계량기 3,053개, 2016~2017 시간 단위 | 라이선스 파일 확인 필요 |
| 서울시 실시간 도시데이터 | 주요 121개 장소 인구 5분 갱신 | 1회 1개 장소 호출, 기지국 추정값 |
| 브이월드 3D 분석 API | glb·gltf 등 파일 형식 지원 | 3D 건물 원본 API 재개 여부 미확인 |
| 실내 재실 데이터 | 공개 데이터 미확인 | 계량 패턴 기반 합성 데이터로 대체 |
:::

**실내 재실 데이터가 없으면 합성 데이터를 사용하고 화면에 표시합니다.**

3D 구축 시간이 부족하면 평면 히트맵을 먼저 구현합니다.

::: table 다음 작업
| 작업 | 기한 | 담당 |
|---|---|---|
| 해커톤 공고의 기간, 제공 데이터, 심사 기준 확인과 후보 재평가 | 2026-11-19 | 미정 |
| 주제 확정과 기술 선택 기록 작성 | 2026-11-19 | 팀 전체 |
| 발표 자료에 인용할 수치의 원문 확인 | 발표 자료 작성 전 | 미정 |
:::

# 부록 주요 자료 {.appendix}

::: table 주요 자료 목록
| 구분 | 자료 | 주소 |
|---|---|---|
| 문제 | 한국경제 정부 3D맵 보도 | hankyung.com/article/2025011459191 |
| 문제 | Brick-DICL | arxiv.org/html/2606.17637 |
| 문제 | 알체라 산업현장 디지털트윈 | alchera.ai/resource/blog/ac-industrial-digital-twin-ai-data-operating-system-advancement |
| 문제 | JLL 오피스 활용률 | jll.com/en-de/newsroom/the-evolving-workplace-prioritizes-experience-while-optimizing-space |
| 문제 | IFMA FM 인력 부족 | fmj.ifma.org/addressing-the-fm-labor-shortage |
| 문제 | 아시아경제 노후 SOC | view.asiae.co.kr/article/2026070817544082956 |
| 문제 | Frontiers 공공 의료 시설 트윈 | frontiersin.org/journals/built-environment/articles/10.3389/fbuil.2026.1828585 |
| 문제 | 파이낸셜뉴스 현장인파관리시스템 | fnnews.com/news/202305101834193923 |
| 기술 | FloorplanVLM, KeySG, PILLM | arxiv.org/abs/2602.06507, 2510.01049, 2510.17146 |
| 기술 | NVIDIA Mega | blogs.nvidia.com/blog/mega-omniverse-blueprint |
| 시장 | 디지털트윈 시장(MarketsandMarkets) | marketsandmarkets.com/ResearchInsight/digital-twin-market-size.asp |
| 시장 | BEMS 시장(Knowledge Sourcing) | knowledge-sourcing.com/report/building-energy-management-system-market |
| 데이터 | Building Data Genome Project 2 | arxiv.org/abs/2006.02273 |
주: 전체 목록은 docs/human/explanation/research/digital-twin-survey-papers.md
:::
