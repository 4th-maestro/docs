# infra/twin — ② 디지털 트윈 데이터 기반

건물·호실·설비 정보와 호실 상태·이력, 기상·재실 데이터를 담는 DynamoDB 테이블입니다. 기존 `maestro` 스택(`template.yaml`)과 분리된 **`maestro-twin` 스택**으로 배포해서 팀원 배포와 서로 덮어쓰지 않습니다.

현재 단계는 테이블과 초기 데이터 적재까지입니다. 주기 계산(simulator, EventBridge 1분)과 기상 수집(weather, 30분)은 다음 단계에서 이 스택에 추가합니다. 기존 조회 API(`src/`)는 아직 이 테이블을 읽지 않습니다.

| 파일 | 내용 |
|---|---|
| `template.yaml` | SAM 템플릿: DynamoDB 테이블 7개, 테이블 이름과 State Stream ARN 출력(Export) |
| `seed.py` | `src/buildings.json`·`rooms.json` → Buildings·Rooms·Equipment 적재 |

## 테이블

모두 온디맨드(PAY_PER_REQUEST)입니다. 이름은 `<Prefix>-<테이블>`이고, `Prefix` 기본값은 `maestro`입니다.

| 테이블 | 키 (PK / SK) | 내용 | 채우는 곳 |
|---|---|---|---|
| Buildings | `buildingId` | `buildings.json` 필드 그대로(floors, hours, weekend, waste, remap 등) | `seed.py` |
| Rooms | `buildingId` / `roomId` | name, floor, use, areaM2, idu. 가상 건물 호실은 `buildings.rooms()` 결과(id `건물.층.GUID`) | `seed.py` |
| Equipment | `buildingId` / `equipmentId` | 실내기(호실당 1대): roomId, floor, type=`IDU`, ratedKw(`sim.rated()` 식). LG 모델 매핑은 이후 추가 | `seed.py` |
| State | `buildingId` / `roomId` | 호실 현재 상태(`sim.state()` 필드 + updatedAt). **Streams NEW_AND_OLD_IMAGES** | simulator(다음 단계) |
| Timeseries | `pk`=`건물#호실` / `ts` | 상태 이력, `ttl`(epoch 초) 자동 삭제 | simulator(다음 단계) |
| Weather | `location` / `ts` | 기상 관측, `ttl` | weather(다음 단계) |
| Occupancy | `pk`=`건물#호실` / `ts` | 재실 인원 이력, `ttl` | simulator(다음 단계) |

`ts`는 KST ISO 시각 문자열(예 `2026-11-20T15:41:00+09:00`)입니다.

## 배포

SAM 템플릿입니다(루트 `template.yaml`과 같은 방식). Lambda 폴더에서 실행합니다. SAM CLI가 없으면 `uv tool install aws-sam-cli`로 설치하십시오.

```bash
# 검사
sam validate --lint -t infra/twin/template.yaml --profile maestro --region ap-northeast-2

# 배포(스택 maestro-twin). 지금은 Lambda 코드가 없어 sam build 불필요, 다음 단계부터 build 후 deploy
sam deploy -t infra/twin/template.yaml --stack-name maestro-twin \
  --region ap-northeast-2 --profile maestro --capabilities CAPABILITY_IAM --resolve-s3
```

`samconfig.toml`은 `.gitignore` 대상이라 위 옵션을 매번 지정합니다. 루트 `maestro` 스택 명령(`sam deploy --stack-name maestro ...`)과 스택 이름이 다르니 섞지 마십시오.

## 초기 데이터 적재

`boto3`가 필요합니다. Windows는 `-X utf8`이 필수입니다. 팀 모듈이 인코딩을 지정하지 않고 JSON을 읽기 때문입니다.

```bash
python -X utf8 infra/twin/seed.py --dry-run          # 건수와 예시만 출력
python -X utf8 infra/twin/seed.py --profile maestro  # 적재
```

예상 건수: Buildings 4, Rooms 533, Equipment 533. 같은 키는 덮어써서 여러 번 실행해도 결과가 같습니다. 원본에서 사라진 항목은 지우지 않습니다.

## 삭제

```bash
sam delete --stack-name maestro-twin --profile maestro --region ap-northeast-2
```

테이블과 데이터가 모두 삭제됩니다.
