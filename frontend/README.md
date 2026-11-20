# frontend

에게(에너지게이트) 운영 대시보드(React, Vite, TypeScript)입니다. 로고는 `assets/ege.svg`(상단바·로그인), 파비콘은 `public/favicon.svg`(로고의 "에" 글자)입니다. 디자인 기준은 루트 [DESIGN.md](../DESIGN.md), 데이터 시각화 기준은 [디자인 시스템](../docs/human/reference/design-system.md) 6절입니다. 화면 구성 레퍼런스는 [UI 레퍼런스](../docs/human/explanation/research/ui-references.md)에 있습니다.

| 경로 | 내용 |
|---|---|
| `src/App.tsx` | 해시 경로, 머리글(전체 현황 링크, 건물 선택, 층 탭), 건물 화면 탭(운영, 전력 분석), 밝은/어두운 화면 전환 |
| `src/App.tsx` 운영 탭 | 상단: 운영 상태 카드(운전 중, 정지, 이상 감지, 재실 인원)와 전력·요금 카드(현재 전력, 오늘 누적 사용량, 오늘 전기요금 추정, 마지막 줄 전력 추이). 왼쪽 열: 3D 트윈, 선택 호실 HVAC 상태, 오늘 스케줄. 오른쪽 열: AI 응답, 이상 감지, 최적 제어 추천. 한 열 화면은 3D 다음에 오른쪽 열 |
| `src/portfolio/Portfolio.tsx` | 전체 현황: 전체 요약 4개, 건물 카드(점검 필요 순), 카드 아래 `compare` 영역 |
| `src/heat.ts` | 지표별 순차 색 척도 |
| `src/twin.ts` | 3D 트윈 iframe 연동([규약](../docs/human/reference/twin-embed.md)): 트윈·파이프라인 주소(`theme=light\|dark` 포함), 테마 전환 메시지 `{source:'maestro', type:'theme', theme}`(iframe 로드 시, 테마 전환 시), 서버 건물의 `needBuilding` 요청에 `GET /buildings/{id}/twin` 응답 전달(없으면 `null`) |
| `src/shell/` | 화면 틀: 상단바(로고, 건물 토글, 운영·전력 분석 탭, 로그아웃), 왼쪽 사이드바(전체 현황, 층 3F→1F와 층별 이상·전력, 아래에 소속 기업 이름·역할, 고객사 구성원용 기업 정보 메뉴, 관리자용 기업 관리 메뉴), 휴대폰 메뉴 서랍. 해시 경로는 `route.ts` |
| `src/auth/` | 로그인 화면과 Cognito 호출: 로그인, 회원가입(기업 코드 `EGE-XXXX-XXXX`, `ClientMetadata.companyCode`로 가입 전 검사에 전달), 이메일 인증 코드, 비밀번호 재설정, 첫 로그인 비밀번호 변경, 토큰 갱신. `VITE_COGNITO_CLIENT_ID`가 없으면 로그인 생략 |
| `src/auth/me.ts` | 로그인 사용자 소속(`GET /me`) 컨텍스트와 역할 이름, 다시 조회 이벤트(`ME_CHANGED`). 역할이 없는 계정(판매사 관리자 제외)은 건물 화면 대신 "소속 기업 없음" 화면(`LoginScreen.tsx`의 `NoCompany`, 기업 코드 입력 후 `POST /me/join`). 조회 실패는 확인 생략 |
| `src/auth/LoginScreen.tsx` `Suspended` | 서비스 중지 화면: 소속 기업이 사용 중지(`GET /me`의 `company.status`가 `suspended`)이거나 API가 403 `COMPANY_SUSPENDED`를 반환하면 건물 화면 대신 서버 문구와 로그아웃 버튼 표시(판매사 관리자 제외) |
| `src/skeleton/` | 컴포넌트별 스켈레톤(수치 카드, 층 목록, 3D 바닥판, 그래프, 목록 행, 히트맵, 흐름도, 표, 말풍선), 정지 블록 |
| `src/motion/` | 움직임: `motion.css`(넉터 6절 토큰: 누름 180ms, 이동 300ms, 등장 350ms, 페이드 160ms, 동작 줄이기 대응), `CountUp`(숫자 증가 460ms) |
| `src/admin/` | 판매사 기업 관리(관리자 그룹만 사이드바 표시): 기업 목록(코드, 만료일, 건물·구성원 수, 상태), 기업 추가, 가입한 사용자 목록. 기업 상세는 코드 복사·재발급(기간 선택), 정보 수정, 사용 상태 전환, 건물(추가, 정보 수정, 도면 편집, 도면 교체, 연결·해제, 영구 삭제), 구성원 역할 변경·제외(재확인, 마지막 고객사 관리자는 서버 409 안내), 변경 이력, 삭제(건물이 남으면 서버 409 안내). `parts.tsx`(입력칸, 상태, 만료일, 구성원, 변경 이력, 건물 정보 입력)와 `form.ts`(기업 정보 입력 처리) |
| `src/admin/BuildingPages.tsx` | 판매사 건물 화면: 만들기 방법 선택(도면 이미지, IFC 파일은 준비 중 비활성), 도면 이미지 단계(트윈 파이프라인 iframe `TwinPipeline`), 결과 확인(추가는 이름·용도·운영 시간·주말 운영 입력, 교체는 교체 확인), 도면 편집(`BuildingEditor`로 서버 트윈 편집). 저장 실패는 서버 문구(409 포함) 표시 |
| `src/admin/convert.ts` | 트윈 `building.json` → 서버 저장 형식 `{twin, rooms, plan}` 변환. 건물 id `b-` + 소문자·숫자 8자(브라우저 생성), 모든 호실 id와 호실 참조에 `<건물 id>.` 접두어(이미 붙은 값은 유지). `rooms`는 실내기가 있는 실만(`web-demo.js` `webStatus` 기준), `plan`은 같은 호실의 내장 3D 형식([도면 저장 규약](../docs/human/reference/plan-storage.md), y 부호 반전). 자가 점검 `node src/admin/convert.check.mjs` |
| `src/settings/SettingsPage.tsx` | 고객사 기업 정보(`#/settings`, 조회 전용): 기본 정보(기업 코드 미표시), 건물(용도, 층·호실 수, 운영 시간, 주말 운영), 변경 이력(최신 50건). 수정 기능 없음 |
| `src/ai/ChartView.tsx` | AI 답변 그래프: 막대(한 색, 값 글자), 선(이번 기간 실선, 이전 기간 점선, 마우스·키보드 값 표시), 그래프·표 전환, 크게 보기 창(`<dialog>`) |
| `src/ai/ChatPanel.tsx` | AI 운영 도우미(말풍선 대화, 처리 단계 접기, 초안 카드와 저장 안내, 근거 문서 목록(`sources`, http(s) 링크만, 새 탭), 대상 호실 3D 보기, 대화 지우기). 기록은 `GET /chat`, 실패 시 화면에만 기록 |
| `src/ops/` | 자동 운영 화면: `OpsMessages.tsx`(AI 운영 도우미 대화 안 알림 카드와 마지막 상태 메시지의 ON/OFF 스위치), `types.ts`(응답 형식), `mock.ts`(API 없는 목업, 건물별 메모리). 규칙은 [자동 운영 화면 규약](../docs/human/reference/auto-operations.md) |
| `src/twin3d/Twin3D.tsx` | Three.js 층 3D 트윈: 도면 API(`GET /buildings/{id}/plan`, 실패 시 `public/floorplans/<건물>.json`) 호실 다각형, 지표 색, HVAC 운전·이상 표시, 호실 선택, 시점 초기화·위에서 보기 |
| `src/api.ts` | Lambda API 호출(모든 조회에 `building` 전달), 실패하면 목업으로 대체하고 화면에 목업 표시. 건물 목록(`GET /buildings`)은 목업 대체 없이 오류 표시. `GET /me`, `POST /me/join`, 기업 정보 조회 API(`GET /company`, `GET /company/audit`), 트윈 조회(`GET /buildings/{id}/twin`), 판매사 관리 API(`/admin/companies`, `/admin/buildings`, `/admin/users`, 건물 추가 `POST /admin/companies/{id}/buildings`, 정보 수정 `PATCH /admin/buildings/{id}`, 삭제 `DELETE /admin/buildings/{id}`), 도면 교체·편집 저장(`PUT /buildings/{id}/twin`, 판매사 권한은 서버 판정)는 목업 대체 없이 오류 표시. 도면 본문이 5MB를 넘으면 보내기 전에 안내. 403 `COMPANY_SUSPENDED`는 서비스 중지 화면 전환 이벤트(`SUSPENDED`) 발생 |
| `src/ai/useAsk.ts` | AI 질의 훅. `buildingId` 전송, WebSocket 단계 이벤트 수신, 연결 실패 시 `api.ts` 질의로 대체, 45초 제한 |
| `src/ai/ThinkingPanel.tsx` | AI 사고 과정 패널(단계, 조건 칩, 스트리밍 답변)과 진행 표시 `ThinkingBadge` |
| `src/mock.ts` | 목업: 건물별 데모 상태, 정규식 기반 질의 해석 |
| `src/panels/` | 운영 패널 4종: 최적 제어 추천, 이상 감지, 오늘 스케줄(세로 시간표: 시작 시각부터 그날 끝까지 칸, 지금 선, 칸 선택 시 상세와 취소, 층 선택 버튼으로 층별 보기), 전력 추이(전력·요금 카드 안 오늘·어제 SVG 추이선). 60초마다 다시 조회 |
| `src/energy/` | 에너지 분석: `BuildingCompare`(건물별 kWh·1㎡당·전기요금 막대), `EnergyPage`(일·주·월 추이, 사용 구성 흐름도, 최근 4주 요일×시간 히트맵). API 실패 시 `mock.ts` 목업([설계](../docs/human/explanation/architecture.md) 11절) |
| `src/panels/mock.ts` | 운영 패널·전체 현황 목업: 데모 상태 기반 추천·이상 감지·전력 곡선, 건물별 브라우저 메모리 스케줄 저장소 |
| `src/BuildingEditor.tsx` | 평면도 편집: 방 이름, 벽 설치, 벽 삭제, 벽 이동, 칸막이, 실내기(`src/ingest/UnitTool.tsx`), 위치 맞춤, 실행 취소 |
| `src/ingest/PlanIngest.tsx` | 도면 업로드, 2D 실내기 매핑, 확정 저장 진입 컴포넌트(판매사 건물 화면에서 사용). 입력 IFC, DXF, DWG, PDF, PNG, JPG |
| `src/ingest/api.ts` | 도면 변환 API(작업 생성, S3 업로드, 시작, 3초 상태 조회), 기호 인식, 확정 저장 어댑터 `saveTwin` |
| `src/ingest/UnitTool.tsx` | 실내기 도구(유형 6종 추가, 끌어서 이동, 삭제, 유형 변경, 확인 필요 목록)와 도면 위치 맞춤(기준점 2쌍) |
| `src/ingest/units.ts` | 기준점 2쌍 유사 변환, 인식 결과 → 실내기, 호실 배정. 유형표 `hvac-types.json`은 `../ml/hvac_types.json` 복사본 |
| `public/demo/<건물>.json` | 건물별 데모 상태와 건물 id 목록 `index.json`(`python3 tools/demo_status.py`를 `lambda` 폴더에서 실행해 생성) |
| `public/floorplans/<건물>.json` | 건물별 3D 도면, API를 쓸 수 없을 때의 대체 파일. `python3 tools/build_floorplans.py`를 `lambda` 폴더에서 실행해 `public/floorplan.json`에서 생성. 운영 도면은 도면 버킷(`lambda/tools/upload_plans.py`) |

