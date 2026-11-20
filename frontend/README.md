# frontend

에게(에너지게이트) 운영 대시보드(React, Vite, TypeScript)입니다. 로고는 `assets/ege.svg`(상단바·로그인), 파비콘은 `public/favicon.svg`(로고의 "에" 글자)입니다. 디자인 기준은 루트 [DESIGN.md](../DESIGN.md), 데이터 시각화 기준은 [디자인 시스템](../docs/human/reference/design-system.md) 6절입니다. 화면 구성 레퍼런스는 [UI 레퍼런스](../docs/human/explanation/research/ui-references.md)에 있습니다.

| 경로 | 내용 |
|---|---|
| `src/App.tsx` | 해시 경로, 머리글(전체 현황 링크, 건물 선택, 층 탭), 건물 화면 탭(운영, 전력 분석), 밝은/어두운 화면 전환 |
| `src/App.tsx` 운영 탭 | 왼쪽 열: 3D 트윈, 선택 호실 HVAC 상태, 전력 추이, 오늘 스케줄. 오른쪽 열: AI 응답, 이상 감지, 최적 제어 추천. 한 열 화면은 3D 다음에 오른쪽 열 |
| `src/portfolio/Portfolio.tsx` | 전체 현황: 전체 요약 4개, 건물 카드(점검 필요 순), 카드 아래 `compare` 영역 |
| `src/heat.ts` | 지표별 순차 색 척도 |
| `src/twin.ts` | 3D 트윈 iframe 연동([규약](../docs/human/reference/twin-embed.md)) |
| `src/shell/` | 화면 틀: 상단바(로고, 건물 토글, 운영·전력 분석 탭, 로그아웃), 왼쪽 사이드바(전체 현황, 층 3F→1F와 층별 이상·전력, 아래에 소속 기업 이름·역할과 관리자용 기업 관리 메뉴), 휴대폰 메뉴 서랍. 해시 경로는 `route.ts` |
| `src/auth/` | 로그인 화면과 Cognito 호출: 로그인, 회원가입(기업 코드 `EGE-XXXX-XXXX`, `ClientMetadata.companyCode`로 가입 전 검사에 전달), 이메일 인증 코드, 비밀번호 재설정, 첫 로그인 비밀번호 변경, 토큰 갱신. `VITE_COGNITO_CLIENT_ID`가 없으면 로그인 생략 |
| `src/auth/me.ts` | 로그인 사용자 소속(`GET /me`) 컨텍스트와 역할 이름. 역할이 없는 계정(판매사 관리자 제외)은 건물 화면 대신 "소속 기업 없음" 화면(`LoginScreen.tsx`의 `NoCompany`). 조회 실패는 확인 생략 |
| `src/skeleton/` | 컴포넌트별 스켈레톤(수치 카드, 층 목록, 3D 바닥판, 그래프, 목록 행, 히트맵, 흐름도, 표, 말풍선), 정지 블록 |
| `src/motion/` | 움직임: `motion.css`(넉터 6절 토큰: 누름 180ms, 이동 300ms, 등장 350ms, 페이드 160ms, 동작 줄이기 대응), `CountUp`(숫자 증가 460ms) |
| `src/admin/` | 판매사 기업 관리(관리자 그룹만 사이드바 표시): 기업 목록(코드, 만료일, 건물·구성원 수, 상태), 기업 추가, 가입한 사용자 목록. 기업 상세는 코드 복사·재발급(기간 선택), 정보 수정, 사용 상태 전환, 건물 연결·해제, 구성원 조회, 삭제(건물이 남으면 서버 409 안내) |
| `src/ai/ChartView.tsx` | AI 답변 그래프: 막대(한 색, 값 글자), 선(이번 기간 실선, 이전 기간 점선, 마우스·키보드 값 표시), 그래프·표 전환, 크게 보기 창(`<dialog>`) |
| `src/ai/ChatPanel.tsx` | AI 운영 도우미(말풍선 대화, 처리 단계 접기, 초안 카드와 저장 안내, 근거 문서 목록(`sources`, http(s) 링크만, 새 탭), 대상 호실 3D 보기, 대화 지우기). 기록은 `GET /chat`, 실패 시 화면에만 기록 |
| `src/twin3d/Twin3D.tsx` | Three.js 층 3D 트윈: 도면 API(`GET /buildings/{id}/plan`, 실패 시 `public/floorplans/<건물>.json`) 호실 다각형, 지표 색, HVAC 운전·이상 표시, 호실 선택, 시점 초기화·위에서 보기 |
| `src/api.ts` | Lambda API 호출(모든 조회에 `building` 전달), 실패하면 목업으로 대체하고 화면에 목업 표시. `GET /me`와 판매사 관리 API(`/admin/companies`, `/admin/buildings`, `/admin/users`)는 목업 대체 없이 오류 표시 |
| `src/ai/useAsk.ts` | AI 질의 훅. `buildingId` 전송, WebSocket 단계 이벤트 수신, 연결 실패 시 `api.ts` 질의로 대체, 45초 제한 |
| `src/ai/ThinkingPanel.tsx` | AI 사고 과정 패널(단계, 조건 칩, 스트리밍 답변)과 진행 표시 `ThinkingBadge` |
| `src/mock.ts` | 목업: 건물별 데모 상태, 정규식 기반 질의 해석 |
| `src/panels/` | 운영 패널 4종: 최적 제어 추천, 이상 감지, 오늘 스케줄(세로 시간표: 시작 시각부터 그날 끝까지 칸, 지금 선, 칸 선택 시 상세와 취소, 층 선택 버튼으로 층별 보기), 전력 추이(오늘·어제 SVG 그래프). 60초마다 다시 조회 |
| `src/energy/` | 에너지 분석: `BuildingCompare`(건물별 kWh·1㎡당·전기요금 막대), `EnergyPage`(일·주·월 추이, 사용 구성 흐름도, 최근 4주 요일×시간 히트맵). API 실패 시 `mock.ts` 목업([설계](../docs/human/explanation/architecture.md) 11절) |
| `src/panels/mock.ts` | 운영 패널·전체 현황 목업: 데모 상태 기반 추천·이상 감지·전력 곡선, 건물별 브라우저 메모리 스케줄 저장소 |
| `public/demo/<건물>.json` | 건물별 데모 상태와 건물 id 목록 `index.json`(`python3 tools/demo_status.py`를 `lambda` 폴더에서 실행해 생성) |
| `public/floorplans/<건물>.json` | 건물별 3D 도면, API를 쓸 수 없을 때의 대체 파일. `python3 tools/build_floorplans.py`를 `lambda` 폴더에서 실행해 `public/floorplan.json`에서 생성. 운영 도면은 도면 버킷(`lambda/tools/upload_plans.py`) |

