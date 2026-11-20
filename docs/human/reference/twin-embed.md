# 3D 트윈 임베드 규약

> **요약** (기준일 2026-11-20)
>
> - 대시보드는 팀원이 만든 3D 트윈 화면을 iframe으로 임베드하고, `postMessage`로 상태 색과 강조 호실을 전달
> - 트윈은 호실을 `id`(본관은 IFC GUID)로 식별하고, 사용자가 호실을 선택하면 `roomSelected` 메시지를 대시보드로 보냄
> - 2026-11-20 `state` 메시지에 현재 건물 `building` 추가(이전에는 본관만 전송)
> - 메시지는 출처(origin)를 확인한 뒤 처리
> - 2026-11-20 추가: 화면 테마 전달(`theme` 주소 옵션, 메시지), 트윈 데이터는 서버 조회(`GET /buildings/{id}/twin`), 트윈 데이터가 없는 건물은 내장 3D 도면 표시
> - 2026-11-20 추가: 도면 파일 단계의 파이프라인 연동 메시지(`plans`, `detectRequest`, `detectResult`)와 실내기 기호 인식(7절)
> - 2026-11-20 추가: 임베드 트윈은 3D 렌더링과 호실 선택만 담당. 트윈 안 버튼·지표·조치 패널은 대시보드 카드로 옮기고 `ui`, `twinUi` 메시지로 연동(8절)
>
> **다음 작업**: 트윈 담당 팀원과 메시지 필드 확인(미정)

대시보드(`frontend/`)와 3D 트윈 화면 사이의 연동 규약입니다. 구현 원본은 `frontend/src/twin.ts`입니다.

## 1. 임베드: `VITE_TWIN_URL`

**1-1. 대시보드는 환경변수 `VITE_TWIN_URL`의 주소를 iframe으로 표시하고, 값이 없거나 건물의 트윈 데이터가 없으면 내장 3D 도면(`src/twin3d/Twin3D.tsx`)을 표시합니다.**

트윈 화면은 같은 브라우저 창 안에서 동작하므로, 별도 로그인이나 API 호출 없이 메시지만으로 상태를 받을 수 있습니다.

## 2. 대시보드 → 트윈: `state`

**2-1. 건물, 층, 지표, 호실 목록이 바뀔 때마다 대시보드가 아래 메시지를 보냅니다.**

| 필드 | 형식 | 내용 |
|---|---|---|
| `source` | `"maestro"` | 보낸 쪽 |
| `type` | `"state"` | 메시지 종류 |
| `building` | 문자열 | 현재 건물 id(`main`, `office`, `edu`, `lab`), 2026-11-20 추가 |
| `floor` | 문자열 | 현재 층(예: `1F`) |
| `mode` | `temp`, `powerKw`, `humidity`, `anomaly` | 히트맵 지표 |
| `rooms[].id` | 문자열 | 호실 id. 본관(`main`)은 IFC GUID, 가상 건물은 `건물.층.GUID` |
| `rooms[].color` | `#RRGGBB` | 호실 바닥에 칠할 색 |
| `rooms[].label` | 문자열 | 값과 단위(예: `21.3℃`) |
| `rooms[].onOff` | 불리언 | HVAC 운전 여부 |
| `rooms[].anomaly` | 문자열 또는 `null` | 이상 종류(`setpoint_unreached`) |
| `highlight` | 문자열 배열 | 질의 결과로 강조할 호실 id |

주: 트윈이 본관 IFC만 표시한다면 `building`이 `main`이 아닌 메시지는 무시하십시오. 가상 건물 도면은 `frontend/public/floorplans/<건물>.json`에 있습니다.

## 3. 트윈 → 대시보드: `roomSelected`

**3-1. 사용자가 3D에서 호실을 선택하면 트윈이 `{source: "twin", type: "roomSelected", roomId}`를 부모 창으로 보냅니다.**

대시보드는 해당 호실의 상세 카드를 표시합니다.

## 4. 보안: 출처 확인

**4-1. 양쪽 모두 `event.origin`을 확인하고, 약속한 출처의 메시지만 처리합니다.**

대시보드는 `VITE_TWIN_URL`의 origin으로만 메시지를 보내고 받습니다. 트윈도 대시보드 배포 주소(CloudFront 도메인)만 허용하십시오.

## 5. 화면 테마: 주소 옵션과 `theme` 메시지