## 화면 경로

| 주소 | 화면 |
|---|---|
| `#/` | 전체 현황(건물 카드, 이상 건물 먼저) |
| `#/b/<건물>` | 건물 운영 탭(오늘 대시보드). 새로고침하거나 건물을 바꾸면 층은 그 건물의 첫 층(트윈 화면 연동 시 건물 전체) |
| `#/b/<건물>/energy` | 건물 전력 분석 탭(`energy` 영역, 없으면 준비 중 안내) |
| `#/admin` | 판매사 기업 관리: 기업 목록, 기업 추가, 가입한 사용자(관리자 그룹 전용) |
| `#/admin/<기업 id>` | 기업 상세: 기업 코드, 기업 정보·사용 상태, 건물(추가, 정보 수정, 도면 편집·교체, 연결·해제, 영구 삭제), 구성원 역할 변경·제외, 변경 이력, 삭제 |
| `#/admin/<기업 id>/buildings/new` | 건물 추가: 만들기 방법 선택. `/image`를 붙이면 도면 이미지 단계(트윈 파이프라인 → 건물 정보 확인 → 저장 후 기업 상세) |
| `#/admin/<기업 id>/buildings/<건물 id>/replace` | 도면 교체: 같은 방법 선택 화면. `/image`는 도면 이미지 단계(교체 확인 후 `PUT /buildings/{id}/twin`) |
| `#/admin/<기업 id>/buildings/<건물 id>/plan` | 도면 편집: 서버 트윈 도면을 편집기로 수정 후 저장(`PUT /buildings/{id}/twin`). 트윈 도면이 없으면(404) 도면 교체 안내 |
| `#/settings` | 고객사 기업 정보(조회 전용): 기본 정보, 건물, 변경 이력(고객사 구성원 전용, 사이드바 기업 이름 아래 메뉴) |

