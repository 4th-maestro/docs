---
title: 도면 기반 공조 설비 디지털트윈 기획·설계
subtitle: 2026년 11월
org: Maestro 팀
code: 서비스 기획·설계 보고서
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
.toc-section { display: none; }
th { white-space: nowrap; }
code { font-family: 'Pre', sans-serif; background: #EEF1F7; }
h2, h3, .key { break-after: avoid; }
</style>

# 이 보고서의 전제 {.front}

- **[주제]**

  2026-11-19 팀이 주제를 정했습니다. 정비 기술자가 실제 설비와 디지털트윈을 겹쳐 보며 고장을 찾는 것이 최종 목적입니다.

⇒ 겹쳐보기는 웹 실측·기대값 비교가 기본이고, 태블릿 AR은 확장입니다. 대상은 건물 기계실·공조 설비입니다.

- **[조사 범위]**

  웹 검색 32회로 기사·논문·기업 자료 56건을 검토해 43건을 수록했습니다. 학술 DB(KCI, Scopus) 직접 검색은 하지 않았습니다.

⇒ 경쟁 제품 기능은 공개 자료 기준입니다. 확인하지 못한 기능은 회색으로 표시하며, 기능이 없다는 뜻은 아닙니다.

- **[데이터]**

  실제 현장 센서 대신 공개 고장 데이터셋과 시뮬레이션으로 실시간 데이터를 재생합니다.

⇒ 시연 화면과 발표에 시뮬레이션 데이터임을 표시합니다.

- **[확정 수준]**

  기술 스택과 일정은 권장안입니다. 해커톤 종료일과 심사 기준은 확인하지 못했습니다.

⇒ 팀 확인 후 기술 선택 기록으로 확정합니다. 화면 그림의 설비명과 수치는 설명용 예시입니다.

# 요약 {.front}

::: summary
- 공조 설비 고장은 매일 발생하지만, 정비 기술자는 2D 도면과 경보 목록만으로 원인을 찾습니다.
  - 공조기 40%에서 매일 고장 경보가 발생하고, 현장 엔지니어는 경험과 감으로 원인을 찾았다고 말합니다.
- 경쟁 제품 5개 유형은 정비 흐름의 일부만 담당합니다.
  - 3D 트윈은 BIM·스캔을 요구하고, 고장 진단 소프트웨어는 공간 맥락이 없으며, 제조사 원격 관리는 자사 모델에 한정됩니다.
- Maestro는 2D 도면 한 장으로 기계실 3D 트윈을 만들고, 실측과 기대값의 잔차로 찾은 원인 후보를 3D 위치와 현장 화면에 표시합니다.
  - MVP는 기능 15개 중 11개이며, LBNL 공개 고장 데이터와 NIST APAR 규칙으로 시연합니다.

| 항목 | 값 | 비교 기준 |
|---|---|---|
| 매일 고장 경보가 있는 공조기 | 40% | 터미널 유닛 30%(LBNL 2023) |
| 고장 진단 소프트웨어 에너지 절감 | 중앙값 9% | 에너지 정보 시스템 4%(LBNL, 2년) |
| 데이터 포인트 1개 연동 비용 | 230~1,880달러 | 초기~5년 보유(ASHB 2020) |
| 기능 요구사항 | 15개 | MVP 11개, 확장 4개 |
:::

# 왜 필요한가

## 조사 방법

**기사·논문·기업 자료 56건을 검토해 43건을 수록했고, 22건은 원문 문장을 강조 캡처로 확인했습니다.**

::: figure 조사 방법과 결과 | 웹 검색 32회, 검토 56건, 수록 43건, 제외 13건
image: ../../human/explanation/img/d-p-survey.png
자료: Maestro 팀. 자료 목록은 부록
:::

## 현장 문제 4가지

**공조 설비 고장은 매일 발생하지만, 정비 기술자는 2D 도면과 경보 목록만으로 원인을 찾습니다.**

고장 발생, 원인 탐색, 정보 부재, 제도·인력 4가지 문제가 이어져 있습니다.

::: figure 현장 문제 4가지 | 결과, 현재 대응, 원인, 제도·인력
image: ../../human/explanation/img/d-p-problems.png
자료: 각 칸의 출처, 부록 자료 목록
:::

## 고장은 상시 발생

**설비 6만 대 이상의 기록에서 공조기 40%, 터미널 유닛 30%에 매일 고장 경보가 1건 이상 있었습니다.**

::: figure 논문 초록 원문 | 공조기 40%, 터미널 유닛 30%에 매일 고장 경보
image: ../../human/explanation/research/img/b-crowe.png
자료: Crowe 외, Science and Technology for the Built Environment 29(10), 2023
:::

<div></div>

**운영 비효율로 낭비되는 건물 에너지는 10~30%로 추정되며, 고장 진단 소프트웨어 도입 건물은 중앙값 9%를 절감했습니다.**

::: figure 논문 원문 | 에너지 10~30% 낭비 추정
image: ../../human/explanation/research/img/b-kb2008.png
자료: Katipamula, Brambley(PNNL), ACEEE Summer Study 2008
:::

<div></div>

::: figure DOE 기사 원문 | 고장 진단 소프트웨어 중앙값 9%, 1제곱피트당 0.24달러 절감
image: ../../human/explanation/research/img/b-seac.png
자료: 미국 에너지부, Smart Energy Analytics Campaign 결과
:::

## 원인은 경험으로 탐색

**현장 엔지니어는 설비를 하나씩 열어 경험과 감으로 원인을 찾았다고 말합니다.**

LBNL은 경보가 많아 운영자에게 데이터 과부하가 생길 위험을 지적했습니다.

::: figure 기사 원문 | 경험과 감으로 원인 탐색
image: ../../human/explanation/research/img/b-joongang.png
자료: 중앙일보(다음 전재), 2026-06-25
:::

<div></div>

**국내 연구는 전문가 규칙 기법이 급격한 고장에는 유리하지만 점진적 성능 저하는 진단하기 어렵다고 보고했습니다.**

::: figure 논문 원문 | 규칙 기법의 점진적 고장 진단 한계
image: ../../human/explanation/research/img/b-kfdd.png
자료: 한동원 외, 설비공학논문집 22(10), 2010
:::

## 공간·데이터 정보 부재

**준공 후 납품되는 준공도서는 2D 기반이고, 데이터 포인트 연동은 사람이 수행합니다.**

포인트 1개당 연동 비용은 초기 230달러, 5년 보유 시 1,880달러로 인용됩니다.

::: figure 논문 원문 | 준공도서는 현행 2D 기반
image: ../../human/explanation/research/img/b-kbim4.png
자료: BIM을 이용한 시설물 유지관리 방안, 2013 학술대회
:::

<div></div>

::: figure 논문 원문 | 포인트 태깅 수작업과 1개당 비용
image: ../../human/explanation/research/img/b-ashb.png
자료: ASHB Intelligent Buildings 2020(IS-2020-108), Granderson 외 인용
:::

## 제도·인력 공백

**연면적 1만㎡ 이상 건축물 등은 유지관리자를 선임하고 매년 성능점검을 받아야 하지만, 보고서가 형식 요건만 갖춘 사례가 있습니다.**

::: figure 서울시 안내 원문 | 유지관리자 선임 대상 건축물
image: ../../human/explanation/img/e-seoul-law.png
자료: 서울시 기계설비유지관리자 선임 안내(2026-07-01 수정)
:::

<div></div>

::: figure 서울시 발표 원문 | 성능점검 보고서가 형식 요건만 충족
image: ../../human/explanation/research/img/b-seoul-manual.png
자료: 서울시 기계설비 성능점검 표준 매뉴얼 발표
:::

**국토교통부는 제도 실효성 부족을 과제로 언급했고, 유지관리 인력의 약 70%가 50~60대라는 보도가 있습니다.**

인력 비율 보도는 통계 원출처를 표시하지 않았습니다.

::: figure 인터뷰 원문 | 제도 실효성 부족과 업무 비효율
image: ../../human/explanation/img/e-kharn.png
자료: 한국건설기계설비신문, 국토교통부 건설산업과장 인터뷰(2026)
:::

<div></div>

::: figure 보도 원문 | 유지관리 인력 70%가 50~60대, 임시 자격 약 2.9만 명
image: ../../human/explanation/research/img/b-aging.png
자료: 다음 콘텐츠(2026), 통계 출처 미표시
:::

다음 단원은 이 문제에 대한 기존 솔루션과 그 한계입니다.

# 기존 솔루션과 차별점

## 시장 유형 5가지

**도면 3D 변환, BIM·스캔 트윈, 고장 진단 소프트웨어, 제조사 원격 관리, 현장 AR은 각각 정비 흐름의 1~3단계만 담당합니다.**

::: figure 시장 유형별 담당 범위 | 도면부터 현장 조치까지 5단계 기준
image: ../../human/explanation/img/d-p-market.png
자료: 업체 공식 자료와 보도, 부록 자료 목록
:::

::: table 유형별 업체와 시장 근거
| 유형 | 업체 | 시장 근거 |
|---|---|---|
| 도면 3D 변환 | 어반베이스, Planner 5D | 어반베이스는 국내 아파트 도면 약 80% 보유(2019 보도) |
| BIM·스캔 기반 트윈 | Autodesk Tandem, Matterport, ioFM, 이에이트, Willow | Tandem은 BIM Collaborate Pro 구독에 포함 |
| 고장 진단 소프트웨어 | SkySpark, Clockworks, Facilio | 공조 최적화 소프트웨어 46억 달러(2026)→67억 달러(2031) |
| 제조사 원격 관리 | LG 비콘클라우드, 삼성 스마트싱스 프로 | 하이엠솔루텍 원격 유지보수 1만 773곳(2026-06) |
| 현장 AR 지원 | 버넥트 | AR 매뉴얼 제작비 95% 절감 주장 |
주: 시장 규모는 Memoori 유료 보고서 요약, 하이엠솔루텍과 버넥트 수치는 회사 측 주장
:::

**도면 3D 변환 제품은 주거·인테리어용이고, 3D 촬영 제품은 현장 스캔이 필요합니다.**

::: figure 보도 원문 | 어반베이스, 2D 도면에서 몇 초 만에 3D
image: ../../human/explanation/research/img/m-urbanbase.png
자료: 비즈워치, 2019-03-22
:::

::: figure 제품 화면 | Planner 5D 도면 3D 변환
image: ../../human/explanation/research/img/m-planner5d.png
자료: planner5d.com(2026-11-19 캡처)
:::

::: figure 제품 화면 | Matterport 시설 관리
image: ../../human/explanation/research/img/m-matterport.png
자료: matterport.com(2026-11-19 캡처)
:::

::: figure 제품 화면 | 이에이트 디지털트윈
image: ../../human/explanation/research/img/c-e8.jpg
자료: 이에이트 홈페이지(2026-11-18 캡처)
:::

**고장 진단 제품은 설비별 사전 정의 포인트에 규칙을 적용하고, 제조사 제품은 자사 설비를 진단합니다.**

::: figure 백서 원문 | 사전 작성 규칙 기반 고장 진단
image: ../../human/explanation/research/img/m-sky.png
자료: SkyFoundry, Understanding the Data Oriented Tools Available to Facility Managers
:::

<div></div>

::: figure 보도자료 원문 | LG전자 AI 고장예측 기능
image: ../../human/explanation/research/img/m-lg.png
자료: LG전자 보도자료, 2024-02-20
:::

<div></div>

::: figure 배포 안내 원문 | IT·OT 데이터 수집부터 시작하는 구축 절차
image: ../../human/explanation/research/img/m-willow.png
자료: Willow, The Willow Deployment Journey
:::

## 업체별 부족한 점

**3D 트윈은 BIM·스캔·모델링을 시작 조건으로 요구하고, 고장 진단은 공간 맥락이 없으며, 제조사 원격 관리는 자사 모델에 한정됩니다.**

회색 칸은 공개 자료에서 확인하지 못한 기능입니다.

::: figure 업체별 기능과 부족한 점 | 3D 생성 입력, 데이터 연결, 원인 진단, 현장 겹쳐보기
image: ../../human/explanation/img/d-p-gaps.png
자료: 업체 공식 자료와 보도(2026-11-19 기준), 판매 기업 자료 포함
:::

::: table 부족한 점의 근거
| 업체 | 부족한 점 | 근거 |
|---|---|---|
| Autodesk Tandem | Revit·IFC 입력, DWG 베타. BIM이 없으면 스캔 후 BIM 작성 | Autodesk 포럼 Q&A(2024) |
| Matterport | 현장 3D 스캔 필요. 진단은 급증 알림 수준 | Matterport 시설 관리 글 |
| ioFM | 문서를 3D로 바꾸는 모델링 서비스, 방 단위 과금 | Siemens 제품 페이지 |
| 이에이트 NDX PRO | 현장별 구축과 운영은 파트너사 담당 | 2026-07 SaaS 전환 보도 |
| Willow | IT·OT 데이터 수집 후 단일 테넌트 Azure 구축 | Willow 배포 안내 |
| SkySpark 등 | 규칙은 설비별 사전 정의 포인트에 한정 | SkyFoundry 백서 |
| LG 비콘클라우드 | 2024 발표 지원 모델 Multi V Super 4·5, MULTI V i | LG전자 보도자료 |
| 버넥트 | AR 매뉴얼·원격 협업 중심, 진단 연동 미확인 | 에너지경제 보도 |
:::

## 차별점

**Maestro는 2D 도면 1장에서 시작해 원인 후보를 3D 위치와 현장 화면에 연결합니다.**

차별점 4가지는 구현 전 계획이며, 해커톤 시연에서 아래 지표로 측정합니다.

::: figure 차별점 4가지 | 시작 조건, 진단 결과, 설비 범위, 현장 연결
image: ../../human/explanation/img/d-p-diff.png
자료: Maestro 팀
:::

::: table 차별점 검증 지표
| 차별점 | 측정 지표 | 비교 기준 |
|---|---|---|
| 2D 도면 1장 시작 | 도면 1장의 3D 생성 시간, 교정 횟수 | 수작업 3D화 약 1개월(어반베이스 대표 발언, 2019) |
| 3D 위치와 원인 후보 | LBNL 고장 라벨 대비 원인 후보 상위 3개 적중률 | 목표 미정 |
| 제조사 무관 연결 | 연결한 설비 종류 수 | MVP 목표 5종 |
| 현장 겹쳐보기 | 경보 1건당 원인 확인 단계 수 | 목표 미정 |
:::

다음 단원은 차별점을 구현하는 서비스의 구성과 사용 장면입니다.

# 서비스 정의

## 한 장으로 보는 서비스

**서비스는 도면 한 장으로 3D 트윈을 만들고, 실측과 기대값의 차이로 고장 원인을 찾습니다.**

::: figure 서비스 개념도 | 도면에서 운전 추천까지 6단계, 사용자는 정비 기술자
image: ../../human/explanation/img/d-p-concept.png
자료: Maestro 팀
:::

::: table 이상 요건 5개와 MVP 범위
| 이상 요건 | 내용 | MVP 범위 |
|---|---|---|
| 1. 도면 자동 인식 | 2D 도면에서 벽, 공간, 설비 기호와 태그 인식 | 기호 5종 이내, 기술자 교정 화면 |
| 2. 3D 생성과 설비 배치 | 벽 높이 생성, 설비 3D 모델 자동 배치 | 단층 기계실 |
| 3. 상태·사용량 표시 | 설비 상태 색, 전력·온도·유량, 데이터 기준 시각 | 웹 3D 화면 |
| 4. 겹쳐보기와 고장 원인 | 실측과 기대값의 잔차, 원인 후보 순위, 점검 절차 | 공조기 고장 5종 |
| 5. 최적 운전 추천 | 설정값 변경안과 절감·쾌적 효과 | 규칙 기반 추천 1종 |
:::

## 사용 시나리오

**정비 기술자는 사무실 웹에서 원인을 좁히고, 현장 태블릿에서 같은 정보로 점검합니다.**

알림 확인, 3D 위치 확인, 실측·기대값 비교, 원인 후보 확인, 현장 AR 확인, 조치 기록과 운전 추천 순서입니다.

::: figure 정비 기술자 사용 시나리오 | 알림부터 조치 기록까지 6단계
image: ../../human/explanation/img/d-p-scenario.png
자료: Maestro 팀
:::

## 화면 예시

**메인 화면은 3D 기계실, 원인 후보 패널, 실측·기대값 그래프, 운전 추천을 한 화면에 배치합니다.**

설비 색은 디자인 시스템의 상태 토큰(정상, 주의, 위험, 정지)을 쓰고, 데이터 기준 시각을 상단에 표시합니다.

::: figure 웹 메인 화면 예시 | 선택한 공조기의 원인 후보, 근거, 점검 절차
image: ../../human/explanation/img/d-p-mock.png
주: 설비명과 수치는 설명용 가상 데이터
자료: Maestro 팀
:::

**AR 화면은 설비에 붙인 마커를 태블릿 카메라로 인식해 같은 정보와 점검 위치를 겹쳐 표시합니다.**

iPhone Safari는 WebXR AR을 지원하지 않아 이미지 추적 방식을 사용합니다.

::: figure AR 겹쳐보기 예시 | 마커 인식 후 상태, 원인 후보, 점검 위치 표시
image: ../../human/explanation/img/d-p-ar.png
주: 확장 기능. 설비명과 수치는 설명용 가상 데이터
자료: Maestro 팀
:::

다음 단원은 이 서비스를 구현하는 처리 흐름과 구조입니다.

# 시스템 설계

## 처리 흐름

**처리 흐름은 입력, 인식, 3D 생성, 데이터 연결, 표시, 겹쳐보기·진단, 운전 추천 7단계입니다.**

인식 결과는 기술자가 교정 화면에서 수정한 뒤 3D 생성으로 넘어갑니다. 자동 인식 오류가 3D와 진단으로 전파되지 않게 하기 위함입니다.

::: figure 7단계 처리 흐름 | 단계별 입력, 처리, 출력, MVP 범위
image: ../../human/explanation/img/d-p-pipeline.png
자료: Maestro 팀
:::

## 시스템 구조와 기술 스택

**구조는 화면, API, AI·계산, 데이터 4계층이며, 기술 스택은 팀 확인 전 권장안입니다.**

::: figure 시스템 구조 | 화면, API, AI·계산, 데이터 4계층
image: ../../human/explanation/img/d-p-arch.png
자료: Maestro 팀
:::

::: table 기술 스택 권장안
| 계층 | 권장안 | 이유 | 대안 |
|---|---|---|---|
| 웹 화면 | React, TypeScript, three.js(react-three-fiber) | 웹에서 3D와 대시보드를 함께 구현 | Unity WebGL |
| API | Python FastAPI, WebSocket | AI 모듈과 같은 언어 | Node.js |
| 도면 인식 | 분할 모델(CubiCasa5K 사전학습), 기호 검출(YOLO 계열), OCR | 공개 데이터와 코드 존재 | 비전 언어 모델 |
| 고장 진단 | 정상 모델 회귀, APAR 계열 규칙, 분류 모델 | 근거 설명 가능 | 딥러닝 단일 모델 |
| 데이터 | PostgreSQL, 파일 저장소 | 공간 그래프와 시계열 저장 | SQLite(시연 한정) |
| AR(확장) | MindAR 이미지 추적, WebXR(Android) | iPhone Safari WebXR AR 미지원 | 네이티브 앱 |
| BIM(확장) | That Open Components, web-ifc | MIT 라이선스 v3, IFC 읽기·쓰기 | IfcOpenShell |
:::

## 데이터 모델

**공간과 설비는 건물, 층, 실, 설비, 데이터 포인트 5단계 그래프로 저장하고 Brick 클래스를 붙입니다.**

LBNL 고장 데이터셋은 Brick 스키마 파일을 함께 제공하므로 포인트 매핑을 직접 시연할 수 있습니다.

::: figure 데이터 모델 | 건물에서 데이터 포인트까지 1:N 5단계
image: ../../human/explanation/img/d-p-datamodel.png
자료: Maestro 팀
:::

## 고장 진단

**정상 운전 모델의 기대값과 실측값의 차이가 일정 시간 이상 커지면 이상 구간으로 판정합니다.**

이상 구간은 운전 모드별 전문가 규칙과 고장 라벨로 학습한 분류 모델로 해석하고, 두 결과를 합쳐 원인 후보 순위를 만듭니다. LLM은 근거 설명 문장에만 선택적으로 쓰며, 사용 전에 비용을 점검합니다.

::: figure 고장 진단 흐름 | 실측, 기대값, 잔차, 규칙·분류, 원인 후보
image: ../../human/explanation/img/d-p-fdd.png
자료: Maestro 팀
:::

::: table 진단 방법 비교
| 방법 | 장점 | 한계 |
|---|---|---|
| APAR 계열 규칙 | 근거 설명 쉬움, 학습 데이터 불필요 | 계측 포인트가 부족하면 적용 규칙 감소 |
| 분류 모델 | 고장별 확률 제공 | 학습 데이터(시뮬레이션) 외 상황에 약함 |
| 정상 모델 잔차 | 고장 종류와 무관하게 이상 탐지 | 원인 구분은 규칙·분류가 담당 |
:::

## 운전 추천

**MVP는 냉수 공급 온도와 냉동기 운전 대수 같은 설정값을 규칙으로 추천하고 효과를 단순 계산으로 표시합니다.**

확장 단계에서는 BOPTEST 시뮬레이터로 추천안을 실행해 에너지와 쾌적 지표를 비교합니다. 추천은 기술자가 검토하며, 서비스가 설비를 직접 제어하지 않습니다.

다음 단원은 이 설계의 근거가 되는 데이터와 기술입니다.

# 데이터와 기술 근거

## 도면 인식 데이터

**CubiCasa5K는 도면 5,000장에 80개 이상 분류를 다각형으로 표시한 공개 데이터셋입니다.**

핀란드 주거 평면 중심이라 기계실 도면에는 추가 학습과 교정이 필요합니다. 기계실 설비 기호 공개 데이터셋은 확인하지 못했습니다.

::: figure CubiCasa5K 그림 1 | 원본 도면, 라벨, 자동 예측
image: ../../human/explanation/img/e-cubi.png
자료: Kalervo 외, CubiCasa5K(arXiv 1904.01920)
:::

::: table 도면 인식 자료
| 자료 | 내용 | 비고 |
|---|---|---|
| CubiCasa5K | 5,000장, 학습 4,200·검증 400·테스트 400 | 주거 평면, 저장소 라이선스 확인 필요 |
| 건설 도면 기호 검출(Jamieson 외 2024) | 배관·공조 도면에서 검출기 비교 | 데이터 공개 여부 미확인 |
| P&ID 기호 데이터 | 기호 48종, 7,728개 | 석유·가스 분야 |
| FloorplanVLM | 비전 언어 모델로 도면을 좌표 JSON으로 변환 | 대안 경로 |
:::

## 고장 데이터와 진단 규칙

**LBNL은 상업용 공조 설비 7종의 고장·정상 시계열과 고장 라벨을 공개합니다.**

단일 덕트 공조기는 고장 5종, 냉동기 플랜트는 고장 7종이며 각각 1년 시뮬레이션 데이터입니다. 라이선스는 CC BY입니다.

::: figure LBNL 데이터 페이지 원문 | 고장·정상 상태의 라벨된 공조 시계열
image: ../../human/explanation/img/e-lbnl.png
자료: LBNL Fault Detection and Diagnostics
:::

**NIST APAR는 공조기 고장을 질량·에너지 보존에서 유도한 전문가 규칙 28개로 탐지합니다.**

계측 포인트가 부족하면 적용 규칙이 줄어, 한 비교 연구에서는 52개 문제 중 10개만 탐지했습니다.

::: figure NIST 논문 초록 원문 | 운전자가 놓치는 공조기 문제를 단순 규칙으로 탐지
image: ../../human/explanation/img/e-nist.png
자료: NIST, An Expert Rule Set for Fault Detection in Air-Handling Units
:::

## 시뮬레이터와 AR

**BOPTEST는 REST API와 Docker로 실행하는 건물 공조 시뮬레이터이고, AR은 기기별 지원 차이가 있습니다.**

::: table 확장 기술의 제약
| 기술 | 내용 | 제약 |
|---|---|---|
| BOPTEST | 공조 제어 알고리즘 테스트 시뮬레이터, 공개 서버와 로컬 Docker | 2024-11 기준 공개 테스트 건물 8개 |
| WebXR | Android Chrome에서 AR 지원 | iPhone Safari는 WebXR AR 미지원(2026 자료) |
| 이미지 추적(MindAR 등) | 카메라 영상에서 마커 추적 | 라이브러리 기능은 공식 문서 확인 필요 |
:::

마지막 단원은 해커톤 기간에 구현할 범위와 순서입니다.

# 범위와 일정

## MVP와 단계

**MVP는 시연에 반드시 필요한 6개 항목이며, 단계 0~4를 MVP로 고정합니다.**

해커톤 종료일이 확인되지 않아 일정은 단계 순서로만 정했습니다.

::: figure MVP 범위와 단계 | MVP 6개, 확장 6개, 단계 6개
image: ../../human/explanation/img/d-p-scope.png
자료: Maestro 팀
:::

## 요구사항

**기능 요구사항 15개 중 11개가 MVP이며, 각 요구사항에 완료 기준을 정했습니다.**

::: table 기능 요구사항
| ID | 기능 | 범위 | 완료 기준 |
|---|---|---|---|
| FR-01 | 도면 업로드와 축척 지정 | MVP | 샘플 도면 2장 업로드 후 축척 입력 |
| FR-02 | 벽·문·창 인식과 벡터화 | MVP | 벽이 폴리라인으로 표시 |
| FR-03 | 실 분할과 실명 OCR | MVP | 실 이름 표시 |
| FR-04 | 설비 기호 검출과 태그 OCR | MVP | 5종 중 기호와 태그 인식 |
| FR-05 | 인식 결과 교정 화면 | MVP | 벽·실·설비 추가, 삭제, 이동, 종류 변경 |
| FR-06 | 3D 생성 | MVP | 층고 반영 벽·바닥 3D 표시 |
| FR-07 | 설비 3D 자동 배치 | MVP | 기호 위치와 방향에 모델 배치 |
| FR-08 | 설비와 데이터 포인트 연결 | MVP | LBNL 포인트를 Brick 클래스로 연결 |
| FR-09 | 상태·사용량 표시 | MVP | 상태 색, 주요 값, 데이터 기준 시각 |
| FR-10 | 실측·기대값 겹쳐보기 | MVP | 3D 색과 그래프에 실측, 기대값, 잔차 구간 |
| FR-11 | 고장 원인 후보 | MVP | 공조기 고장 5종 후보 순위, 확률, 근거 |
| FR-12 | 점검 절차와 조치 기록 | MVP | 점검 순서 표시, 실제 원인과 조치 저장 |
| FR-13 | 최적 운전 추천 | MVP 1종 | 변경안과 예상 효과 표시, 직접 제어 없음 |
| FR-14 | AR 겹쳐보기 | 확장 | 마커 인식 후 상태와 점검 위치 표시 |
| FR-15 | 시나리오 재생 | MVP | 정상·고장 시나리오 선택 후 재생 |
주: 비기능 요구사항은 부록
:::

## 위험과 결정 필요 항목

**가장 큰 위험은 기계실 도면·설비 기호 공개 데이터 부족이며, 팀이 정할 항목은 4개입니다.**

::: table 위험과 대응
| 위험 | 영향 | 대응 |
|---|---|---|
| 기계실 도면·기호 공개 데이터 부족 | 인식 모델 학습 데이터 부족 | 샘플 도면 직접 작성, 기호 5종 소량 라벨링, 교정 화면 |
| 주거 평면 모델의 기계실 적용 오차 | 벽·실 인식 오류 | 교정 화면, DXF 입력 확장 |
| LBNL 데이터는 시뮬레이션 기반 | 현장 데이터와 차이 | 발표에서 시뮬레이션 데이터 표시 |
| 해커톤 기간 미확인 | 범위 조정 필요 | 단계 0~4를 MVP로 고정 |
:::

::: table 다음 작업
| 작업 | 기한 | 담당 |
|---|---|---|
| 기술 스택 권장안 확인과 기술 선택 기록 작성 | 미정 | 팀 전체 |
| `_maestro` 독립 Git 저장소 초기화와 원격 저장소 연결 | 미정 | 미정 |
| 샘플 기계실 도면 1~2장 작성, 설비 기호 라벨링 | 미정 | 미정 |
| LBNL 단일 덕트 공조기 데이터 내려받기와 고장 5종 확정 | 미정 | 미정 |
| 해커톤 기간 확인 후 단계별 기한 지정 | 미정 | 미정 |
| 차별점 검증 지표의 측정 방법과 목표값 확정 | 미정 | 미정 |
:::

# 부록 비기능 요구사항과 조사 자료 {.appendix}

::: table 비기능 요구사항
| ID | 항목 | 기준 |
|---|---|---|
| NFR-01 | 실시간 표시 지연 | 데이터 수신 후 2초 이내(목표, 미측정) |
| NFR-02 | 도면 인식 처리 시간 | 도면 1장 30초 이내(목표, 미측정) |
| NFR-03 | 화면 규칙 | 디자인 시스템 준수, 범례·단위·기준 시각 상시 표시 |
| NFR-04 | 화면 크기 | 웹 1440px, 태블릿 1024px |
| NFR-05 | 데이터 출처 표시 | 시뮬레이션·재생 데이터와 예측값 라벨 |
| NFR-06 | 추천의 한계 | 기술자 검토용, 설비 제어 명령 전송 없음 |
| NFR-07 | 비밀값 | API 키는 `.env`에만 보관, 커밋 금지 |
:::

::: table 조사 자료 목록 1: 국내 기사·기관, 국내 논문
| 번호 | 자료 | 확인 수준 |
|---|---|---|
| D1 | 서울시, 기계설비 성능점검 표준 매뉴얼 | 원문 캡처 |
| D2 | 서울시, 기계설비유지관리자 선임 안내 | 원문 캡처 |
| D3 | 스마트투데이, 서울시 성능점검 전문가 자문단 | 검색 발췌 |
| D4 | 한국건설기계설비신문, 국토부 건설산업과장 인터뷰 | 원문 캡처 |
| D5 | 한국건설기계설비신문, 기계설비성능점검협회장 인터뷰 | 검색 발췌, 업계 단체 |
| D6 | 한국건설기계설비신문, EMS협회장 인터뷰 | 원문 캡처(제목), 업계 단체 |
| D7 | 중앙일보(다음 전재), 하이엠솔루텍 AI 에러 알림(2026-06-25) | 원문 캡처 |
| D8 | 다음 콘텐츠, 기계설비법 유예와 유지관리 인력 | 원문 캡처, 통계 출처 미표시 |
| D9 | 한국건설기계설비신문, 임시등급 2027-04-17 연장 | 원문 텍스트 |
| K1 | BIM을 이용한 시설물 유지관리 방안(2013 학술대회) | 원문 캡처 |
| K2 | 시설물 유지관리를 위한 BIM 데이터 입력기준(설비공학논문집 2013) | 원문 캡처 |
| K3 | 유정호, COBie: 시설물 유지관리 정보교환체계 | 원문 텍스트 |
| K4 | 김도영 외, BIM 기반 시설물 유지관리 데이터 정의(KIBIM 2020) | 원문 텍스트 |
| K5 | 한동원 외, 정풍량 공조시스템 고장검출 및 진단(설비공학논문집 2010) | 원문 캡처 |
:::

::: table 조사 자료 목록 2: 해외 논문·보고서
| 번호 | 자료 | 확인 수준 |
|---|---|---|
| P1 | Katipamula, Brambley, ACEEE Summer Study 2008 | 원문 캡처 |
| P2 | Crowe 외, HVAC 고장 빈도 실증 분석(STBE 2023) | 초록 캡처 |
| P3 | LBNL, 고장 데이터 1,800만 행 분석 | 원문 텍스트 |
| P4 | 미국 에너지부, Smart Energy Analytics Campaign | 원문 캡처 |
| P5 | NREL, 소규모 상업 건물 AFDD 장벽(2018) | 원문 캡처 |
| P6 | Energy and Buildings 2024, FDD 도입 장벽(전문가 29명) | 원문 캡처 |
| P7 | ASHB 2020, BAS 포인트 자동 태깅 | 원문 캡처 |
| P8 | Lu 외, 트윈 기반 이상 탐지(Automation in Construction 2020) | 초록 캡처 |
| P9 | Liang 외, 합성 BIM 데이터셋 생성(Automation in Construction 2025) | 검색 발췌 |
| P10 | Cambeiro Barreiro 외, 2D 도면의 의미 3D 재구성(arXiv 2023) | 검색 발췌 |
| P11 | HAL Paris 8, 스캔 도면 기반 BIM 재구성 | 검색 발췌 |
| P12 | 준공 BIM 속성 체계 리뷰(ITcon 2024) | 검색 발췌 |
| P13 | 기존 건물 BIM 적용 과제(SBTIC) | 검색 발췌 |
| P14 | 시설 관리 AR·MR 체계적 리뷰(SASBE 2023) | 검색 발췌 |
| P15 | LBNL, 차세대 FDD 시장 장벽 | 검색 발췌 |
| P16 | CleanTechnica, PNNL 제어 개선 29% 절감(2017) | 2차 보도 |
:::

::: table 조사 자료 목록 3: 기업·시장 자료
| 번호 | 자료 | 확인 수준 |
|---|---|---|
| C1 | 비즈워치, 어반베이스(2019) | 원문 캡처 |
| C2 | Planner 5D 도면 3D 변환 페이지 | 화면 캡처 |
| C3 | Autodesk Tandem 포럼 Q&A(2024) | 검색 발췌 |
| C4 | Matterport 시설 관리 페이지 | 화면 캡처, 판매 기업 |
| C5 | Siemens, ioLabs ioFM 제품 페이지 | 검색 발췌, 판매 기업 |
| C6 | 보안뉴스 등, 이에이트 NDX PRO | 검색 발췌 |
| C7 | Willow 배포 안내 | 원문 캡처 |
| C8 | SkyFoundry 백서 | 원문 캡처, 판매 기업 |
| C9 | LG전자 AI 고장예측 보도자료(2024-02-20) | 원문 캡처 |
| C10 | 삼성 스마트싱스 프로(D7 기사 언급) | 검색 발췌 |
| C11 | 헬로티, 모넷코리아 공조 예지보전 | 검색 발췌 |
| C12 | 에너지경제, 버넥트 AR | 검색 발췌, 회사 수치 |
| C13 | Memoori, HVAC 최적화 보고서 2026 | 검색 발췌, 유료 보고서 |
:::

::: table 제외 자료 13건
| 자료 | 제외 사유 |
|---|---|
| Oxmaint 블로그 2건 | 판매 기업 수치, 방법론 미표시 |
| Marketintelo FDD 시장 보고서 | 성장률 표기와 양 끝값 불일치 |
| HVAC 소프트웨어 시장 보고서 4종 | 범위 상이, 2025년 규모 7억~32억 달러 편차 |
| Coohom 도면 변환 비교 글 | 기능 유무 서술 모순 |
| AROMA-FF AR 현장 실험 | 원문 주소 미확인 |
| 설비저널 2015 AHU FDD 리뷰 | 원문 주소 미확정 |
| 서울신문 2001 노후 건축물 | 주제 불일치 |
| Kode Labs FDD 문서 | 다른 제품 문서 |
| 안효경 외 2013 BIM 유지관리 논문 | 관련 문장 미발견 |
주: 자료 주소는 docs/human/explanation/research/maintenance-background-market.md 7절
:::

::: table 기술 자료 주소
| 자료 | 주소 |
|---|---|
| CubiCasa5K | arxiv.org/abs/1904.01920 |
| LBNL FDD 데이터 | faultdetection.lbl.gov/data |
| NIST APAR | nist.gov/publications/expert-rule-set-fault-detection-air-handling-units |
| BOPTEST | github.com/ibpsa/project1-boptest |
| That Open Components | github.com/ThatOpen/engine_web-ifc |
| WebXR 지원 현황 | abratabia.com/webxr-games/webxr-device-support.php |
주: 문서 원본은 docs/human/explanation/service-plan.md, architecture.md, docs/human/reference/requirements.md
:::