## 화면 경로

| 주소 | 화면 |
|---|---|
| `#/` | 전체 현황(건물 카드, 이상 건물 먼저) |
| `#/b/<건물>` | 건물 운영 탭(오늘 대시보드). 새로고침하거나 건물을 바꾸면 층은 그 건물의 첫 층(트윈 화면 연동 시 건물 전체) |
| `#/b/<건물>/energy` | 건물 전력 분석 탭(`energy` 영역, 없으면 준비 중 안내) |
| `#/admin` | 판매사 기업 관리: 기업 목록, 기업 추가, 가입한 사용자(관리자 그룹 전용) |
| `#/admin/<기업 id>` | 기업 상세: 기업 코드, 기업 정보·사용 상태, 건물 연결, 구성원, 삭제 |

주: 건물 id는 `main`(본관, 공개 IFC), `office`, `edu`, `lab`(가상 건물)입니다. 목록에 없는 id는 안내 문구를 표시합니다.

## 실행

```bash
npm install
cp .env.example .env   # VITE_API_BASE_URL, VITE_WS_URL, VITE_TWIN_URL 입력
npm run dev
```

`VITE_API_BASE_URL`이 비어 있거나 Lambda 호출이 실패하면 목업으로 대체합니다. 운영 패널도 같은 방식으로 대체합니다. 목업 응답이면 패널 제목 옆에 `목업`을 표시합니다. 스케줄 취소는 서버 스케줄의 요청이 실패하면 목업으로 대체하지 않고 오류를 표시합니다. `VITE_WS_URL`이 비어 있거나 WebSocket 연결이 첫 이벤트 전에 실패하면 AI 질의는 `POST /query`로 처리하고, 응답을 받을 때까지 "분석 중" 단계 1개만 표시합니다. 상태는 `public/demo/<건물>.json`, 전체 현황은 같은 파일에서 계산한 값, 질의는 예시 문장 형태만 해석하는 정규식, 스케줄은 서버에 기록하지 않는 임시 저장입니다. 상태는 5초마다 다시 조회하며, 온도·습도·전력은 Lambda와 목업 모두 범위 안에서 변동합니다(실시간 목업: 온도 ±0.3℃, 습도 ±1.5%, 전력 ±8%).