주: 건물 id는 `main`(본관, 공개 IFC), `office`, `edu`, `lab`(가상 건물)과 판매사가 추가한 `b-xxxxxxxx`입니다. 목록에 없는 id는 안내 문구를 표시합니다.

## 역할: 판매사 관리, 고객사 조회·운영

| 계정 | 할 수 있는 일 | 할 수 없는 일 |
|---|---|---|
| 판매사 관리자(Cognito 그룹 `admin`) | 기업·구성원 관리, 건물 추가·정보 수정·도면 편집·도면 교체·연결·영구 삭제(`#/admin`), 모든 건물 화면 | 없음 |
| 고객사 구성원(기업 코드 가입, 고객사 관리자·운영자 공통) | 대시보드 조회, AI 질의, 스케줄 저장·취소, 최적 제어 추천 적용, 운전 시뮬레이션, 트윈 설정온도 변경, 기업 정보 조회(`#/settings`) | 건물 추가, 도면 편집, 건물 삭제, 기업·구성원·건물 정보 수정(서버 403) |

주: 2026-11-20 사용자 결정입니다. 건물 데이터는 서버에 저장하며 브라우저 저장(`localStorage`)은 사용하지 않습니다.

## 실행

```bash
npm install
cp .env.example .env   # VITE_API_BASE_URL, VITE_WS_URL, VITE_TWIN_URL 입력
npm run dev
```

