# infra/ops — ③ 자동 운영 + ⑤ 규칙 기반 설정온도 제안 + 사람 승인

5분마다 빈 방 운전·과냉·과열 설정·이상 호실을 찾아 (빈 방은 Jev로) 판단하고, **건물별 자동 운영 스위치**에 따라 바로 끄거나(ON) 운영자에게 제안합니다(OFF). 별도 스택 **`maestro-ops`**로 배포하고, API는 `maestro` 스택의 기존 HTTP API에 경로만 추가합니다. 웹은 같은 API 주소와 같은 로그인 토큰을 씁니다.

| 파일 | 내용 |
|---|---|
| `template.yaml` | SAM: src Layer, 설정·결정 테이블, Jev 키 시크릿(빈 그릇), 5분 판단 Lambda, API Lambda + 기존 HTTP API 경로 3개 |
| `functions/auto_operator.py` | 5분 판단: 후보 → Jev(빈 방)·규칙(설정온도) → 결정 게이트 → 자동 조치·제안·알림 기록 |
| `functions/ops_api.py` | 스위치·제안 목록·수락/거절/되돌리기 API |
| `functions/ops_common.py` | 설정·결정 저장소, 스케줄 저장, 제안 문구 |
| `tests/test_ops.py` | 오프라인 테스트 35개 |

## 동작

```
5분마다 auto-operator
 ├─ 후보: 빈 방 운전 = 지금·15분 전·30분 전 모두 재실 0명인데 운전 중 (src/recommend.py 'idle' 규칙과 같은 기준)
 │        설정온도 = 운전 중이고 빈 방 후보가 아닌 호실의 냉방 26℃ 미만·난방 20℃ 초과 (src/recommend.py 'overset'과 같은 기준)
 │                   → Jev 없이 스위치 ON이면 바로 조정(applied), OFF면 제안(pending) "…바꿀까요?"
 │        이상     = 설정온도 미도달(sim.state anomaly) → Jev 없이 🔴 알림
 ├─ Jev 판단(빈 방): room_empty = empty / occupied / uncertain + 확신도·확률
 │   입력 = 건물·호실, 0·15·30분 전 상태 + 파생 사실(facts: 운영 시간 안팎·종료 후 경과, 빈 채 운전 지속 시간,
 │          오늘 마지막 재실·사용 구간 수, 최근 7일 같은 시각 사용 일수, 빈 채 운전 전력량)
 └─ 결정 게이트
     ├─ occupied + 확신도 0.8 이상                  → skipped (조치·제안 없음)
     ├─ 스위치 ON + empty + 확신도 0.8 이상 + empty 확률 0.9 이상 → 🟢 끄기 스케줄 저장(applied) + "껐어요" 알림, [되돌리기]
     └─ 그 외(스위치 OFF, 확신도 낮음, Jev 실패) → 🟡 제안(pending) "…끌까요?" [수락] [거절]
```

- **스케줄 저장:** 자동 조치와 수락 모두 `SchedulesTable`(maestro 스택)에 `schedules.py` POST와 같은 형식으로 저장합니다.
  - 형식: `{action: off, condition: unused, time: 판단 시각, sourceText: "자동 운영: …"}`
  - simulator가 다음 계산부터 반영합니다.
  - `condition=unused`라서 재실이 생기면 적용되지 않습니다.
  - 스케줄은 기존 규칙대로 **매일 지정 시각 이후** 적용됩니다. 되돌리기를 하면 스케줄을 삭제합니다.
- **설정온도 제안(⑤ 규칙 기반 제어, `kind=setpoint`)**
  - 기준값(`COOL_MIN`·`HEAT_MAX`)과 절감량 계산(`recommend.saving`)은 `src/recommend.py`를 그대로 씁니다. `recommend()`는 호실당 1건이라 업무 외 운전(`after_hours`)이 먼저 잡히면 설정 추천이 빠지므로 직접 판정합니다.
  - 빈 방 운전 호실은 끄기가 우선이라 설정온도 후보로 보지 않습니다. 꺼진 방과 절감량 0인 방도 제안하지 않습니다.
  - 스케줄: `{action: setpoint, setpoint: 목표, time: "00:00", condition: always}`(recommend 초안과 같음, 매일 하루 전체). 되돌리기는 스케줄 삭제입니다.
  - 근거(`evidence`): `mode`, `setpoint`(현재), `target`, `savingKwhDay`(하루 절감 kWh, 가상), `temp`, `powerKw`, `occupants`, `rule: overset`
  - 상한: 건물당 실행마다 `MAX_SETPOINT_PER_BUILDING`(기본 5)건, 절감량 큰 방부터. Jev 호출 상한과 무관합니다.
