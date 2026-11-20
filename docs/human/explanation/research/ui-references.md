# 대시보드 UI 레퍼런스(UIbowl)

> **요약** (기준일 2026-11-20)
>
> - UIbowl MCP로 PC 대시보드, PC AI 채팅, 모바일 제어, AI 진행 표시를 8회 검색해 레퍼런스 18건을 확인함. 에너지 사용량, AI 답변 생성 검색은 0건
> - 대시보드에 4가지를 반영함: 핵심 수치 카드와 예시 데이터 안내 띠(클로브 AI), 입력창 아래 AI 주의 문구(잔디), AI 패널의 추천 질의 목록(채널톡), AI 해석 조건 칩과 진행 표시(리블, 2026-11-20 오후)
> - 무료 회원이라 검색당 결과 3건만 확인함
>
> | 검색어 | 플랫폼 | 전체 결과 | 확인 |
> |---|---|---:|---:|
> | 대시보드 | PC | 92건 | 3건 |
> | AI 채팅 | PC | 19건 | 3건 |
> | 제어 | 모바일 | 49건 | 3건 |
> | 분석 중(화면 문구, AI) | PC | 104건 | 3건 |
> | 로딩(AI 패턴) | PC | 54건 | 3건 |
> | 프로그레스 인디케이터(AI 패턴) | PC | 16건 | 3건 |
>
> **다음 작업**: 히트맵·차트 레퍼런스 추가 검색(미정)

`frontend/` 화면 설계에 참고한 UIbowl 레퍼런스 기록입니다. 시각 토큰은 [DESIGN.md](../../../../DESIGN.md)가 기준이며, 레퍼런스에서는 화면 구성만 참고했습니다.

## 1. 검색 결과: 대시보드, AI 채팅, 제어 9건

**1-1. 업무용 대시보드는 핵심 수치 카드를 위에, 상세 차트와 목록을 아래에 배치합니다.**