`VITE_API_BASE_URL`이 비어 있거나 Lambda 호출이 실패하면 목업으로 대체합니다. 운영 패널도 같은 방식으로 대체합니다. 건물 목록은 `VITE_API_BASE_URL`이 비어 있을 때만 목업을 씁니다. 판매사 화면에서 건물을 등록·수정·삭제하면 목록을 바로 한 번, 4초 뒤 한 번 더 조회합니다(서버의 다른 실행 환경 반영 간격 3초). 목업 응답이면 패널 제목 옆에 `목업`을 표시합니다. 스케줄 취소는 서버 스케줄의 요청이 실패하면 목업으로 대체하지 않고 오류를 표시합니다. `VITE_WS_URL`이 비어 있거나 WebSocket 연결이 첫 이벤트 전에 실패하면 AI 질의는 `POST /query`로 처리하고, 응답을 받을 때까지 "분석 중" 단계 1개만 표시합니다. 상태는 `public/demo/<건물>.json`, 전체 현황은 같은 파일에서 계산한 값, 질의는 예시 문장 형태만 해석하는 정규식, 스케줄은 서버에 기록하지 않는 임시 저장입니다. 상태는 5초마다 다시 조회하며, 온도·습도·전력은 Lambda와 목업 모두 범위 안에서 변동합니다(실시간 목업: 온도 ±0.3℃, 습도 ±1.5%, 전력 ±8%).

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
- **건물 추가**(판매사 기업 상세의 건물 영역): 만들기 방법에서 도면 이미지를 고르면 트윈 파이프라인이 열립니다. 결과(`buildingRendered`)를 받으면 브라우저에서 `{twin, rooms, plan}`으로 변환해 서버에 저장합니다(`src/admin/convert.ts`). 운영 탭 트윈은 서버 건물의 도면을 `GET /buildings/{id}/twin`으로 받습니다.
- 건물 화면 상단 탭은 **운영**, **전력 분석**, **시뮬레이션**(`#/b/<id>/sim`)입니다. 시뮬레이션 탭에는 트윈 3D(운전 시뮬레이션 역할), **운전 시뮬레이션** 패널(`src/panels/SimPanel.tsx`), 시나리오 실험(개발 서버의 `eng6`만)이 있습니다. 계산은 트윈이 하고 결과만 받습니다. 트윈 도면이 없는 건물은 시뮬레이션을 사용할 수 없다고 안내합니다.
- 운영 탭의 트윈은 3D 렌더링과 호실 선택만 합니다(2026-11-20). 트윈 안 버튼, 층 칩, 지표 칩, 우측 패널은 숨기고 앱이 대신 표시합니다.
  - 3D 카드 도구 줄(`src/panels/TwinTools.tsx`): 역할(에너지 총괄, 현장 엔지니어, 시설 관리자), 데이터 흐름, 설비 연결. 호실 보기에서는 평면도로, 온도장, 바닥 등온선, 습도, 기류
  - 상단 요약 카드 2개(4열 중 각 2열, 2026-11-20): 운영 상태(운전 중, 정지, 이상 감지, 재실 인원, 두 카드가 나란히 놓이는 1128px 이상은 2×2)와 전력·요금(현재 전력, 오늘 누적 사용량, 오늘 전기요금 추정). 오늘 사용량은 전력 추이와 같은 `GET /rooms/history` 응답, 요금 단가는 `GET /energy/compare`의 `unitPriceKrw`. 역할별 지표(절감 가능, 쾌적 비율, 실내기 상태)는 3D 플로팅 요약에 표시
  - 전력·요금 카드 칸 배치: 라벨과 값은 줄바꿈하지 않음. 칸 합계가 카드 너비를 초과하면 요금 칸이 다음 줄로 이동. 1128~1279px은 두 카드 값 28px(2026-11-21)
  - 전력 추이: 전력·요금 카드 마지막 줄(2026-11-21, 이전에는 카드 아래 전체 너비 별도 카드). 추이선 높이 44px와 시간 눈금 18px, y축 눈금 없이 시간 선택 말풍선으로 값 표시. 층을 고르면 그 층, 아니면 건물 전체. 범례 줄에 어제 같은 시각 대비 증감률 표시. 눈금 있는 그래프와 표는 전력 분석 탭
  - 역할별 조치(트윈 `digital-twin.html`): 요약(예: 지금 바로 아낄 수 있는 전력)은 건물 보기 3D 오른쪽 위 플로팅 카드(층·호실 보기, 480px 이하는 숨김). 조치 호실은 건물 3D의 신호와 층 평면도 배지로 표시하고, 마우스를 올리면 말풍선에 조치 제목과 내용을 표시. 오른쪽 열 카드는 없음(2026-11-20)
  - 건물 전체로 돌아가기: 층·호실 보기에서 3D 카드 제목 앞 "건물 전체" 버튼(운영·시뮬레이션 탭). 트윈 자체 상단 경로 표시는 앱 안에서 숨김
  - 층 평면도(트윈 층 보기): 층 지표 5칸(평균 온도, 평균 습도, 전력, 재실 인원, 실내기 가동)은 평면도 아래쪽 위에, 안내 문구(사진 추정 공간 등)는 왼쪽 위에 플로팅으로 표시하고 평면도는 3D 영역 전체 높이 사용. 3D 영역 높이는 화면 높이의 64%(560~760px)
  - 데이터 흐름 모달(`src/panels/FlowModal.tsx`): 도구 줄의 데이터 흐름을 누르면 앱 화면 위 대화 상자로 수집 데이터, 트윈 정보, 받는 사람 3단 연결도를 표시. 역할을 누르면 3D 역할 전환, 닫기·Esc·바깥 클릭으로 닫음
  - 로딩 순서: 트윈 주소의 `host=1`로 첫 표시부터 트윈 자체 도구·지표를 숨김. 트윈은 앱 데이터(`state`)를 받은 뒤에만 보고(최대 5초 대기)하고, 보고 전에는 앱이 도구 줄·지표·층 목록 자리를 고정 크기로 표시. 트윈이 `twin:ready`를 보내면 앱이 테마·상태를 다시 보냄. 트윈 도면은 화면을 열 때 미리 조회
  - 메시지: 트윈 → `twinUi`(화면 상태, 지표, 조치 목록, 데이터 흐름), 앱 → `ui`(동작). 규약은 [3D 트윈 임베드 규약](../docs/human/reference/twin-embed.md) 8절
