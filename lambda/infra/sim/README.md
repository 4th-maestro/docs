# infra/sim — 운전 시뮬레이션 계산 서버 (EnergyPlus)

웹 **시뮬레이션** 탭의 **EnergyPlus로 계산** 버튼과 AI 도우미 what-if("3층 강의실 18도로 낮추면?")가 부르는 `/api/sim/*`를 AWS에서 처리합니다. 트윈의 로컬 서버(`Frontend/twin/tools/sim-server.mjs`)와 같은 응답을 돌려줍니다. 계산 코드는 트윈 것(`twin/tools/sim-runner.mjs`, `twin/pipeline/`)을 수정 없이 씁니다.

```
웹(CloudFront) /api/sim/*  ──(x-maestro-sim 비밀 헤더)──▶  Function URL → maestro-sim (컨테이너 Lambda)
                                                              Lambda Web Adapter → server.mjs → handler.mjs → sim-runner.compare()
                                                              → EnergyPlus 24.2 두 번(기존 운전·선택 운전) → twin.scenario-compare/v1
```

| 파일 | 내용 |
|---|---|
| `handler.mjs` | 요청 검사(비밀 헤더, 건물 지정), 등록 건물 운영 시간을 대시보드 설정으로 덮어쓰기, 트윈 코드를 `/tmp/twin`으로 복사해 `compare()` 호출 |
| `server.mjs` | 컨테이너 HTTP 서버(8080). Lambda Web Adapter가 요청을 넘김 |
| `Dockerfile` | Node 22(Debian 12) + EnergyPlus 24.2(e7ecb2d53b, 5R1C 보정과 같은 빌드) + libgomp·libX11 + Lambda Web Adapter |
| `default-tariff.json` | 등록 건물 기본 요금표(일반용 갑 134.2원/kWh, `src/energy.py`와 같음) |
| `prepare.sh` | Frontend `twin/`의 계산 코드·데모 데이터를 `infra/sim/twin/`으로 복사(커밋 안 함) |
| `template.yaml` | 스택 `maestro-sim`: 이미지 Lambda, Function URL, 로그 |
| `package.json`, `package-lock.json` | DynamoDB 클라이언트(@aws-sdk/client-dynamodb 3.1161.0) |
| `test/handler.test.mjs` | 입력 검사·운영 시간 테스트 + (EnergyPlus가 있으면) 실제 계산(토요일 주말 운영 포함) |

## 건물 지정

| 요청 | 대상 | 처리 |
|---|---|---|
| `{data: 'data/busan-station/'}` | 데모 건물(트윈 `data/buildings.json` 목록) | 이미지 안의 데모 폴더로 계산. 목록 밖 경로는 400 |
| `{building: <twin.building/v1>}` | 판매사가 등록한 건물, 도면 교체 편집본 | 트윈이 대시보드에서 받은 도면을 그대로 보냄 → `/tmp/twin/data/host/<내용 해시>/`에 쓰고 기본 요금표로 계산 |

- 등록 건물 도면 검사: 스키마 `twin.building/v1`, `building.id`는 영문·숫자·`._-` 80자 이하(결과 저장 경로에 쓰임), 크기(w, d) 양수, 층 60·실 1,500·실내기 3,000 이하, 요청 3MB 이하
- **운영 시간:** 등록 건물은 도면의 `operation` 대신 대시보드 건물 설정을 씁니다. 원본(`maestro-Buildings`의 `hours`·`weekend`) 위에 판매사가 화면에서 수정한 값(`BuildingOwnersTable` 항목의 `overrides`)을 덮어쓴 값으로, 대시보드(`src/buildings.py`)와 같습니다. 배포 때 `OwnersTableName`을 빼면 화면 수정값이 반영되지 않습니다. `weekend`가 true면 주말도 같은 시간, false면 주말 운영 없음입니다. 테이블에 없거나 조회에 실패하면 도면 값을 그대로 씁니다.
  - 이유: 도면 변환 기본값(평일 08~21시, 주말 없음)이 남아 있어 '주말 운영' 건물도 토요일에 난방이 켜지지 않고 절감 0이 나왔습니다(2026-11-21). ifc 변환 건물은 `operation`이 아예 없어 평일에도 0이었습니다.
  - 계산은 오늘 실측 기준이면 "운영 시간 안 + 재실 예상 1명 이상"인 시간에만 방을 켭니다(트윈 `pipeline/live-day.js`). 운영하지 않는 날은 기존·선택 운전이 같아 절감이 0입니다.
