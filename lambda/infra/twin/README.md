# infra/twin — ② 디지털 트윈 데이터 기반

건물·호실·설비 정보와 호실 상태·이력, 기상·재실 데이터를 담는 DynamoDB 테이블, 그리고 1분마다 호실 상태를 계산해 기록하는 simulator입니다. 기존 `maestro` 스택(`template.yaml`)과 분리된 **`maestro-twin` 스택**으로 배포해서 팀원 배포와 서로 덮어쓰지 않습니다.

`maestro` 스택의 조회 API가 Buildings·Rooms 테이블을 읽습니다(#23). 테이블 이름·키를 바꾸거나 스택을 지우면 서비스가 멈춥니다.

| 파일 | 내용 |
|---|---|
| `template.yaml` | SAM 템플릿: DynamoDB 테이블 7개, src Layer, simulator Lambda + 1분 스케줄, 출력(Export) |
| `functions/simulator.py` | 1분 주기 상태 계산: `src/sim.py`의 `state()` → State·Timeseries·Occupancy |
| `seed.py` | `src/buildings.json`·`rooms.json` → Buildings·Rooms·Equipment 적재 |
| `tests/test_simulator.py` | simulator 오프라인 테스트 |

## 테이블

모두 온디맨드(PAY_PER_REQUEST)입니다. 이름은 `<Prefix>-<테이블>`이고, `Prefix` 기본값은 `maestro`입니다.

| 테이블 | 키 (PK / SK) | 내용 | 채우는 곳 |
|---|---|---|---|
| Buildings | `buildingId` | `buildings.json` 필드 그대로(floors, hours, weekend, waste, remap 등) | `seed.py` |
| Rooms | `buildingId` / `roomId` | name, floor, use, areaM2, idu. 가상 건물 호실은 `buildings.rooms()` 결과(id `건물.층.GUID`) | `seed.py` |
| Equipment | `buildingId` / `equipmentId` | 실내기(호실당 1대): roomId, floor, type=`IDU`, ratedKw(`sim.rated()` 식). LG 모델 매핑은 이후 추가 | `seed.py` |
| State | `buildingId` / `roomId` | 호실 현재 상태(`sim.state()` 필드 + updatedAt). **Streams NEW_AND_OLD_IMAGES** | simulator(1분) |
| Timeseries | `pk`=`건물#호실` / `ts` | 상태 이력, `ttl`(30일) 자동 삭제 | simulator(기본 5분) |
| Weather | `location` / `ts` | 기상 관측, `ttl` | weather 스택(`infra/weather/`, PR #24) |
| Occupancy | `pk`=`건물#호실` / `ts` | 재실 인원 이력, `ttl`(30일) | simulator(기본 5분) |

`ts`는 KST ISO 시각 문자열(예 `2026-11-20T15:40:00+09:00`)입니다.

## simulator

- **계산:** `src/sim.py`의 `state()`를 그대로 씁니다(5R1C 교체 전 단계). 그래서 조회 API가 직접 계산한 값과 같습니다.
- **대상:** `src/buildings.py`가 읽은 전 건물·전 호실입니다. Buildings·Rooms 테이블과 고객사 수정 정보를 반영하고, `active=false` 호실은 제외합니다.
- **팀 코드 사용:** `src/` 모듈은 Lambda Layer(`TwinSrcLayer`, `src/requirements.txt` 포함)로 **import만** 합니다. 팀 코드를 수정하지 않습니다.
- **스케줄:** `SchedulesTableName`을 지정하면 저장된 스케줄(켜기·끄기·설정온도)을 반영합니다.
- **기준 시각:** EventBridge 이벤트 시각을 KST 분 단위로 맞춥니다. 지연 실행이나 재실행도 같은 분이면 같은 키라서 중복이 생기지 않습니다.
- **기록:**
  - State는 매 실행 덮어씁니다.
  - Timeseries·Occupancy는 `HistoryEveryMinutes`분 정각마다 추가합니다.
- **건물 목록 새로 읽기:** 매 실행 `buildings.forget()`으로 60초 캐시를 비웁니다. 판매사가 건물을 삭제·교체한 직후 이전 목록으로 State를 다시 쓰지 않게 하기 위해서입니다(#34 미확인 항목).
- **State 정리:** 10분 정각마다 State에서 이번 계산 대상이 아닌 행을 지웁니다. 삭제된 건물·호실과 비활성 호실이 대상입니다.
  - 계산 대상이 0건이면 정리하지 않습니다(테이블 읽기 이상 시 전체 삭제 방지).
  - Timeseries·Occupancy 이력은 지우지 않습니다(#34 방침, ttl 30일).
- **실패:** 재시도하지 않습니다. 다음 분 실행이 같은 일을 합니다.
- **로그:** `/aws/lambda/<함수명>`, 14일 보관. 실행마다 `{"at", "rooms", "history", "removed", "ms"}`를 남기고, 정리한 행이 있으면 `removedState` 목록(최대 20건)을 남깁니다.

**배포 파라미터**

| 파라미터 | 기본값 | 내용 |
|---|---|---|
| `SimulatorEnabled` | `false` | 1분 스케줄 켜기. **기본 꺼짐**: 쓰기 비용이 있어 데모·검증 기간에만 `true` |
| `HistoryEveryMinutes` | `5` | 이력 기록 주기(분) |
| `SchedulesTableName` | 빈 값 | `maestro` 스택 `SchedulesTable` 실제 이름. 비우면 스케줄 반영 안 함 |
| `OwnersTableName` | 빈 값 | `maestro` 스택 `BuildingOwnersTable` 실제 이름. 비우면 고객사가 수정한 운영 시간 반영 안 함 |

**쓰기 비용 추정 (533호실, 기본 설정)**
- State 1분: 하루 약 77만 건
- 이력 5분 × 2개 테이블: 하루 약 15만 건
- 합계 하루 약 92만 건. 쓰지 않을 때는 `SimulatorEnabled=false`로 다시 배포하십시오.

## 배포

배포는 `main` 기준입니다(루트 README의 배포 규칙과 동일). Lambda 폴더에서 실행합니다.

**도구**
- SAM CLI: `uv tool install aws-sam-cli`
- `sam build`에는 Python 3.12가 필요합니다(Layer 빌드).

```bash
git switch main && git pull --ff-only \
  && test -z "$(git status --porcelain --untracked-files=no)" \
  && sam build -t infra/twin/template.yaml --build-dir .aws-sam/twin-build \
  && sam deploy -t .aws-sam/twin-build/template.yaml --stack-name maestro-twin \
     --region ap-northeast-2 --profile maestro --capabilities CAPABILITY_IAM --resolve-s3 \
     --no-confirm-changeset --no-fail-on-empty-changeset \
     --parameter-overrides SimulatorEnabled=true \
       SchedulesTableName=$(aws cloudformation describe-stack-resource --stack-name maestro --logical-resource-id SchedulesTable --query StackResourceDetail.PhysicalResourceId --output text --profile maestro --region ap-northeast-2) \
       OwnersTableName=$(aws cloudformation describe-stack-resource --stack-name maestro --logical-resource-id BuildingOwnersTable --query StackResourceDetail.PhysicalResourceId --output text --profile maestro --region ap-northeast-2)
```

- **빌드 디렉터리:** `--build-dir`을 따로 지정합니다. 루트 `maestro` 스택 빌드 결과(`.aws-sam/build`)와 섞이지 않게 하기 위해서입니다.
- **`samconfig.toml`:** `.gitignore` 대상이라 옵션을 매번 지정합니다.
- **Windows:** `sam build`가 인코딩 오류(`UnicodeDecodeError`)로 실패하면 이렇게 하십시오.
  1. `PYTHONUTF8=1`을 붙여 실행합니다.
  2. 이전 실패로 남은 `.aws-sam/build.toml`을 지우고 다시 실행합니다.
- **Python 3.12가 PATH에 없으면** 이렇게 하십시오.
  1. `uv python install 3.12`
  2. `PATH="$(dirname "$(uv python find 3.12)"):$PATH" sam build ...`

**검사와 테스트**

```bash
sam validate --lint -t infra/twin/template.yaml --region ap-northeast-2
python -X utf8 -m unittest discover -s infra/twin/tests
python -X utf8 infra/twin/functions/simulator.py --dry-run   # DynamoDB에 쓰지 않고 건수·계산 시간 출력
```

**배포 후 확인**

```bash
aws logs tail /aws/lambda/$(aws cloudformation describe-stacks --stack-name maestro-twin --query "Stacks[0].Outputs[?OutputKey=='SimulatorFunctionName'].OutputValue" --output text --profile maestro --region ap-northeast-2) --since 5m --profile maestro --region ap-northeast-2
aws dynamodb scan --table-name maestro-State --select COUNT --profile maestro --region ap-northeast-2
```

## 초기 데이터 적재

`boto3`가 필요합니다(`uv run --no-project --with boto3 python ...`로 임시 설치 가능). Windows는 `-X utf8`이 필수입니다. 팀 모듈이 인코딩을 지정하지 않고 JSON을 읽기 때문입니다.

```bash
python -X utf8 infra/twin/seed.py --dry-run          # 건수와 예시만 출력
python -X utf8 infra/twin/seed.py --profile maestro  # 적재
```

- **예상 건수:** Buildings 4, Rooms 533, Equipment 533
- **덮어쓰기:** 같은 키는 덮어써서 여러 번 실행해도 결과가 같습니다. 원본에서 사라진 항목은 지우지 않습니다.
- **고객사 수정 정보:** `BuildingOwnersTable.overrides`에 따로 있어서 다시 적재해도 유지됩니다.

## 삭제

`maestro` 스택이 이 테이블을 읽고 있어서 **스택 삭제는 서비스 중단**입니다. 비용을 줄이려면 삭제 대신 simulator만 끄십시오.

```bash
# simulator만 끄기: 위 배포 명령에서 SimulatorEnabled=false
```
