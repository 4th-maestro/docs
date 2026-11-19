---
title: Maestro 팀 합류 안내
subtitle: 2026년 11월
org: Maestro 팀
code: 작업 규칙과 프로젝트 구조
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

# 이 안내의 전제 {.front}

- **[대상]**

  처음 합류한 팀원과, 팀원이 함께 쓰는 AI 코딩 도구입니다.

⇒ 사람과 AI는 같은 규칙을 따릅니다. 규칙 원본은 저장소 루트의 `AGENTS.md`입니다.

- **[기준 시점]**

  2026-11-18 기준의 `AGENTS.md`와 폴더 구조를 요약했습니다.

⇒ 규칙이 바뀌면 `AGENTS.md`가 우선합니다. 이 안내의 원본은 `docs/human/tutorials/first-day.md`입니다.

- **[현재 단계]**

  해커톤 시작 전 조사·규칙 단계이며, 코드는 아직 없습니다.

⇒ 코드 폴더 구조와 저장소 공유 방식은 주제 확정과 함께 정합니다.

# 요약 {.front}

::: summary
- Maestro는 해커톤 "AI 디지털트윈 기반 공간 가시화 및 운영 최적화" 프로젝트입니다.
  - 지금까지 조사 보고서 2건, 디자인 시스템, 작업 규칙을 만들었고, 주제 후보 6개 중 선택이 남아 있습니다.
- 모든 작업은 `AGENTS.md`의 규칙 11개를 따르며, 그중 5개는 작업 완료 조건입니다.
  - 완료 조건은 UI 비율 확인, 문서 갱신과 검사 통과, 조사·기술 선택·장애 기록입니다.
- 첫날에는 규칙과 조사 보고서를 읽고, 도구를 설치하고, 저장소 공유 방식을 정합니다.
  - 현재 `_maestro`는 독립 Git 저장소가 아니어서 공유 전에 저장소 초기화가 필요합니다.

| 항목 | 현재 값 | 비고 |
|---|---|---|
| 해커톤 시작일 | 2026-11-19 | 종료일, 심사 기준 미확인 |
| 검사 대상 Markdown | 19개 | 문서 검사 오류 0건(2026-11-18) |
| PDF 보고서 | 3건 | 해외 동향, 한국 주제 6가지, 이 안내 |
| 주제 후보 | 6개 | 19점 동점 3개(인파 리허설, 따릉이 재배치, 빈 공간 매칭) |
| 코드·저장소 | 없음 | 주제 확정 후 결정 |
:::

# 프로젝트 한눈에 보기

## Maestro와 해커톤 현황

**해커톤은 2026-11-19에 시작하며, 현재는 주제 선정 전 조사·규칙 단계입니다.**

공고의 기간, 제공 데이터, 심사 기준은 아직 확인하지 못했습니다. 확인한 값은 `docs/human/README.md` 1절 표에 기록합니다.

::: table 해커톤 개요
| 항목 | 값 |
|---|---|
| 주제 | AI 디지털트윈 기반 공간 가시화 및 운영 최적화 |
| 시작일 | 2026-11-19 |
| 종료일, 주최, 제공 데이터, 심사 기준 | 미정(공고 확인 전) |
:::

**지금까지 만든 산출물은 조사 보고서 2건, 디자인 시스템, 작업 규칙입니다.**

조사 보고서는 주제 후보 6개와 경쟁·시장을 정리했고, 디자인 시스템은 화면 색·버튼·시각화 규칙의 초기값입니다.

::: table 현재 산출물
| 문서 | 위치 | 내용 |
|---|---|---|
| 작업 규칙 | `AGENTS.md` | 사람과 AI가 따르는 규칙 11개 |
| 한국 공간 문제와 주제 6가지 | `docs/human/explanation/research/korea-space-topics.md` | 주제 후보 6개, 공공데이터, 경쟁·시장, 평가 |
| 디지털트윈 조사 | `docs/human/explanation/research/digital-twin-survey.md` | 해외 기술 동향, 논문, 경쟁 제품 |
| 디자인 시스템 | `docs/human/reference/design-system.md` | 색 토큰, 버튼 높이, 공간 시각화 규칙 |
| 문서 작성 안내 | `docs/human/how-to/write-docs.md` | 보고서 형식, 말투, PDF 생성 절차 |
| PDF 보고서 | `docs/reports/` | 위 조사 문서의 발표·공유용 출력물 |
:::