| 앱 | 화면 | 참고한 구성 |
|---|---|---|
| [클로브 AI](https://uibowl.io/website/%ED%81%B4%EB%A1%9C%EB%B8%8C%20AI?patterns=AI&patternName=%EA%B2%BD%EC%98%81%20%EC%8B%A4%EC%A0%81%20%EB%8C%80%EC%8B%9C%EB%B3%B4%EB%93%9C) | AI 경영 실적 대시보드 | 왼쪽 AI 대화, 오른쪽 보고서. 예시 데이터 안내 띠, 큰 숫자 카드와 비교 문구, 기준 시각 |
| [사방넷](https://uibowl.io/website/%EC%82%AC%EB%B0%A9%EB%84%B7?patterns=%EB%A9%94%EC%9D%B8&patternName=%EB%8C%80%EC%8B%9C%EB%B3%B4%EB%93%9C) | 메인 대시보드 | 상단 현황 수치 줄, 카드형 위젯 격자 |
| [네이버 웹툰](https://uibowl.io/website/%EB%84%A4%EC%9D%B4%EB%B2%84%20%EC%9B%B9%ED%88%B0?patterns=%EB%A9%94%EC%9D%B8&patternName=%ED%81%AC%EB%A6%AC%EC%97%90%EC%9D%B4%ED%84%B0%20-%20%EB%8C%80%EC%8B%9C%EB%B3%B4%EB%93%9C) | 크리에이터 대시보드 | 공지 모달 위주라 반영하지 않음 |
| [잔디](https://uibowl.io/website/%EC%9E%94%EB%94%94?patterns=AI&patternName=AI%20%EC%B1%84%ED%8C%85) | AI 채팅 | 추천 질문 칩, 입력창, 입력창 아래 "실수할 수 있으니 확인" 문구, 요약 카드 |
| [유광기](https://uibowl.io/website/%EC%9C%A0%EA%B4%91%EA%B8%B0?patterns=AI&patternName=%EC%B1%84%ED%8C%85) | AI 채팅 | 빈 화면 중앙 질문, 추천 항목 카드 |
| [채널톡](https://uibowl.io/website/%EC%B1%84%EB%84%90%ED%86%A1?patterns=%EC%B1%84%ED%8C%85&patternName=%EC%83%81%EB%8B%B4%20%EC%9D%91%EB%8C%80%20-%20AI%20%EB%8B%B5%EB%B3%80) | 상담 응대 AI 답변 | 오른쪽 AI 패널에 아이콘과 추천 요청 목록 |
| [Kia](https://uibowl.io/name/Kia?patterns=%EC%A0%9C%EC%96%B4&patternName=%EB%AC%B8%20%EC%97%B4%EA%B8%B0) | 원격 제어 | 기기 상태 위에 정사각형 제어 버튼 3개 |
| [카카오웹툰](https://uibowl.io/name/%EC%B9%B4%EC%B9%B4%EC%98%A4%EC%9B%B9%ED%88%B0?patterns=%EC%A0%9C%EC%96%B4&patternName=%EB%AA%A8%EB%93%9C%20%EC%A0%84%ED%99%98) | 모드 전환 | 전환 결과를 토스트로 알림 |
| [앳플리](https://uibowl.io/name/%EC%95%B3%ED%94%8C%EB%A6%AC?patterns=%EC%A0%9C%EC%96%B4&patternName=%EA%B8%B0%EA%B8%B0%EC%97%B0%EB%8F%99) | 기기 연동 | 연결 대기 상태 표시 |
| [리블](https://uibowl.io/website/%EB%A6%AC%EB%B8%94?patterns=AI&imgId=cmuc27rty002kle04vmnpe792) | AI 자연어 검색 | 입력 문장 아래 "조건 4개를 다 반영하는 중" 진행 문구, 해석한 조건 칩, 결과 목록 |
| [클로바노트](https://uibowl.io/website/%ED%81%B4%EB%A1%9C%EB%B0%94%EB%85%B8%ED%8A%B8?patterns=%EC%83%9D%EC%84%B1%ED%95%98%EA%B8%B0&imgId=cmpnusrj201mjl504ddm65094), [브루](https://uibowl.io/website/%EB%B8%8C%EB%A3%A8?patterns=AI&imgId=cmpmifrgx001di204qejd4axr), [리스닝마인드.AI](https://uibowl.io/website/%EB%A6%AC%EC%8A%A4%EB%8B%9D%EB%A7%88%EC%9D%B8%EB%93%9C.AI?patterns=%EA%B2%80%EC%83%89&imgId=cmsk0ual90009l804sdv73ygr) | 분석 중 문구 검색 결과 | 안내 모달·검색 결과 화면이라 진행 표시 참고 대상 아님 |
| [디맨드](https://uibowl.io/website/%EB%94%94%EB%A7%A8%EB%93%9C?patterns=AI&imgId=cmtia31yx001djy044rmf51xd), [알파스퀘어](https://uibowl.io/website/%EC%95%8C%ED%8C%8C%EC%8A%A4%ED%80%98%EC%96%B4?patterns=AI&imgId=cmuw2v42j000tjz04ndny6zka) | AI 생성 로딩 | 화면 중앙 단일 로딩 표시, 단계 구분 없음 |
| [브루](https://uibowl.io/website/%EB%B8%8C%EB%A3%A8?patterns=AI&imgId=cmpmif2k2000pl404t8cw0cbt), [핵클](https://uibowl.io/website/%ED%95%B5%ED%81%B4?patterns=AI&imgId=cmvymuwss00lxjv071ptq69c1), [사방넷](https://uibowl.io/website/%EC%82%AC%EB%B0%A9%EB%84%B7?patterns=AI&imgId=cmu4rq1pz0021jq04haj3j6st) | AI 진행 막대 | 하단 토스트·단계 막대로 진행률 표시 |

## 2. 반영: 수치 카드, 데이터 안내, AI 패널

**2-1. 레퍼런스 4건의 구성을 대시보드 첫 화면에 반영했습니다(2026-11-20).**

| 반영 항목 | 레퍼런스 | 대시보드 적용 |
|---|---|---|
| 핵심 수치 카드 | 클로브 AI, 사방넷 | 운전 중 HVAC, 정지, 이상 감지, 현재 전력 4개 카드와 비교 문구 |
| 예시 데이터 안내 띠 | 클로브 AI | "가상 데이터로 채운 화면" 안내, 데모 모드 제한 안내 |
| AI 주의 문구 | 잔디 | 입력창 아래 "AI 해석은 틀릴 수 있습니다" |
| 추천 질의 목록 | 채널톡 | AI 응답 카드의 빈 상태에 아이콘과 질의 3개 |
| AI 해석 조건 칩, 진행 표시 | 리블 | 단계 목록(요청 해석, 데이터 조회, 결과 검토, 답변 작성), 데이터 조회 단계의 조건 칩, 검색창 "AI 분석 중 N초" 배지. 리블의 글자 반짝임은 운영자 눈 피로 기준([DESIGN.md](../../../../DESIGN.md) 운영자 화면 기준)으로 제외 |

## 3. 제한 사항

- 무료 회원이라 검색당 3건만 확인했습니다.
- "에너지 사용량" 검색은 0건이었고, 대체 검색어 "제어"로 1회 재검색했습니다. 건물 에너지 관리 화면 레퍼런스는 확인하지 못했습니다.
- 레퍼런스 화면은 링크로만 기록하고 이미지는 저장소에 넣지 않았습니다.