**5-1. 대시보드는 iframe 주소에 `theme=light|dark`를 붙이고, iframe 로드와 테마 전환 때 `{source: "maestro", type: "theme", theme}`을 보냅니다.**

트윈은 주소 옵션, 메시지 순서로 적용하고 둘 다 없으면 시스템 설정을 따릅니다. 메시지는 `event.source === window.parent`일 때만 처리합니다. 대시보드는 테마 전환 때 iframe 주소를 바꾸지 않습니다. 주소가 바뀌면 iframe을 다시 읽어 작업 중인 도면이 사라집니다.

## 6. 트윈 데이터: `needBuilding`과 서버 조회

**6-1. 트윈 폴더에 없는 건물이면 트윈이 `needBuilding`을 보내고, 대시보드는 `GET /buildings/{id}/twin` 응답을 `buildingData`로 보냅니다.**

| 방향 | 메시지 | 내용 |
|---|---|---|
| 트윈 → 대시보드 | `{source: "twin", type: "needBuilding", id}` | 건물 id |
| 대시보드 → 트윈 | `{source: "maestro", type: "buildingData", id, data}` | 서버 트윈 원본, 조회 실패 시 `null` |

조회가 실패(404 등)하면 대시보드는 그 건물에서 트윈 iframe 대신 내장 3D 도면을 표시하고, 트윈 연동 패널(운전 시뮬레이션)을 숨깁니다. 시뮬레이션 탭에서는 운전 시뮬레이션을 사용할 수 없다고 안내합니다. 트윈 원본 저장 위치는 [도면 저장 규약](plan-storage.md) 1절입니다. 이전의 브라우저 저장 건물과 `edited=1` 주소 옵션은 2026-11-20 삭제되었습니다.

## 7. 파이프라인 연동: 평면도 전달과 실내기 기호 인식

**7-1. 도면 파일 단계(`src/ingest/PlanIngest.tsx`)는 파이프라인을 `pipeline.html?quick=1&detect=1`로 열고, 파이프라인의 기호 인식 요청을 대시보드가 서버로 중계합니다.**

| 방향 | 메시지 | 필드 | 처리 |
|---|---|---|---|
| 대시보드 → 파이프라인 | `plans` | `files`(File 목록) | 파일마다 층 행 1개(1F부터) 생성. PNG, JPG 업로드와 PDF 렌더링 페이지에 사용 |
| 파이프라인 → 대시보드 | `detectRequest` | `id`, `floors`, `image`(인식용 보정 평면도 PNG), `pxPerM` | `detect=1`일 때 3D 트윈 만들기 중 층 그룹마다 1회 |
| 대시보드 → 파이프라인 | `detectResult` | `id`, `detections`(`{cls, conf, box}`, 보정 이미지 픽셀), `key`, `error` | 대시보드가 `POST /plans/detect`로 인식. 실패 시 빈 목록과 `error` |
| 파이프라인 → 대시보드 | `buildingRendered`(기존) | `building` | `detect=1`이면 층마다 `background`, `detections`, `meta.ingest.warnings` 추가 |

- 인식용 보정 이미지는 화면용(1m당 20px)과 따로 원본에서 다시 보정합니다. 해상도는 학습 해상도 80px/m, 원본 실제 해상도, 긴 변 8,000px 중 가장 작은 값입니다.
- 보정 이미지 픽셀 (u, v)와 평면 좌표의 관계는 `x = u / pxPerM − 6`, `y = v / pxPerM − 6`입니다(여백 6m).
- 대시보드가 6분 안에 응답하지 않으면 파이프라인은 빈 결과로 진행합니다. 메시지 코드 원본은 `twin/pipeline/host-bridge.js`와 `src/ingest/bridge.ts`이고, 형식과 API는 [도면 변환 규약](plan-ingest.md)입니다.

## 8. 임베드 화면 역할: 트윈은 렌더링, 조작과 정보는 대시보드 카드

**8-1. 대시보드에 넣은 트윈(`body.hosted`)은 3D 렌더링과 호실 선택만 하고, 버튼·지표·조치 목록은 대시보드 카드가 표시합니다(2026-11-20 사용자 결정).**