## 폴더 구조

**모든 문서는 `docs/` 아래 사람용, AI용, PDF 보고서 세 영역에 있습니다.**

사람용 문서가 원본이고, AI용 문서와 PDF는 원본으로 연결하거나 원본에서 생성합니다. 코드 폴더는 주제 확정 후 추가합니다.

::: figure 프로젝트 폴더 구조 | 사람용 원본, AI 안내, PDF 출력물, 도구 4가지로 구분
image: ../../human/tutorials/img/d-o-tree.png
자료: 2026-11-18 기준 저장소
:::

다음 장은 새 문서를 쓸 때 어느 폴더에 어떤 형식으로 쓰는지 설명합니다.

# 문서 체계

## 무엇을 어디에 쓰나

**문서 폴더는 독자가 문서를 여는 목적으로 정하고, 같은 설명은 원본 1곳에만 씁니다.**

이미 같은 설명이 있으면 새 파일을 만들지 않고 원본을 고칩니다. 원본 위치 목록은 `docs/human/reference/document-locations.md`에 있습니다.

::: figure 문서 종류와 폴더 | 목적별 폴더 7개, AI 안내와 PDF는 원본으로 연결
image: ../../human/tutorials/img/d-o-docmap.png
자료: docs/human/how-to/write-docs.md 2절
:::

## 문서 형식

**모든 사람용 문서는 보고서 형식이며, 첫 화면에 결론을 씁니다.**

형식의 기준은 한국은행 「경제전망」의 구성입니다. 독자가 요약과 소제목만 읽어도 결론과 할 일을 알 수 있어야 합니다.

::: figure 보고서 형식 문서의 구성 | 요약, 절 제목, 주장 문장, 표, 다음 작업 6가지 요소
image: ../../human/tutorials/img/d-o-format.png
자료: AGENTS.md 문서 형식, docs/human/how-to/write-docs.md 1절
:::

**말투는 설명 `~입니다.`, 절차 `~하십시오.`, 표와 목록은 명사형입니다.**

비유, 번역투, 긴 대시를 쓰지 않습니다. 제목은 명사형이며 질문형 제목을 쓰지 않습니다.

::: table 말투 예시
| 피할 표현 | 고친 표현 |
|---|---|
| 다섯 가지 상태를 나눠 준다 (제목) | 응답 상태 |
| 아직 답이 없다 (표 칸) | 아직 응답을 받지 못함 |
| 서버가 넘어졌다 | 서버 오류 |
| 사용하고 있습니다 | 사용합니다 |
| 이 5개가 전부입니다 | (삭제) |
자료: docs/human/how-to/write-docs.md 4절
:::

## 기록 3종

**조사, 기술 선택, 장애는 날짜별 기록으로 남기고 과거 사실을 고치지 않습니다.**

비교 결과나 조사 결과를 대화와 PR 본문에만 남기지 않습니다. 다음 담당자가 같은 조사를 반복하지 않게 하는 문서입니다.

::: figure 기록 3종의 작성 시점과 위치 | 조사·기술 선택·장애, 각각 별도 폴더
image: ../../human/tutorials/img/d-o-records.png
자료: AGENTS.md, 각 폴더 README.md
:::

문서 체계 다음은 코드와 문서 작업 전체에 적용되는 규칙입니다.

# 작업 규칙

## AGENTS.md 규칙 11개

**규칙은 11개이고, 그중 5개는 작업 완료 조건에 포함됩니다.**

완료 조건 규칙을 지키지 않은 작업은 완료로 보고하지 않습니다. 초록 테두리 카드가 완료 조건입니다.