- **중복 방지:** 진행 중(응답 대기·자동 조치·수락)인 호실은 다시 판단하지 않습니다. 거절·되돌림·재실 판단·알림 뒤에는 쿨다운(기본 120분) 동안 다시 판단하지 않습니다.
- **만료:** 제안은 기본 30분 안에 응답이 없으면 `expired`가 됩니다.
- **Jev 비용 보호:** 실행당 최대 10건만 호출합니다. 넘는 후보는 다음 실행으로 미룹니다.
  - **배분:** 10건을 건물마다 한 건씩 돌아가며 나눕니다. 한 건물이 독차지하지 않게 하기 위해서입니다. 시작 건물은 5분 실행마다 한 칸씩 바뀝니다. 다른 건물 후보가 없으면 한 건물이 10건을 모두 씁니다.
  - **건물 안 순서:** 빈 채로 켜져 있던 전력량(`facts.idleEnergyKwh`)이 큰 방부터 판단합니다. 그래서 상한 때문에 밀려도 절감 효과가 큰 방이 먼저 제안됩니다.
- **Jev 실패:** 키가 없거나, 호출이 실패하거나, 응답이 이상하면 판단 없이 제안으로 보냅니다(자동 조치 안 함). 키와 응답 원문은 로그에 남기지 않습니다.

## 권한

| 동작 | 판매사 admin | 고객사 manager | 고객사 operator |
|---|---|---|---|
| 자동 운영 스위치 변경 | ✅ | ✅ | ❌ (403) |
| 제안·알림 조회, 수락·거절·되돌리기 | ✅ | ✅ | ✅ |

건물 접근과 중지 기업은 `src/tenant.py`(`require_building`) 그대로 검사합니다.

## API (프런트용)

기존 `VITE_API_BASE_URL`과 `Authorization: Bearer <액세스 토큰>`을 그대로 씁니다.

### `GET /buildings/{id}/operations`

화면이 1분마다 조회하는 걸 권장합니다(실시간 푸시는 이후).

```json
{
  "settings": {"buildingId": "main", "autoApply": false, "updatedAt": null, "updatedBy": null},
  "pendingCount": 2,
  "decisions": [
    {
      "decisionId": "20261120T1900-1a2b3c4d", "kind": "idle", "status": "pending",
      "roomId": "...", "roomName": "Audio", "floor": "1F", "use": "회의실",
      "message": "1F Audio: 30분째 재실 0명인데 냉난방이 켜져 있어요(0.57kW). 끌까요?",
      "createdAt": "2026-11-20T19:00:00+09:00", "expiresAt": "2026-11-20T19:30:00+09:00",
      "jev": {"choice": "uncertain", "confidence": 0.62}, "autoApply": false,
      "evidence": {"recent": [{"minutesAgo": 0, "occupants": 0, "onOff": true, "powerKw": 0.57, "temp": 20.1, "setpoint": 20}]}
    }
  ]
}
```

- `decisions`: 최근 24시간, 최신순입니다. Jev가 재실로 판단한 `skipped`는 빠집니다.
- 화면 표시 기준

| kind / status | 카드 | 버튼 |
|---|---|---|
| `idle` / `pending` | 🟡 제안 (`message`) | 수락, 거절 |
| `idle` / `applied` | 🟢 자동으로 껐음 | 되돌리기 |
| `idle` / `accepted` | 수락해서 껐음 | 되돌리기 |
| `setpoint` / `pending` | 🟡 설정온도 제안 (`message`) | 수락, 거절 |
| `setpoint` / `applied` · `accepted` | 🟢 설정온도 바꿨음 | 되돌리기 |
| `anomaly` / `alert` | 🔴 이상 알림 | 없음 |
| `rejected` · `reverted` · `expired` | 처리 기록(흐리게) | 없음 |

