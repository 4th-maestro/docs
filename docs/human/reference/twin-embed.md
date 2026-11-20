# 3D 트윈 임베드 규약

> **요약** (기준일 2026-11-20)
>
> - 대시보드는 팀원이 만든 3D 트윈 화면을 iframe으로 임베드하고, `postMessage`로 상태 색과 강조 호실을 전달
> - 트윈은 호실을 IFC GUID(`id`)로 식별하고, 사용자가 호실을 선택하면 `roomSelected` 메시지를 대시보드로 보냄
> - 메시지는 출처(origin)를 확인한 뒤 처리
>
> **다음 작업**: 트윈 담당 팀원과 메시지 필드 확인(미정)

대시보드(`frontend/`)와 3D 트윈 화면 사이의 연동 규약입니다. 구현 원본은 `frontend/src/twin.ts`입니다.

## 1. 임베드: `VITE_TWIN_URL`

**1-1. 대시보드는 환경변수 `VITE_TWIN_URL`의 주소를 iframe으로 표시하고, 값이 없으면 호실 타일 목록을 대신 표시합니다.**

트윈 화면은 같은 브라우저 창 안에서 동작하므로, 별도 로그인이나 API 호출 없이 메시지만으로 상태를 받을 수 있습니다.

## 2. 대시보드 → 트윈: `state`

**2-1. 층, 지표, 호실 목록이 바뀔 때마다 대시보드가 아래 메시지를 보냅니다.**

| 필드 | 형식 | 내용 |
|---|---|---|
| `source` | `"maestro"` | 보낸 쪽 |
| `type` | `"state"` | 메시지 종류 |
| `floor` | 문자열 | 현재 층(예: `1F`) |
| `mode` | `temp`, `powerKw`, `humidity`, `anomaly` | 히트맵 지표 |
| `rooms[].id` | 문자열 | 호실 IFC GUID |
| `rooms[].color` | `#RRGGBB` | 호실 바닥에 칠할 색 |
| `rooms[].label` | 문자열 | 값과 단위(예: `21.3℃`) |
| `rooms[].onOff` | 불리언 | HVAC 운전 여부 |
| `rooms[].anomaly` | 문자열 또는 `null` | 이상 종류(`setpoint_unreached`) |
| `highlight` | 문자열 배열 | 질의 결과로 강조할 호실 GUID |

## 3. 트윈 → 대시보드: `roomSelected`

**3-1. 사용자가 3D에서 호실을 선택하면 트윈이 `{source: "twin", type: "roomSelected", roomId}`를 부모 창으로 보냅니다.**

대시보드는 해당 호실의 상세 카드를 표시합니다.

## 4. 보안: 출처 확인

**4-1. 양쪽 모두 `event.origin`을 확인하고, 약속한 출처의 메시지만 처리합니다.**

대시보드는 `VITE_TWIN_URL`의 origin으로만 메시지를 보내고 받습니다. 트윈도 대시보드 배포 주소(CloudFront 도메인)만 허용하십시오.