- 트윈에서 방을 고르면 `{source:'twin', type:'roomSelected', roomId}`를 보냅니다(`src/twin.ts`가 받음). 방 설정온도를 바꾸면 `{source:'twin', type:'control'}`을 보내고 대시보드가 반영합니다.
- `npm run build`는 트윈을 `dist/twin/`으로 복사합니다(EnergyPlus 결과 `twin/sim/`은 제외).
- **도면 업로드와 실내기 매핑**(`src/ingest/`, [도면 변환 규약](../docs/human/reference/plan-ingest.md)): 아래 표의 순서로 처리합니다. 확인 필요(`review`) 실내기는 주황 점선 테두리와 "확인 필요 N대" 목록으로 표시합니다.

| 입력 | 처리 | 2D 매핑 화면 |
|---|---|---|
| IFC, DXF, DWG | `POST /plans/jobs` → S3 PUT → `/start` → 3초마다 상태 조회(파일 해석, 도면 이미지 생성, 실내기 인식, 병합) | 서버 초안. 렌더링한 도면은 배경 이미지 |
| PDF | 위와 같은 서버 작업 후 렌더링한 페이지를 트윈 파이프라인에 넣음 | 파이프라인 결과 |
| PNG, JPG | 고른 파일을 트윈 파이프라인에 넣음(`plans` 메시지) | 파이프라인 결과 |