### `PUT /buildings/{id}/operations/settings`

본문은 `{"autoApply": true}`입니다. 응답은 저장한 설정이에요. 고객사 operator가 호출하면 403, 값이 bool이 아니면 400입니다.

### `POST /buildings/{id}/operations/decisions/{decisionId}/{action}`

`action`은 `accept` · `reject` · `undo` 중 하나예요. 응답은 바뀐 결정이고, `accept`일 때는 저장한 `schedule`도 함께 와요. 스케줄은 `idle`이면 끄기, `setpoint`면 `evidence.target` 설정온도예요.

| 상태 코드 | 경우 |
|---|---|
| 404 | 없는 제안 |
| 409 | 이미 처리됨 또는 만료(동시에 두 명이 눌러도 한 번만 반영) |
| 400 | 잘못된 action |

## 배포

배포는 `main` 기준입니다(루트 README 배포 규칙). `maestro`·`maestro-twin` 스택이 먼저 있어야 합니다. Lambda 폴더에서 실행합니다.

```bash
R="--profile maestro --region ap-northeast-2"
res() { aws cloudformation describe-stack-resource --stack-name maestro --logical-resource-id "$1" --query StackResourceDetail.PhysicalResourceId --output text $R; }
API=$(res Api)
AUTH=$(aws apigatewayv2 get-authorizers --api-id "$API" --query "Items[?Name=='Cognito'].AuthorizerId" --output text $R)

git switch main && git pull --ff-only \
  && test -z "$(git status --porcelain --untracked-files=no)" \
  && sam build -t infra/ops/template.yaml --build-dir .aws-sam/ops-build \
  && sam deploy -t .aws-sam/ops-build/template.yaml --stack-name maestro-ops $R \
     --capabilities CAPABILITY_IAM --resolve-s3 --no-confirm-changeset --no-fail-on-empty-changeset \
     --parameter-overrides ApiId=$API AuthorizerId=$AUTH OperatorEnabled=false \
       SchedulesTableName=$(res SchedulesTable) MembersTableName=$(res MembersTable) \
       OwnersTableName=$(res BuildingOwnersTable) CompaniesTableName=$(res CompaniesTable)
```

- **판단 스케줄:** `OperatorEnabled=false`가 기본값입니다. Jev 키를 넣고 simulator를 켠 뒤 데모·검증 기간에만 `true`로 바꾸십시오.
- **Windows 빌드:** `PYTHONUTF8=1`과 Python 3.12가 필요합니다(`infra/twin/README.md` 참고).

### Jev 키 입력 (키 소유자가 직접)

스택이 빈 시크릿 `maestro/jev-api-key`를 만듭니다. 키를 채팅이나 커밋에 붙이지 마십시오. Windows PowerShell에서는 입력창에 키를 붙여 넣으면 됩니다(화면·명령 기록에 남지 않음).

```powershell
$s = Read-Host "Jev API 키" -AsSecureString; $k = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); aws secretsmanager put-secret-value --secret-id maestro/jev-api-key --secret-string $k --profile maestro --region ap-northeast-2 --query ARN --output text; Remove-Variable k, s
```

## 검사와 테스트

```bash
sam validate --lint -t infra/ops/template.yaml --region ap-northeast-2
python -X utf8 -m unittest discover -s infra/ops/tests
python -X utf8 infra/ops/functions/auto_operator.py --dry-run --at 2026-11-20T19:00:00   # 저장·Jev 없이 후보·결정 미리 보기
```

## 협의 사항

- `SchedulesTable`(maestro 스택) 쓰기(끄기·설정온도 스케줄)와 기존 HTTP API 경로 추가는 백엔드 담당 동의가 필요합니다.
- 화면(스위치, 제안·알림 카드)은 프런트 담당이 위 API로 구현합니다.