| 트윈 안 요소 | 대시보드 위치 |
|---|---|
| 역할(에너지 총괄, 현장 엔지니어, 시설 관리자), 데이터 흐름, 설비 연결 | 운영 탭 3D 카드 도구 줄 |
| 데이터 흐름 패널(수집 데이터, 트윈 정보, 받는 사람 연결도) | 앱 화면 위 모달(`src/panels/FlowModal.tsx`), 트윈 안 패널은 숨김 |
| 호실 보기 도구(평면도로, 온도장, 바닥 등온선, 습도, 기류) | 호실 보기일 때 같은 도구 줄 |
| 층 칩, 지표 버튼, 범례 | 왼쪽 층 목록, 3D 카드 지표 버튼과 범례(기존) |
| 지표 칩(오늘 누적 사용량, 전기요금, 절감 가능, 재실 인원 등) | 사용 안 함. 상단 요약 카드 2개는 앱 데이터(상태, 시간별 전력, 요금 단가)로 표시(2026-11-20) |
| 우측 조치 패널(지금 바로 아낄 수 있는 전력 등) | 요약은 트윈 건물 보기 오른쪽 위 플로팅 카드, 조치 호실은 3D 신호·평면 배지와 말풍선(트윈 안, 2026-11-20). 앱 조치 목록 카드는 삭제 |
| 운전 시뮬레이션 역할과 패널 | 시뮬레이션 탭(`#/b/<id>/sim`) |
| 데이터 버튼(데이터 파일 교체) | 옮기지 않음(관리 기능) |

| 방향 | 메시지 | 필드 |
|---|---|---|
| 대시보드 → 트윈 | `{source: "maestro", type: "ui", action}` | `persona:<owner·engineer·facility·sim>`, `flow`(토글), `flow:off`(닫기 전용, 여러 번 받아도 같은 결과), `pipes`, `back`, `rv:<vol·slice·hum·air>` |
| 트윈 → 대시보드 | `{source: "twin", type: "twinUi", ui, kpis, actions, flow}` | `ui`(보기, 역할, 토글 눌림, `idu`: 층 보기에서 지금 층의 실내기 유형 목록으로 범례에 사용), `kpis`(라벨, 값, 단위, 경고), `actions`(제목, 범위, 요약, 호실 항목), `flow`(데이터 흐름을 켠 경우만: `sources`, `infos`(현재 값, 출처, 받는 역할), `personas`). 1초마다 바뀐 경우만 |

- 운영 탭과 시뮬레이션 탭은 같은 iframe을 유지합니다. 시뮬레이션 탭에 들어가면 역할을 운전 시뮬레이션으로 바꾸고 데이터 흐름과 설비 연결을 끄며, 운영 탭으로 돌아오면 에너지 총괄로 바꿉니다.
- 역할을 바꾸면 트윈은 운전 시뮬레이션 상태(`sim`)를 다시 보냅니다. 시뮬레이션 탭의 패널은 탭을 열 때 새로 생기므로 이전 보고를 받지 못하기 때문입니다.
- 로딩 순서(2026-11-20): 대시보드는 트윈 주소에 `host=1`을 붙여 트윈이 첫 표시부터 임베드 모드(`body.hosted`)로 시작하게 합니다. 트윈은 대시보드 데이터(`state`의 `data.rooms`)를 반영한 뒤에만 `twinUi`, `sim`, `building`을 보고합니다(5초 안에 못 받으면 보고). 트윈이 `{type: "twin:ready"}`를 보내면 대시보드는 테마와 상태를 다시 보냅니다. 경위는 [트윈 로딩 중 이전 화면 노출과 지연](../explanation/troubleshooting/2026-11-20%28%ED%8A%B8%EC%9C%88%20%EB%A1%9C%EB%94%A9%20%EC%A4%91%20%EC%9D%B4%EC%A0%84%20%ED%99%94%EB%A9%B4%20%EB%85%B8%EC%B6%9C%EA%B3%BC%20%EC%A7%80%EC%97%B0%29.md)입니다.
- 데이터 흐름 모달은 연결선을 앱이 다시 그립니다. 강조 규칙은 트윈 `drawFlow`와 같습니다(역할: 그 역할이 받는 정보와 출처, 정보: 출처와 받는 역할, 출처: 그 출처를 쓰는 정보와 받는 역할). 2026-11-20 사용자 결정으로 3D를 가리던 트윈 안 패널 대신 사용합니다.
- 코드: 트윈 `twin/digital-twin.html`(`hostUi`, `hostUiReport`, `flowModel`), 대시보드 `src/twin.ts`(`onTwinReport`, `postUi`), `src/panels/TwinTools.tsx`, `src/panels/TwinActions.tsx`, `src/panels/FlowModal.tsx`.