::: figure AGENTS.md 규칙 11개 | 초록 테두리 5개가 완료 조건
image: ../../human/tutorials/img/d-o-rules.png
자료: AGENTS.md
:::

## 작업 흐름

**작업은 요청 확인부터 PR까지 7단계이며, PR 생성과 머지는 사람이 합니다.**

AI 도구도 같은 흐름을 따르며, 요청이 없으면 커밋과 푸시까지만 수행합니다.

::: figure 작업 흐름 7단계 | 5단계 검사가 완료 조건, 7단계는 사람만 수행
image: ../../human/tutorials/img/d-o-flow.png
자료: AGENTS.md
:::

::: table 완료 보고 전 확인 목록
| 항목 | 확인 방법 |
|---|---|
| 요구사항 해석 | 결과가 갈리는 지점을 구현 전에 질문했는지 |
| 화면 | 같은 줄 버튼 높이 52 또는 40, 1440·390px 확인, 미확인 화면 보고 |
| 문서 | 바뀐 내용을 사람용 원본에 반영, 경로·명령 변경 시 AGENTS.md·sources.json 갱신 |
| 검사 | `check_docs.py --write-catalog`와 `check_docs.py` 오류 0건 |
| 기록 | 조사·비교·장애가 있었으면 해당 폴더에 기록과 목록 1줄 |
| 보고 | 갱신한 문서, 검사 결과, 실행하지 못한 검사를 구분해 보고 |
:::

## Git 규칙

**브랜치는 `<type>/<작업 내용>`, 커밋 제목은 짧은 명사형입니다.**

브랜치 이름과 커밋에 AI 도구 이름이나 흔적을 남기지 않습니다.

::: table Git 규칙과 예시
| 항목 | 규칙 | 예시 |
|---|---|---|
| 브랜치 | `<type>/<작업 내용>`, codex·claude 등 AI 도구 이름 금지 | `docs/human-ai-separation`, `feat/crowd-heatmap` |
| 커밋 제목 | 짧은 명사형 | `재실 히트맵 범례 단위 누락 수정` |
| 항목 나열 | 가운뎃점 대신 쉼표와 공백 | `feat(map): 범례, 기준 시각 표시` |
| 트레일러 | `Co-Authored-By` 등 AI 도구 흔적 금지 | 없음 |
| PR | 사람이 생성. 요청이 없으면 커밋·푸시까지 | 없음 |
| 비밀값 | API 키, 토큰, `.env` 커밋 금지 | 인증키는 로컬 `.env`에만 보관 |
주: type 예시(feat, fix, docs)는 일반 관례이며 AGENTS.md는 형식만 정함
:::

## UI와 디자인 규칙

**화면은 시맨틱 토큰만 쓰고, 파랑은 누를 수 있는 요소와 선택 항목에만 씁니다.**

색 값은 주제 확정 전 초기값이며, 바꿀 때는 디자인 시스템 문서를 먼저 고친 뒤 코드에 반영합니다.

::: table 주요 색 토큰
| 토큰 | 값 | 흰 바탕 대비 | 용도 |
|---|---|---|---|
| `primary` | #2563EB | 5.17:1 | 버튼, 링크, 선택 항목 |
| `ink` | #111827 | 17.74:1 | 제목, 본문 |
| `graphite` | #4B5563 | 7.56:1 | 보조 글자 |
| `statusNormal`, `statusCaution`, `statusDanger` | #15803D, #B45309, #B91C1C | 5.02:1 이상 | 정상, 주의, 위험 |
| `statusStale` | #6B7280 | 4.83:1 | 데이터 지연 |
자료: docs/human/reference/design-system.md 1절
:::

**공간 시각화 화면은 범례, 단위, 데이터 기준 시각을 항상 표시합니다.**

기준 시각이 갱신 주기의 2배를 초과하면 지연 상태로 표시합니다. 합성·예측 데이터는 실측과 다른 패턴과 라벨로 구분합니다.