- 같은 도면·같은 시나리오는 실행 환경의 `/tmp` 결과를 다시 씁니다(0.1초대). 실행 환경이 바뀌면 다시 계산합니다.

## 왜 이렇게 했나

- **Function URL(API Gateway 아님):** HTTP API는 통합 응답을 30초에서 끊습니다. 계산은 13~19초(2026-11-21 컨테이너 실측, 데모·등록 건물 각 1회)에 첫 호출 이미지 적재가 더해집니다. CloudFront 원본 대기는 60초입니다.
- **Debian 베이스 + Lambda Web Adapter:** EnergyPlus Linux판(Ubuntu 22.04 빌드)은 glibc 2.35 이상이 필요한데 Lambda 기본 이미지(Amazon Linux 2023)는 2.34라 실행되지 않습니다(빌드 단계에서 확인).
- **비밀 헤더:** Function URL은 인증 없이 열려 있고, 함수가 CloudFront가 붙인 `x-maestro-sim` 값을 확인합니다. 값은 Secrets Manager `maestro/sim-origin-secret`에 있고 두 스택이 동적 참조로 읽어서 템플릿·파라미터·채팅에 나오지 않습니다.
- **비용 보호:** 예약 동시성 2, 메모리 3GB, 제한 시간 90초. 계산 1회(EnergyPlus 2회)는 약 20초 × 3GB입니다.

## 배포

Lambda 레포 루트에서 실행합니다. Docker가 실행 중이어야 합니다. 배포는 `main` 기준입니다.

1. 비밀 값 만들기(처음 한 번). 값은 화면에 출력하지 않습니다.
   ```bash
   aws secretsmanager create-secret --name maestro/sim-origin-secret --secret-string "$(openssl rand -hex 24)" \
     --profile maestro --region ap-northeast-2 --query ARN --output text
   ```
2. 계산 서버 스택
   ```bash
   bash infra/sim/prepare.sh            # Frontend 레포가 ../Frontend 에 있다고 가정(다르면 경로 인자)
   sam build -t infra/sim/template.yaml --build-dir .aws-sam/sim-build
   OWNERS=$(aws cloudformation describe-stack-resource --stack-name maestro --logical-resource-id BuildingOwnersTable \
     --query StackResourceDetail.PhysicalResourceId --output text --profile maestro --region ap-northeast-2)
   sam deploy -t .aws-sam/sim-build/template.yaml --stack-name maestro-sim --region ap-northeast-2 --profile maestro \
     --capabilities CAPABILITY_IAM --resolve-s3 --resolve-image-repos --no-confirm-changeset --no-fail-on-empty-changeset \
     --parameter-overrides OwnersTableName=$OWNERS
   ```
   - `prepare.sh`는 백그라운드 명령 안에서 git 오류(128)로 멈출 수 있으니 직접 실행하십시오.
3. 웹 경로 연결: `maestro` 스택을 `SimOriginDomain`과 함께 배포(루트 README 배포 명령에 포함)
4. 트윈 화면: Frontend `twin/digital-twin.html`을 웹 버킷에 올리고 CloudFront 무효화(`/twin/*`)

- 트윈 계산 코드(`twin/pipeline/energyplus.js` 등)가 바뀌면 2번을 다시 실행합니다. `infra/sim/twin/SOURCE`에 복사한 Frontend 커밋이 남습니다.
- 첫 호출은 이미지(약 850MB) 적재로 느립니다. 데모 직전에 한 번 계산해 두십시오.

## 검사와 테스트

```bash
bash infra/sim/prepare.sh
node --test infra/sim/test/handler.test.mjs                       # 입력 검사
ENERGYPLUS_DIR=<EnergyPlus 24.2 폴더> node --test infra/sim/test/handler.test.mjs   # + 실제 계산(약 50초)
docker build --platform linux/amd64 -t maestro-sim:local infra/sim
docker run --rm -p 18080:8080 -e SIM_SECRET=x maestro-sim:local    # curl -H 'x-maestro-sim: x' localhost:18080/api/sim/status
```

주: Windows의 Node 22에서 한글이 들어간 경로로 `fs.cpSync`를 부르면 프로세스가 종료되어(세그폴트), 핸들러는 직접 만든 재귀 복사를 씁니다.
