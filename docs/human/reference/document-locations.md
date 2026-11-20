# 원본 문서 위치

> **요약** (기준일 2026-11-18)
>
> - 같은 설명은 원본 1곳에만 작성하고 나머지는 링크로 연결
> - PDF 보고서는 `docs/reports/`의 Markdown 원본에서 생성하는 출력물
>
> **다음 작업**: 없음

내용을 수정할 때 기준이 되는 원본 파일 목록입니다. 같은 설명이 여러 곳에 있으면 이 표의 원본을 수정하고 나머지는 원본으로 연결하십시오.

| 내용 | 원본 위치 | 담당 영역 |
|---|---|---|
| 문서 작성 기준 | `docs/human/how-to/write-docs.md` | 전체 |
| 장애 조사 기록 | `docs/human/explanation/troubleshooting/` | 조사한 담당자 |
| AI 작업 규칙 | 각 저장소의 `AGENTS.md` | 해당 저장소 |
| AI가 참고할 문서 목록 | `docs/ai/sources.json` | 해당 작업 |
| 과거 보고서·초안 | `docs/human/archive/` | 작성한 담당자 |
| 시각 디자인 가이드 | `DESIGN.md` | 프론트엔드 |
| 데이터 시각화·상태 규칙 | `docs/human/reference/design-system.md` | 프론트엔드 |
| 서비스 기획 | `docs/human/explanation/service-plan.md` | 팀 전체 |
| 시스템 설계 | `docs/human/explanation/architecture.md` | 개발 |
| 기능·비기능 요구사항 | `docs/human/reference/requirements.md` | 팀 전체 |
| 외부 조사 기록 | `docs/human/explanation/research/` | 조사한 담당자 |
| 기술 선택 기록 | `docs/human/explanation/decisions/` | 결정한 담당자 |
| PDF 보고서 원본 | `docs/reports/<날짜-주제>/report.md` | 작성한 담당자 |
| 조사 이미지(원문 캡처, 도식) | `docs/human/explanation/research/img/` | 작성한 담당자 |

프로젝트에 맞게 행을 추가하십시오. 구체적인 담당자는 팀에서 배정합니다.

## 위치 고정 파일

`README.md`, `AGENTS.md`, `CLAUDE.md`는 사람과 도구가 가장 먼저 찾는 파일이므로 저장소 루트에 있어야 합니다. 라이선스와 에셋 출처는 관련 파일과 같은 위치에 있어야 합니다.

## 문서와 코드 불일치 시 기준

현재 동작의 근거는 해당 버전의 코드·설정·테스트입니다. 팀이 의도한 규칙은 작업 지침과 정책 문서에서 확인하십시오. 두 내용이 다르면 그 차이를 수정하거나 논의하십시오. 확인하지 않은 운영 상태는 미확인 정보로 취급하십시오.