::: table 화면에서 하지 않는 것
| 금지 | 이유·대안 |
|---|---|
| 유니코드 이모지 | 아이콘 라이브러리 1종(Lucide 권장)만 사용 |
| 제목 위 영문 라벨(eyebrow), 제목 아래 회색 설명 문장 | 장식 텍스트 금지. 필요한 정보는 본문·캡션으로 |
| 하드코딩 hex·px | 토큰 사용 |
| 한 화면에 채운 주 버튼 2개 이상 | 주 동작은 1개 |
| 오류·상태 문구 말줄임 | 읽고 판단할 글은 자르지 않음 |
| 색만으로 상태 표시 | 색, 아이콘, 글자 중 2가지 이상 |
자료: docs/human/reference/design-system.md 6~7절
:::

## AI 도구와 함께 일하기

**AI 도구는 `AGENTS.md`, `docs/ai/README.md`, `docs/ai/sources.json` 순서로 읽고 사람과 같은 규칙을 따릅니다.**

`CLAUDE.md`는 `@AGENTS.md` 한 줄로 같은 규칙을 불러옵니다. 제품 설명은 AI용 문서에 복사하지 않고 사람용 원본으로 연결합니다.

**독립 기능이 2개 이상이면 기능별 에이전트를 최대 4개까지 병렬로 배치합니다.**

에이전트마다 별도 worktree와 브랜치를 쓰고, 개발 서버·로컬 DB 같은 공유 자원과 머지는 주 작업자가 맡습니다. 에이전트를 배치하기 전에는 사용자에게 확인합니다.

::: table AI에게 작업을 맡길 때 확인할 것
| 확인 | 내용 |
|---|---|
| 질문 여부 | 해석이 갈리는 요구사항을 구현 전에 질문했는지 |
| 브랜치·커밋 | AI 도구 이름, `Co-Authored-By` 미포함 |
| 문서 | 기능 변경과 같은 작업에서 원본 문서 갱신 |
| 검사 | 실행한 검사와 실행하지 못한 검사를 구분해 보고 |
| 범위 | PR 생성, 머지, 배포는 사람이 수행 |
:::

마지막 단원은 실제로 쓰는 도구와 첫날 할 일입니다.

# 도구와 첫날

## 도구와 명령

**문서 검사는 Python만 있으면 되고, PDF 생성에는 devdog 저장소, Node.js, Chrome이 추가로 필요합니다.**

문서를 고치면 문서 검사 2개를 실행하고, 발표용 PDF가 필요할 때만 오른쪽 흐름을 사용합니다.

::: figure 문서 검사와 PDF 생성 흐름 | 검사 2개는 필수, 문체 검사와 PDF는 필요할 때
image: ../../human/tutorials/img/d-o-tools.png
자료: docs/human/how-to/write-docs.md 1절, 5절
:::

::: table 준비물
| 도구 | 용도 | 설치·경로 |
|---|---|---|
| Python 3.8 이상 | `scripts/check_docs.py` 문서 검사 | 표준 라이브러리만 사용 |
| devdog 저장소 | `report.py`(PDF 생성), `kolint.py`(문체 검사) | github.com/taehun2123/devdog 복제 |
| Node.js, Playwright | `capture.mjs`(원문 캡처), `render.mjs`(도식) | `PLAYWRIGHT` 환경변수로 설치 경로 지정 |
| Chrome | `report.py`의 PDF 출력 | 자동 탐색, 실패 시 `--chrome` 지정 |
| poppler(`pdffonts`) | PDF 내장 폰트 확인 | 선택 |
:::

**캡처·도식 스크립트의 Playwright 기본 경로는 작성자 PC 기준이라, 다른 PC에서는 환경변수를 지정해야 합니다.**

예: `PLAYWRIGHT=$(pwd)/node_modules/playwright/index.mjs node docs/reports/tools/capture.mjs ...`. 저장소 기준 경로로 바꾸는 작업은 다음 작업 표에 있습니다.