## 3D 디지털 트윈 (`twin/`)

도면 사진 → 3D 건물 → 실시간 상태(대시보드 데이터·와이파이 재실) → EnergyPlus 운전 시뮬레이션까지 하는 트윈입니다. 빌드 없는 HTML·JS이고, 자세한 설명은 [twin/README.md](twin/README.md)에 있습니다.

| 할 일 | 방법 |
|---|---|
| 트윈만 보기 | `npm run dev` → http://localhost:5173/twin/digital-twin.html?building=eng6 (부산역: `?building=busan-station`) — 실시간 값은 대시보드가 보낼 때만 그림 |
| 운영 탭 3D 자리에 넣기 | `.env`에 `VITE_TWIN_URL=/twin/digital-twin.html` |
| 운전 시뮬레이션 계산 | [EnergyPlus 24.2](https://energyplus.net/downloads) 설치 후 다른 터미널에서 `npm run twin:sim` (개발 서버가 `/api/sim`을 8766으로 넘김). 없으면 저장된 결과(`scenario.json`)만 보임 |
| 도면 → building.json 다시 만들기 | `npm run twin:pipeline -- twin/source/eng6/recipe.json twin/data/building.json` 또는 `/twin/pipeline.html` |
| 건물 목록·데모 데이터 다시 만들기 | `npm run twin:demo` (트윈 `twin/data/buildings.json`의 건물 → `public/demo/<id>.json`, `index.json`, `src/energy/buildings.json`) |

- **값은 대시보드 한 곳에서만 만듭니다.** 트윈은 대시보드가 보낸 호실 상태(`postState`의 `data`)를 그대로 그려서 웹과 같은 값을 보입니다. 데모 값은 트윈 도면에서 만든 `public/demo/<id>.json`에 목업(`src/mock.ts`)이 ±변동을 준 것입니다.
- **건물 목록은 트윈을 따릅니다**: 6공학관(`eng6`), 부산역 역사(`busan-station`). 호실 id·실내기 id도 트윈 `building.json`과 같습니다.
- **건물 추가하기**(상단 건물 선택 맨 아래): 트윈 파이프라인이 열리고, 도면 이미지를 넣고 **트윈에서 렌더링**을 누르면 그때부터 그 건물 데이터를 만듭니다(`src/custom.ts`, 이 브라우저에만 저장).
- 운영 탭 오른쪽 맨 위 **운전 시뮬레이션** 패널(`src/panels/SimPanel.tsx`)은 트윈 안에 있던 것을 옮긴 것입니다. 계산은 트윈이 하고 결과만 받습니다.
- 트윈에서 방을 고르면 `{source:'twin', type:'roomSelected', roomId}`를 보냅니다(`src/twin.ts`가 받음). 방 설정온도를 바꾸면 `{source:'twin', type:'control'}`을 보내고 대시보드가 반영합니다.
- `npm run build`는 트윈을 `dist/twin/`으로 복사합니다(EnergyPlus 결과 `twin/sim/`은 제외).

## 확인

```bash
npm run lint && npm run build
```

화면을 바꾸면 1440px와 390px 너비에서 버튼 높이·너비와 라벨 잘림을 확인하십시오.

## 배포

```bash
npm run build
aws s3 sync dist s3://<WebBucketName> --delete --profile maestro
```

`WebBucketName`과 `WebUrl`은 `lambda`의 `sam deploy` 출력값입니다.
