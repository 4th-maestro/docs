# 도면 저장 규약

> **요약** (기준일 2026-11-20)
>
> - 운영 화면의 내장 3D 도면은 `GET /buildings/{id}/plan`으로 도면 버킷의 `plans/<건물>/current.json`을 읽음. 도면 수정 기능(팀원 작업)은 이 위치와 형식으로 저장하면 화면에 바로 반영됨
> - 형식은 층별 `bounds`와 호실 `id`·`polys`·`hvac`, 좌표 단위 m. 호실 `id`는 호실 테이블(`maestro-Rooms`)의 `roomId`와 같아야 상태 색과 선택이 연결됨
> - 판매사 확정 저장(`PUT /buildings/{id}/twin`, 건물 등록)이 도면·트윈 버전 파일, `current.json`, 호실·설비 테이블을 함께 갱신함(2026-11-20 결정). 업로드·변환 흐름은 [도면 변환 규약](plan-ingest.md)
>
> **다음 작업**: 없음

## 1. 저장 위치: 도면 버킷 2가지 키

**1-1. 현재 도면은 `current.json` 1개이고, 버전 파일은 같은 폴더에 저장합니다.**

| 키 | 내용 | 읽는 곳 |
|---|---|---|
| `plans/<건물 id>/current.json` | 현재 도면 | `GET /buildings/{id}/plan`(`lambda/src/plan.py`) |
| `plans/<건물 id>/v<번호>.json` | 버전별 도면(초기 적재는 `v1.json`) | 조회 API는 읽지 않음 |
| `plans/<건물 id>/building.json` | 현재 트윈 원본(`twin.building/v1`) | `GET /buildings/{id}/twin`(트윈 화면, 평면도 편집) |
| `plans/<건물 id>/building-v<번호>.json` | 버전별 트윈 원본 | 조회 API는 읽지 않음 |

- 버킷 이름은 `maestro` 스택 출력값 `PlansBucketName`입니다.
- 초기 적재는 `lambda/tools/upload_plans.py`이며, `current.json`이 이미 있는 건물은 건너뜁니다.
- 확정 저장 1회는 도면(`v<n>.json`)과 트윈(`building-v<n>.json`)에 같은 번호를 씁니다. `n`은 두 종류 기존 번호 중 최대값 + 1입니다.
- 건물 영구 삭제(`DELETE /admin/buildings/{id}`)는 `plans/<건물 id>/` 아래 파일을 모두 지웁니다.
- 조회 API는 저장된 JSON을 다시 직렬화하지 않고 그대로 응답합니다. Lambda 응답 한도(6MB) 안에서 사용하십시오(2026-11-20 기준 건물당 20~47KB).

## 2. 형식: 층, 경계, 호실 다각형

**2-1. 화면은 `floors.<층>.bounds`와 `rooms[].id`, `polys`, `hvac`만 사용합니다.**

```json
{
  "source": "buildingSMART Community Medical-Dental Clinic IFC2x3, CC BY 4.0",
  "unit": "m",
  "building": "office",
  "virtual": true,
  "floors": {
    "1F": {
      "elevation": 0.0,
      "bounds": [-0.25, -0.11, 52.01, 56.25],
      "rooms": [
        {"id": "office.1F.0ztdC3L1HAzhbhMHypqbH5", "polys": [[[19.83, 28.53], [19.83, 27.01], [20.17, 27.01]]], "hvac": []}
      ]
    }
  }
}
```

| 필드 | 형식 | 화면 사용 | 규칙 |
|---|---|---|---|
| `floors` | 객체(층 이름 → 층) | 사용 | 층 이름은 건물 테이블 `floors`의 키와 같게(`1F`, `2F`) |
| `floors.<층>.bounds` | `[x0, y0, x1, y1]` | 사용 | 그 층 모든 호실 좌표의 최소·최대, 카메라 위치 계산 |
| `floors.<층>.elevation` | 숫자(m) | 미사용 | 층 바닥 높이 |
| `rooms[].id` | 문자열 | 사용 | 호실 테이블 `roomId`와 같은 값 |
| `rooms[].polys` | 다각형 목록, 점은 `[x, y]` | 사용 | 한 호실이 여러 다각형이면 모두 넣음 |
| `rooms[].hvac` | 점 목록 `[x, y]` | 사용 | 실내기 위치. 비어 있으면 호실 중심에 표시 |
| `source`, `unit`, `building`, `virtual` | 문자열·불리언 | 미사용 | 출처와 단위 기록 |

주: 원본 정의는 `frontend/src/twin3d/Twin3D.tsx`의 `Plan` 타입과 `lambda/tools/build_floorplans.py`의 생성 코드입니다.

## 3. 호실 연결: 호실 테이블과 같은 id

**3-1. 도면의 호실 `id`가 호실 테이블에 없으면 그 호실은 3D에 표시되지만 상태 색, 선택, 운영 패널과 연결되지 않습니다.**

- 운영 데이터(상태, 스케줄, AI 도구)는 호실 테이블(`maestro-Rooms`, 키 `buildingId`·`roomId`)의 호실만 사용합니다.
- 확정 저장 요청 본문 `{twin, rooms, plan}`의 `rooms`로 호실·설비 테이블을 갱신하고, 목록에서 빠진 호실의 호실·설비·상태 행은 삭제합니다. 화면 변환 코드는 `frontend/src/admin/convert.ts`입니다.
- 판매사 등록 건물의 호실 id는 `<건물 id>.<트윈 호실 id>`입니다. 다른 건물과 호실 id가 겹치면 409입니다.
- 판매사 등록 건물의 도면에는 실내기가 연결된 호실만 들어가며, y 좌표는 트윈 평면과 부호가 반대입니다(내장 3D 배치 기준).
- 건물·호실 데이터는 Lambda 실행 환경별로 60초 캐시하므로 테이블 변경은 최대 60초 뒤 반영됩니다.

## 4. 대체 경로: 웹 번들 도면

**4-1. 조회 API가 실패하면 화면은 웹 번들의 `public/floorplans/<건물>.json`을 사용합니다.**

로그인 만료(401)는 대체하지 않고 로그인 화면으로 이동합니다. 목업 모드(API 없음)도 웹 번들 도면을 사용합니다.

## 관련 자료

- [판매사 건물 관리와 고객사 관제 전용](../explanation/decisions/2026-11-20%28%ED%8C%90%EB%A7%A4%EC%82%AC%20%EA%B1%B4%EB%AC%BC%20%EA%B4%80%EB%A6%AC%EC%99%80%20%EA%B3%A0%EA%B0%9D%EC%82%AC%20%EA%B4%80%EC%A0%9C%20%EC%A0%84%EC%9A%A9%29.md), [판매사·고객사 회원 구조](../explanation/decisions/2026-11-20%28%ED%8C%90%EB%A7%A4%EC%82%AC%C2%B7%EA%B3%A0%EA%B0%9D%EC%82%AC%20%ED%9A%8C%EC%9B%90%20%EA%B5%AC%EC%A1%B0%29.md)
- 코드: `lambda/src/plan.py`, `lambda/tools/upload_plans.py`, `frontend/src/api.ts`(`getPlan`), `frontend/src/twin3d/Twin3D.tsx`
