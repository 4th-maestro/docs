# 도면 변환 규약

> **요약** (기준일 2026-11-20)
>
> - 운영자가 올린 IFC, CAD(DXF, DWG), PDF, 이미지 4종을 모두 `twin.building/v1` 초안으로 변환합니다. 운영자는 2D 화면에서 실내기 매핑을 교정·확정하고, 확정본으로 3D 트윈을 만듭니다.
> - 실내기 위치는 IFC 객체와 CAD 블록에서 우선 읽습니다. 없으면 도면 이미지를 YOLO(SageMaker Serverless Inference)로 인식합니다. 유형은 6종이며, LG 모델은 `ml/hvac_types.json` 표로 연결합니다.
> - 자동 인식은 완전하지 않으므로, 신뢰도 0.5 미만이거나 위치를 맞추지 못한 실내기는 `review: true`로 표시하고 운영자 확인을 거칩니다.
>
> | 항목 | 값 | 비교 기준 |
> |---|---|---|
> | 입력 형식 | 4종(IFC, DXF·DWG, PDF, PNG·JPG) | 2026-11-20 이전: 평면도 사진 1종 |
> | 실내기 유형 | 6종 | 이전 트윈 표시: 1방향·4방향 2종 |
> | 업로드 파일 한도 | 파일당 200MB | API Gateway 요청 한도 10MB(그래서 S3 직접 업로드) |
> | 구현 상태 | main 반영과 배포(Lambda #35, #36, #41, Frontend #27), Serverless Endpoint v7(2026-11-21) | 배포 후 상태 머신 직접 실행 전 단계 성공(2026-11-20) |
> | 실내기 인식(v7, 운영 경로 춘천초 PDF 37대) | 정밀도 0.660, 재현율 0.946(4방향 26/27, 2방향 6/6, 스탠드형 3/4) | v4 0.538, 0.757(2026-11-21 교체) |
>
> **다음 작업**: 판매사 관리자 화면에서 실제 업로드 확인, 실제 도면으로 4종 입력 통합 확인(6절)

[도면 저장 규약](plan-storage.md)은 운영 화면의 조회 형식을 정합니다. 이 문서는 업로드부터 확정까지의 변환 형식과 API를 정합니다. 실내기 인식 모델의 근거는 [도면 실내기 기호 검출 모델](../explanation/decisions/2026-11-20%28%EB%8F%84%EB%A9%B4%20%EC%8B%A4%EB%82%B4%EA%B8%B0%20%EA%B8%B0%ED%98%B8%20%EA%B2%80%EC%B6%9C%20%EB%AA%A8%EB%8D%B8%29.md)에 있습니다.

## 1. 처리 흐름: 업로드, 초안, 2D 매핑, 3D

**1-1. 모든 입력은 같은 초안 형식으로 만든 뒤 같은 2D 편집 화면에서 확정합니다.**

| 단계 | 처리 | 결과 |
|---|---|---|
| 1 업로드 | 화면이 S3 사전 서명 URL로 파일을 직접 올림 | `uploads/<작업>/<파일>` |
| 2 파싱 | 형식별 파서가 층, 호실, 실내기 후보, 도면 이미지 생성 | 초안 `twin.building/v1` |
| 3 인식 | 실내기 정보가 없는 층의 도면 이미지를 YOLO로 인식 | `detections` 또는 `idus` |
| 4 2D 매핑 | 화면이 빈 호실 실내기 추정과 실외기 연결을 채우고, 운영자가 실내기와 실외기를 추가, 삭제, 이동, 연결 변경, 도면 위치 맞춤 | 확정본 |
| 5 3D | 확정본 저장 후 팀 3D 트윈과 운영 화면 도면 갱신 | `plans/<건물>/building.json`, `current.json` |

## 2. 입력별 처리: 형식마다 호실과 실내기 출처가 다름

**2-1. 좌표가 들어 있는 IFC와 CAD는 자동으로 호실을 만들고, PDF와 이미지는 기존 트윈 파이프라인의 평면도 단계로 호실을 만듭니다.**

| 입력 | 층·호실 | 실내기 | 축척 |
|---|---|---|---|
| IFC | `IfcBuildingStorey`, `IfcSpace` 바닥 다각형 | `IfcUnitaryEquipment`와 이름이 실내기 별칭과 맞는 객체. 없으면 같은 작업으로 올린 설비도면 이미지를 YOLO로 인식 | 파일 단위 |
| DXF | 벽 레이어 선을 닫힌 영역으로 바꿔 호실 생성, 영역 안 문자로 실 이름 지정 | 블록 이름·속성이 별칭과 맞는 `INSERT`. 판정하지 못한 층은 렌더링 후 YOLO | `$INSUNITS`, 없으면 mm |
| DWG | libredwg `dwg2dxf`로 DXF 변환 후 DXF와 같음 | DXF와 같음 | DXF와 같음 |
| PDF | 페이지를 PNG로 렌더링해 트윈 파이프라인 평면도 단계에 넣음 | 렌더링한 페이지를 YOLO로 인식 | 도면의 `1/200` 문자와 용지 크기, 없으면 2D 화면에서 기준 치수 입력 |
| 이미지 | 트윈 파이프라인 평면도 단계(기존) | 원근 보정한 평면도 이미지를 YOLO로 인식 | 파이프라인의 건물 크기 입력 |

주: 실내기 별칭은 `ml/hvac_types.json`의 `aliases`(정규식, 대소문자 무시)입니다. IFC는 `IfcEnergyConversionDevice`, `IfcFlowTerminal`, `IfcFlowMovingDevice`, `IfcBuildingElementProxy`만 별칭을 검사합니다. 모든 객체를 검사하면 덕트 구간과 "Standard" 이름 객체가 실내기로 판정됩니다. CAD 블록 이름의 `_`는 공백으로 바꿔 검사합니다. `AC_WALL`처럼 "wall"만 있는 이름은 벽걸이형으로 판정하지 않습니다. IFC에서 별칭이 맞지 않는 객체는 치수로 판정합니다. 바닥에 있고 높이 1.2m 이상이면 스탠드형, 벽에 붙어 있고 깊이 0.35m 이하이면 벽걸이형으로 보며, 판정하지 못하면 `unknown`입니다.

## 3. 초안·확정 형식: `twin.building/v1` 확장 필드

**3-1. 기존 `twin.building/v1`을 그대로 쓰고, 선택 필드만 추가합니다. 기존 데이터와 화면은 추가 필드가 없어도 동작해야 합니다.**

좌표는 m이고, 원점은 건물 왼쪽 위입니다. x는 오른쪽, y는 아래쪽으로 증가합니다(기존 `frontend/twin/data/building.json`과 같음).

| 위치 | 필드 | 형식 | 의미 |
|---|---|---|---|
| `idus[]` | `cls` | 문자열 | `cassette_4way`, `cassette_1way`, `wall_mounted`, `ceiling_duct`, `floor_standing`, `cassette_2way`, `unknown` |
| `idus[]` | `type` | 문자열 | 표시 이름(`hvac_types.json`의 `name`, 예: 천장형 4방향 카세트) |
| `idus[]` | `model`, `manual` | 문자열 | 원본에 모델명이 있으면 원본 값, 없으면 LG 예시 모델과 매뉴얼 URL |
| `idus[]` | `source` | 문자열 | `ifc`, `cad`, `yolo`, `manual`, 기존 값(`estimate` 등) |
| `idus[]` | `conf` | 0~1 | YOLO 신뢰도. IFC·CAD 별칭 일치는 1, 치수 판정은 0.6 |
| `idus[]` | `review` | 불리언 | 운영자 확인 필요(신뢰도 0.5 미만, `unknown`, 호실 미배정, 도면 위치 미맞춤) |
| `idus[]` | `rot`, `size` | 숫자, `[w, d]` | 토출 방향(도, 0은 +x, 90은 +y 아래쪽)과 x·y 방향 바닥 투영 크기(m). 파서는 아직 `rot`을 만들지 않음 |
| `idus[]` | `ref` | 문자열 | 원본 식별자(IFC GlobalId, CAD 핸들, 인식 번호) |
| `idus[]` | `floor` | 문자열 | 층 id. 호실을 배정하지 못한 실내기(PDF 층 등)도 층을 유지 |
| `idus[]` | `odu` | 문자열 | 연결 실외기 id. 3D 트윈 설비 연결 화면의 배관 대상 |
| `odus[]` | `id`, `serves` | 문자열 | 실외기 id(자동 생성은 `ODU-<층>-W`, `ODU-<층>-E`, 직접 추가는 `ODU-<층>-<번호>`)와 연결 층 |
| `odus[]` | `model`, `location` | 문자열 | 기본값 `LG MULTI V 실외기`, `옥상 서측`·`옥상 동측` |
| `odus[]` | `mark` | `[x, y]` | 2D 매핑 화면의 실외기 기호 위치(m). 3D 옥상 배치(`pos`, 없으면 트윈 자동 배치)와 별개 |
| `floors[]` | `elevation` | 숫자(m) | 층 바닥 높이 |
| `floors[]` | `background` | 객체 | `key`(S3 키), `px`(`[w, h]`), `toPlan`(`[a, b, c, d, e, f]`, `x = a·u + b·v + c`, `y = d·u + e·v + f`, 미맞춤이면 `null`) |
| `floors[]` | `detections` | 목록 | 위치를 맞추지 못한 YOLO 결과 `{cls, conf, box: [u0, v0, u1, v1]}`(도면 이미지 픽셀). 2D 화면에서 맞춘 뒤 `idus`로 바꾸고 비움 |
| `floors[]` | `doors` | 목록 | 문 `{id, a: [x, y], b: [x, y], hinge, side, source, conf, review, ref}`. `a`, `b`는 벽 위 문 개구부 양 끝(m), 폭은 두 점 거리. `hinge`는 경첩 쪽 끝(`a` 또는 `b`), `side`는 열리는 쪽(a→b 기준 왼쪽 1, 오른쪽 -1). `source`는 `ifc`, `cad`, `yolo`, `manual`. 필드가 없으면 트윈이 호실마다 문 1개를 임의 생성 |
| 최상위 | `meta.ingest` | 객체 | `jobId`, `kind`(`ifc`, `cad`, `pdf`, `image`), `files`, `createdAt`, `warnings`, `model`(인식 모델 버전) |

**3-2. 2D 화면의 도면 위치 맞춤은 기준점 2쌍(도면 이미지 점과 평면 점)으로 회전, 축척, 이동을 구해 `toPlan`을 채웁니다.**

호실 배정은 실내기 위치를 포함하는 호실 다각형입니다. 포함 호실이 없으면 가장 가까운 호실을 넣고 `review: true`로 표시합니다.

**3-4. 문은 입력마다 출처가 다르고, 인식 결과는 가장 가까운 호실 변에 맞춰 벽 위 구간으로 바꿉니다(2026-11-21 규약, 구현 중).**

| 입력 | 문 출처 |
|---|---|
| IFC | `IfcDoor`의 위치, 폭(`OverallWidth`), 배치 방향. 경첩, 열림 방향을 모르면 `hinge: a`, `side: 1` |
| DXF, DWG | 이름이 문 별칭(`DOOR`, `DR`, `문`, 대소문자 무시)과 맞는 블록 `INSERT`, 또는 벽 틈 옆 반지름 0.6~2.0m 호(ARC). 호 중심이 경첩, 반지름이 폭 |
| PDF, 이미지 | 인식 모델의 `door` 클래스(호와 문짝 선의 외접 상자). 위치를 맞추기 전에는 `detections`에 `cls: door`로 남음 |

인식 상자는 상자 중심에서 가장 가까운 호실 다각형 변(거리가 상자 긴 변 이하)에 투영한 구간을 문으로 만듭니다. 폭은 상자 긴 변입니다. 맞는 변이 없거나 폭이 0.6~2.0m 밖이면 `review: true`입니다. `cls: door` 인식 결과는 실내기로 바꾸지 않습니다. 2D 화면은 문을 호 기호로 표시하고 추가, 삭제, 이동, 경첩 뒤집기를 지원합니다. 3D 트윈은 `doors`가 있는 층에서 임의 문 대신 이 문을 그립니다.

**3-3. 2D 화면은 실내기가 없는 실에 면적 추정 실내기를 넣고, 모든 실내기를 층별 서·동 실외기에 연결합니다(2026-11-21, Frontend #53).**

| 처리 | 시점 | 규칙 |
|---|---|---|
| 빈 호실 실내기 추정 | 초안을 열 때, 층 위치 맞춤 후 그 층, "빈 호실 실내기 추정" 버튼(현재 층) | 실내기가 없는 실(`type: room`)에 40㎡당 1대, 40㎡ 미만은 1방향, 이상은 4방향 카세트(트윈 파이프라인 `placeIdus`와 같음). `source: estimate`, `review: true` |
| 실외기 연결 | 초안을 열 때, 도면 편집을 열 때, 실내기를 추가할 때 | `odu`가 없는 실내기는 x가 건물 폭의 절반 미만이면 `ODU-<층>-W`, 이상이면 `ODU-<층>-E`. 목록에 없는 실외기는 만들고, `mark`가 없으면 평면 좌우 2m 바깥에 둠 |
| 제외 | 위치를 맞추지 않은 인식 결과(`detections`)가 남은 층 | 위치 맞춤 후 인식 결과가 실내기가 되므로 추정하지 않음 |

운영자는 실내기 도구에서 실외기 기호를 끌어 옮기고, 실내기를 고른 뒤 실외기 기호를 눌러 연결을 바꿉니다. 실내기 카드의 실외기 선택으로도 바꿀 수 있습니다. 실외기를 삭제하면 연결된 실내기는 같은 층에서 가장 가까운 실외기로 옮깁니다. 층의 마지막 실외기에 실내기가 연결되어 있으면 삭제하지 않습니다.

## 4. API: 작업 생성, 시작, 조회, 확정 저장

**4-1. 업로드, 변환, 확정 저장은 판매사 관리자(Cognito `admin` 그룹)만 사용할 수 있습니다. 고객사 계정은 관제·제어만 합니다(2026-11-20 사용자 결정).**

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `POST /plans/jobs` | `{building, kind, files: [{name, size}]}` | 201 `{jobId, uploads: [{name, key, url}]}`(PUT URL 15분) |
| `POST /plans/jobs/{jobId}/start` | `{options?: {scale?, pxPerM?}}`(양수 숫자, 예: `scale: 200`) | 202 `{status: "running"}` |
| `POST /plans/detect` | `{building, key, pxPerM?}`(같은 건물 작업으로 올린 보정 이미지) | 202 `{jobId}`. 작업 `kind`는 `detect`, 초안은 `{floor, detections, model}` |
| `GET /plans/jobs/{jobId}` | 없음 | `{jobId, building, kind, status, step, error?, draftUrl?, pages?: [{floor?, url, px}]}` |
| `PUT /buildings/{id}/twin` | `{twin, rooms, plan}` | 200 `{building, version}` |
| `GET /buildings/{id}/twin` | 없음 | 확정본 `twin.building/v1` |

- 작업 상태 `status`는 `created`, `running`, `review`(초안 완료), `failed`, `done`(확정 저장)입니다. `step`은 `parse`, `detect`, `merge`입니다(PDF 렌더링은 `parse`에 포함). 재시작은 `created`, `failed` 상태에서만 됩니다.
- `GET`·`PUT /buildings/{id}/twin`과 건물 등록(`POST /admin/companies/{companyId}/buildings`), 수정·삭제(`PATCH`·`DELETE /admin/buildings/{id}`)는 판매사 건물 관리 기능(Lambda `feat/vendor-buildings`)의 API를 재사용합니다.
- 확정 저장 본문은 `{twin, rooms, plan}`입니다. 화면이 확정본(`twin`)을 `src/admin/convert.ts`로 호실 테이블 행(`rooms`)과 [도면 저장 규약](plan-storage.md) 형식(`plan`)으로 변환합니다. 서버는 `twin`을 `plans/<건물>/building.json`과 `building-v<번호>.json`, `plan`을 `v<번호>.json`과 `current.json`, `rooms`를 트윈 Rooms·Equipment 테이블에 반영합니다.
- 호실 id는 다른 건물과 겹치면 409입니다. 화면이 저장 전에 모든 호실 id(`floors[].rooms[].id`, `idus[].room`, `aps[].room`·`in`, `zoneOf`)에 `<건물 id>.` 접두어를 붙입니다. 새 건물 id는 `b-`와 소문자·숫자 8자입니다.
- 작업 기록은 DynamoDB `PlanJobs` 테이블에 7일 보관(TTL)합니다. `uploads/`와 `jobs/`는 건물 기준 키가 아니라 건물 삭제로 지워지지 않으므로, S3 수명 주기 규칙으로 7일 뒤 삭제합니다. 변환 함수의 S3 권한은 이 두 접두어로 한정합니다.

| S3 키(도면 버킷) | 내용 |
|---|---|
| `uploads/<jobId>/<파일>` | 원본 업로드(수명 주기 7일) |
| `jobs/<jobId>/draft.json` | 초안(수명 주기 7일) |
| `jobs/<jobId>/pages/<번호>.png` | 렌더링한 도면 이미지(배경, 인식 입력, 수명 주기 7일) |
| `plans/<건물>/building.json`, `building-v<번호>.json` | 확정본과 버전(`v<번호>.json`과 같은 번호, 기존 최대값 + 1). 건물 삭제 시 `plans/<건물>/`만 삭제 |

**4-2. 변환은 Step Functions 상태 머신 1개로 처리합니다.**

`Parse`(컨테이너 Lambda, 형식별 파서) → `NeedDetect`(분기) → `Detect`(Lambda, Serverless Endpoint 호출) → `Merge`(인식 결과 좌표 변환, 호실 배정, LG 모델 연결) → `SaveDraft`(상태 `review`). 모든 단계의 오류는 `Fail` 처리로 상태 `failed`와 오류 메시지를 기록합니다. 인식 전용 작업은 `Route`에서 바로 `Detect`로 가고, `SaveDetections`가 초안을 저장합니다.

주: Step Functions 상태 데이터 한도는 256KB입니다. 검출이 수천 개를 넘거나 `States.Runtime` 오류가 나면 실행이 Catch로 처리되지 않아 작업이 `running` 상태로 남습니다. 이 경우 7일 뒤 TTL로 삭제됩니다.

## 5. 인식 Endpoint: 타일 1장 입력, 픽셀 좌표 출력

**5-1. Serverless Endpoint는 상시 요금이 없으며, 호출 Lambda가 도면을 타일로 나눠 보냅니다.**

| 항목 | 값 |
|---|---|
| 이름 | `hvac-symbol-detector-sls`(메모리 6,144MB, 최대 동시 실행 2) |
| 요청 | `image/png` 또는 `image/jpeg`, 1장 4MB 이하(Serverless 요청 한도), 한 변 1,400px 이하 권장 |
| 응답 | `{"model": "v<버전>", "size": [w, h], "detections": [{"cls", "conf", "box": [u0, v0, u1, v1]}]}`, 신뢰도 0.25 이상 |
| 호출 쪽 처리 | 1m당 80px로 크기 조정(축척을 알 때), 1,400px 타일(1,000px 간격), 타일 결과 NMS(IoU 0.5) 후 원본 픽셀로 환산 |

주: Serverless Endpoint는 호출이 없으면 요금이 없어 루트 `AGENTS.md` "SageMaker Endpoint 비용 관리"의 생성·삭제 규칙 대상이 아닙니다. 실시간 Endpoint로 바꾸면 그 규칙을 따르십시오.

## 6. 구현 분담과 남은 일

**6-1. 파서, API, 화면은 2026-11-20 main에 반영해 배포했고, 인식 Endpoint는 2026-11-21 v7 모델로 교체했습니다.**

배포 직후 IngestFunction이 ifcopenshell import에 실패해 x86_64로 바꿨습니다([장애 기록](../explanation/troubleshooting/2026-11-20%28%EB%8F%84%EB%A9%B4%20%EB%B3%80%ED%99%98%20%EC%BB%A8%ED%85%8C%EC%9D%B4%EB%84%88%20ifcopenshell%20GLIBC%20%EB%B6%88%EC%9D%BC%EC%B9%98%29.md)). 재배포 후 상태 머신을 직접 실행해 Parse, Detect, Merge, SaveDraft가 모두 성공했습니다.

| 영역 | 위치 | 상태 |
|---|---|---|
| 파서(IFC, DXF·DWG, PDF, 병합) | Lambda `ingest/`(#35) | 테스트 12개 통과, DWG 1개 건너뜀. 공개 IFC 2개로 층 3개, 호실 21개 추출(0.3초) |
| 작업 API, Step Functions, 인식 호출 Lambda | Lambda `src/plan_ingest.py`, `src/detect.py`, `statemachine/`(#36) | 테스트 통과, `sam validate --lint` 통과 |
| 업로드, 2D 실내기 매핑, 3D 유형별 형상 | Frontend `src/ingest/`, 판매사 건물 추가의 도면 파일 단계(#27) | 데모 모드 화면 확인(1440px, 390px, 밝은·어두운 화면) |
| 트윈 층 평면도 유형별 기호와 범례 | Frontend `twin/pipeline/idu-shapes.js`, `twin/digital-twin.html`(#45) | 1440px 밝은·어두운 화면 확인, 390px 미확인 |
| 인식 Endpoint | `ml/serve/`, `hvac-symbol-detector-sls`(v7) | 타일당 1.0초, ultralytics와 결과 일치 |

**6-2. 실제 설비도면 PDF(춘천초 14쪽)를 배포한 상태 머신에 넣어 222초에 초안을 만들었고, 4방향 카세트 재현율은 0.93입니다.**

| 항목(라벨 있는 4~8쪽, 신뢰도 0.5 이상, IoU 0.5) | 값 | 비교 기준 |
|---|---|---|
| 처리 시간, 쪽수 | 222초, 14쪽 | 없음(첫 측정) |
| 축척 인식 | 12쪽 1/200, 2쪽 1/100 | 도면 표기와 일치 |
| 전체 정밀도, 재현율 | 0.538, 0.757(37대 중 28대) | 평가 타일 v4 mAP50 0.775 |
| 4방향 카세트 재현율 | 0.93(27대 중 25대) | 평가 타일 0.938 |
| 스탠드형 재현율 | 0.75(4대 중 3대) | 평가 타일 0.543 |
| 2방향 카세트 재현율 | 0(6대 모두 스탠드형으로 판정) | 평가 타일 0.847 |
| 오검출(평면 안, 평면 밖) | 17개, 1개 | 덕트형 6, 4방향 4, 벽걸이 4, 1방향 3 |

주: 같은 건물로 모델을 조정해 실제 성능보다 높게 나올 수 있습니다. v6는 같은 측정에서 재현율 0.514로 낮아 v4를 유지했고, v7은 정밀도 0.660, 재현율 0.946(2방향 6/6, 4방향 26/27)으로 교체했습니다(기술 선택 기록 14, 15절). 같은 층 표기가 겹친 7쪽은 `P<쪽>` 층으로 저장됐습니다. 2방향 혼동은 [기술 선택 기록](../explanation/decisions/2026-11-20%28%EB%8F%84%EB%A9%B4%20%EC%8B%A4%EB%82%B4%EA%B8%B0%20%EA%B8%B0%ED%98%B8%20%EA%B2%80%EC%B6%9C%20%EB%AA%A8%EB%8D%B8%29.md) 13절입니다.

| 작업 | 기한 | 담당 |
|---|---|---|
| 판매사 관리자 계정으로 화면에서 업로드, 변환, 확정 저장 확인 | 미정 | 사용자 |
| 실제 IFC(실내기 객체 포함), DXF, DWG, PDF로 4종 입력 통합 확인 | 미정 | 미정 |