## 첫날 체크리스트

**첫날에는 규칙 읽기, 도구 설치, 조사 보고서 확인, 저장소 공유 방식 확정을 진행합니다.**

::: table 첫날 할 일
| 순서 | 할 일 | 확인 방법 |
|---|---|---|
| 1 | `AGENTS.md` 읽기 | 규칙 11개와 완료 조건 5개 설명 가능 |
| 2 | `docs/human/README.md`와 문서 작성 안내 읽기 | 새 문서의 폴더와 형식 선택 가능 |
| 3 | 한국 공간 문제와 주제 6가지 보고서 읽기 | 주제 후보 6개와 동점 3개의 차이 설명 가능 |
| 4 | Python, devdog, Node.js 준비 | `python3 scripts/check_docs.py` 오류 0건 |
| 5 | AI 도구에 저장소 열기 | AI가 `AGENTS.md`를 읽고 규칙을 요약하는지 확인 |
| 6 | 주제 선택 회의 참여 | 기술 선택 기록 1건 작성 |
:::

::: table 다음 작업
| 작업 | 기한 | 담당 |
|---|---|---|
| `_maestro` 독립 Git 저장소 초기화와 원격 저장소 연결 | 2026-11-19 | 미정 |
| 해커톤 공고 확인과 `docs/human/README.md` 개요 표 기록 | 2026-11-19 | 미정 |
| 공공데이터포털·서울 열린데이터광장 인증키 신청 | 2026-11-19 | 미정 |
| 주제 1~2개 선택과 기술 선택 기록 작성 | 2026-11-19 | 팀 전체 |
| 캡처·도식 스크립트의 Playwright 경로를 저장소 기준으로 변경 | 미정 | 미정 |
| 코드 폴더 구조 결정과 이 안내 갱신 | 주제 확정 후 | 미정 |
:::

# 부록 파일 목록과 용어 {.appendix}

::: table 주요 파일
| 파일 | 용도 |
|---|---|
| `AGENTS.md` | 작업 규칙 원본 |
| `CLAUDE.md` | `@AGENTS.md` 참조 한 줄 |
| `docs.config.json` | 문서 검사 설정(단일 저장소 구조) |
| `catalog.json` | 문서 제목·종류 목록. 검사기가 생성 |
| `scripts/check_docs.py` | 문서 검사기 |
| `.github/workflows/docs-check.yml` | PR·main 푸시 때 문서 검사 |
| `docs/human/README.md` | 사람용 문서 목차, 해커톤 개요 |
| `docs/human/how-to/write-docs.md` | 문서 형식, 말투, 검사, PDF 생성 |
| `docs/human/reference/design-system.md` | 색, 글꼴, 버튼, 공간 시각화 규칙 |
| `docs/human/reference/document-locations.md` | 내용별 원본 문서 위치 |
| `docs/ai/README.md`, `docs/ai/sources.json` | AI 작업 순서, 참고 파일 목록 |
| `docs/reports/<날짜-주제>/` | PDF 원본(report.md), PDF, 도식 원본 |
| `docs/reports/fonts/`, `docs/reports/tools/` | PDF 내장 폰트, 원문 캡처 도구 |
:::

::: table 용어
| 용어 | 뜻 |
|---|---|
| 원본 문서 | 같은 내용 중 수정 기준이 되는 문서 1개. 나머지는 링크 |
| 완료 조건 | 지키지 않으면 작업 완료로 보고하지 않는 규칙 |
| 보고서 형식 | 요약, 결론형 소제목, 비교 기준 수치, 다음 작업 표로 구성한 문서 형식 |
| 시맨틱 토큰 | 색 값 대신 용도 이름으로 쓰는 디자인 값. 예: `primary` |
| worktree | 같은 저장소를 브랜치별 별도 폴더로 여는 Git 기능 |
| Type 3 폰트 | PDF 뷰어에 따라 글자 표시가 손상되는 폰트 형식. 보고서에서 0건 유지 |
:::