- 파이프라인은 보정 평면도마다 기호 인식을 요청하고(`detectRequest`), 대시보드가 `POST /plans/detect`로 처리합니다. 메시지 목록은 [twin/README.md](twin/README.md) "호스트 연동 메시지"에 있습니다.
- 2D 매핑 화면은 평면도 편집의 **실내기**와 **위치 맞춤** 도구입니다. 위치 맞춤은 도면 이미지 점 2개와 평면 점 2개로 회전, 축척, 이동을 구하고, 위치를 맞추지 않은 인식 결과(`floors[].detections`)를 실내기로 바꿉니다.
- 확정 저장은 `saveTwin(buildingId, twin, convert)`입니다. 호출 쪽이 변환 함수(`src/admin/convert.ts`)를 넘기면 `PUT /buildings/{id}/twin` `{twin, rooms, plan}`, 없으면 이 브라우저에만 저장합니다(데모).
- `VITE_API_BASE_URL`이 없으면 IFC, CAD, PDF 변환과 기호 인식은 동작하지 않고, PNG, JPG만 파이프라인으로 처리합니다.

## 확인

```bash
npm run lint && npm run build
node src/admin/convert.check.mjs   # building.json 변환 자가 점검(접두어 중복 방지, twin·rooms·plan id 일치)
```

