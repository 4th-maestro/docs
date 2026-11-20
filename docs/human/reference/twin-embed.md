# 3D 트윈 임베드 규약

> **요약** (기준일 2026-11-20)
>
> - 대시보드는 팀원이 만든 3D 트윈 화면을 iframe으로 임베드하고, `postMessage`로 상태 색과 강조 호실을 전달
> - 트윈은 호실을 `id`(본관은 IFC GUID)로 식별하고, 사용자가 호실을 선택하면 `roomSelected` 메시지를 대시보드로 보냄
> - 2026-11-20 `state` 메시지에 현재 건물 `building` 추가(이전에는 본관만 전송)
> - 메시지는 출처(origin)를 확인한 뒤 처리
> - 2026-11-20 추가: 화면 테마 전달(`theme` 주소 옵션, 메시지), 트윈 데이터는 서버 조회(`GET /buildings/{id}/twin`), 트윈 데이터가 없는 건물은 내장 3D 도면 표시
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

조회가 실패(404 등)하면 대시보드는 그 건물에서 트윈 iframe 대신 내장 3D 도면을 표시하고, 트윈 연동 패널(운전 시뮬레이션)을 숨깁니다. 트윈 원본 저장 위치는 [도면 저장 규약](plan-storage.md) 1절입니다. 이전의 브라우저 저장 건물과 `edited=1` 주소 옵션은 2026-11-20 삭제되었습니다.