화면을 바꾸면 1440px와 390px 너비에서 버튼 높이·너비와 라벨 잘림을 확인하십시오.

실내기 매핑 계산은 `node src/ingest/units.check.mjs`로 자가 점검합니다(Node 23.6 이상, 기준점 변환, 호실 배정, 인식 결과 변환, 인식용 보정 해상도, 실외기 연결, 빈 호실 추정).

## 배포

배포는 `main` 기준입니다. 운영 빌드에는 환경 변수 4개가 모두 필요합니다.

```bash
git switch main && git pull --ff-only \
  && test -z "$(git status --porcelain --untracked-files=no)" \
  && VITE_API_BASE_URL=<ApiUrl> VITE_WS_URL=<WsUrl> VITE_COGNITO_CLIENT_ID=<UserPoolClientId> \
     VITE_TWIN_URL=/twin/digital-twin.html npm run build \
  && aws s3 sync dist s3://<WebBucketName> --delete --exclude "assets/*" --cache-control "no-cache" --profile maestro \
  && aws s3 sync dist/assets s3://<WebBucketName>/assets --delete --cache-control "public, max-age=31536000, immutable" --profile maestro
```

캐시 헤더는 파일 종류마다 다릅니다(2026-11-20 적용).

| 대상 | Cache-Control | 이유 |
|---|---|---|
| `assets/*`(파일 이름에 해시 포함) | `public, max-age=31536000, immutable` | 내용이 바뀌면 파일 이름도 바뀌어 다시 받을 필요 없음 |
| 그 밖(`index.html`, `twin/*`) | `no-cache` | 매번 변경 여부 확인(바뀌지 않았으면 304), 배포 직후 새 화면 반영 |

주: CloudFront 압축(`Compress: true`, `lambda/template.yaml`)으로 앱 JS 451KB는 140KB, 3D 도면 JS 620KB는 154KB, 트윈 HTML 256KB는 81KB로 전송됩니다(gzip 기준).

| 환경 변수 | 값 | 빠지면 |
|---|---|---|
| `VITE_API_BASE_URL` | `sam deploy` 출력 `ApiUrl` | 모든 화면이 목업 데이터 |
| `VITE_WS_URL` | 출력 `WsUrl` | AI 질의가 HTTP로만 동작(단계 실시간 표시 없음) |
| `VITE_COGNITO_CLIENT_ID` | 출력 `UserPoolClientId` | 로그인 없이 동작 |
| `VITE_TWIN_URL` | `/twin/digital-twin.html` | 판매사 건물 추가·도면 교체 화면에 "3D 트윈 주소(VITE_TWIN_URL)가 없어 도면을 넣을 수 없습니다" 표시 |

주: `VITE_TWIN_URL`이 있으면 운영 탭 3D 영역도 트윈 화면(iframe)을 사용합니다. 건물 목록의 `hasTwin`이 false인 건물(2026-11-20 기준 본관, 업무동, 교육관, 연구동)은 트윈 화면을 불러오지 않고 내장 3D 도면을 표시합니다. 판매사가 도면 교체로 트윈 도면을 넣으면 트윈 화면으로 바뀝니다. 배포 후 CloudFront 무효화(`/*`)를 실행하십시오.

`WebBucketName`과 `WebUrl`은 `lambda`의 `sam deploy` 출력값입니다.
