# lambda

에게(에너지게이트) API(Lambda, Python 3.12)와 AWS 리소스(SAM) 폴더입니다. 구조 설명은 [시스템 설계](../docs/human/explanation/architecture.md) 2절과 10절에 있습니다.

| 경로 | 내용 |
|---|---|
| `template.yaml` | API Gateway HTTP API, WebSocket API, Lambda 6개(조회·관리 API 통합, AI 질의, WebSocket, 연결 인증, 가입 전 검사, 가입 확인), DynamoDB, Cognito, S3, CloudFront, Bedrock Knowledge Base(S3 Vectors) |
| `src/api.py` | 조회·관리 API 단일 진입점: 경로로 각 모듈 handler 호출(콜드 스타트 1회), 메모리 1769MB |
| `src/status.py` | `GET /rooms/status?building=main&floor=1F` 건물 호실별 가상 상태, 건물 정보와 층 목록 |
| `src/portfolio.py` | `GET /buildings` 건물별 현재 상태, 오늘 사용량, 절감 가능량, 점검 순서(전체 현황) |
| `src/query.py` | `POST /query` 자연어 질의(Bedrock Claude Sonnet 5.5, 본문 `buildingId`), 응답에 단계 기록 `steps` 포함 |
| `src/ws.py` | WebSocket `ask` 라우트(`buildingId`), 질의 단계 이벤트 실시간 전송([이벤트 형식](../docs/human/explanation/architecture.md#7-자연어-질의-llm-도구-호출과-서버-검증)) |
| `src/schedules.py` | `GET /schedules?building=` 건물별 조회, `POST /schedules` 저장(`buildingId`의 호실만 허용), `DELETE /schedules/{id}` 취소 |
| `src/recommend.py` | `GET /recommendations?building=&floor=` 낭비 규칙 3종 추천, 예상 절감량, 스케줄 초안 |
| `src/anomalies.py` | `GET /anomalies?building=&floor=` 설정온도 미도달 HVAC 상세, 기대 온도, 원인 후보(규칙 기반 추정) |
| `src/history.py` | `GET /rooms/history?building=&floor=` 층 전력 시간별 평균(kW)과 사용량(kWh), 오늘 0시~현재와 어제 0~23시 |
| `src/energy.py` | `GET /energy/compare·trend·heatmap·breakdown` 건물별 전력 사용량 비교, 기간 추이, 요일×시간 평균 kW, 층·용도 구성([설계](../docs/human/explanation/architecture.md) 11절) |
| `src/tools.py` | LLM 도구 6종(호실 순위, 묶음 합계, 기간 추이, 스케줄 초안, 기준 문서 검색, 쾌적 지표) 정의와 서버 검증(층·용도는 질의 건물 기준), 결과 그래프 정의(`chart`: 막대·선), 문서 근거(`sources`) 생성 |
| `src/comfort.py` | 불쾌지수(기상청 식)와 단계, PMV·PPD(ISO 7730 반복 계산, 외부 패키지 없음) |
| `kb/` | Knowledge Base 원본 문서(규정·쾌적 지표)와 `.md.metadata.json`(문서명, 원문 주소, 시행일, 원문 확인일). 근거는 [KB 문서 원문 확인](../docs/human/explanation/research/kb-sources.md) |
| `tools/kb_sync.sh` | `kb/`를 KB 원본 버킷에 동기화하고 수집 작업 실행 후 완료 대기 |
| `src/buildings.py`, `src/buildings.json` | 건물·호실 조회. 배포 환경은 `maestro-twin` 스택의 Buildings·Rooms 테이블(60초 캐시), 로컬·테스트는 `buildings.json`·`rooms.json` |
| `src/sim.py`, `src/rooms.json` | 가상 HVAC 상태 생성, 본관 호실 137개(공개 IFC 의원 건물) |
| `tools/demo_status.py` | Frontend 데모 상태 생성(`frontend/public/demo/<건물>.json`, `index.json`) |
| `tools/build_floorplans.py` | 건물별 3D 도면 생성(`frontend/public/floorplans/<건물>.json`) |
| `src/plan.py`, `tools/upload_plans.py` | 도면 API `GET /buildings/{id}/plan`(도면 버킷 `plans/<건물>/current.json`), 초기 적재(`--bucket <PlansBucketName>`) |
| `src/chat.py` | `GET·DELETE /chat?building=` 사용자별 대화 기록(90일), 대화 메모리(24시간, 1KB 요약) 저장 |
| `src/auth.py` | WebSocket 연결 인증(쿼리 token, Cognito 액세스 토큰 검증), context에 sub·groups 전달 |
| `src/tenant.py` | 기업 소속 검사(호출자 역할, 접근 가능 건물, 수정 권한, 중지 기업), 기업 코드 형식, 기업·구성원·건물 소속·변경 이력 테이블 공용 함수, `GET /me` |
| `src/customer.py` | 고객사 설정 API(기업 코드 가입, 기업 정보, 구성원, 변경 이력, 건물 정보 수정) |

`building` 쿼리와 `buildingId` 본문 값이 없으면 `main`이고, 목록에 없는 건물은 400(`알 수 없는 건물: <id>`)입니다. 소속 기업 밖 건물은 403(`이 건물에 접근할 권한이 없습니다.`)이고, WebSocket `ask`는 모델 호출 없이 `error` 이벤트입니다. 중지 기업 구성원은 403(`code: 'COMPANY_SUSPENDED'`)입니다. 소속 규칙은 아래 "기업·회원" 절에 있습니다. 판정 기준과 응답 필드는 [시스템 설계](../docs/human/explanation/architecture.md) 2절, 8절, 9절에 있습니다.

## 테스트

```bash
python3 -m unittest discover tests
sam validate --lint
```

## 배포

AWS 자격 증명은 각자 터미널에서 입력하십시오. 키를 대화나 파일에 붙여 넣지 마십시오.

```bash
aws configure --profile maestro        # 리전 ap-northeast-2
aws sts get-caller-identity --profile maestro
sam build && sam deploy --guided --profile maestro
```

두 번째 배포부터는 아래 명령을 사용하십시오. 배포는 `main` 기준이며, 브랜치가 `main`이 아니거나 커밋하지 않은 변경이 있으면 빌드 전에 중단됩니다. `ModelId`는 스택에 저장된 이전 값이 허용 값 검사에서 거부되므로 매번 지정합니다.

```bash
git switch main && git pull --ff-only \
  && test -z "$(git status --porcelain --untracked-files=no)" \
  && sam build \
  && sam deploy --stack-name maestro --region ap-northeast-2 --profile maestro --capabilities CAPABILITY_IAM --resolve-s3 \
     --no-confirm-changeset --no-fail-on-empty-changeset --parameter-overrides ModelId=global.anthropic.claude-sonnet-5-5
```

주: 2026-11-20 작업 사본의 미커밋 변경 때문에 브랜치 전환이 실패한 상태에서 `sam build`가 이어 실행되어, 머지 전 코드가 약 3분간 배포되었습니다. 명령을 `&&`로 연결하고 브랜치·변경 확인을 앞에 둔 이유입니다.

Knowledge Base 문서는 배포 후와 `kb/` 수정 후마다 `tools/kb_sync.sh`를 실행해 반영하십시오. 수집 결과(신규, 변경, 실패 문서 수)가 출력됩니다.

모델은 bedrock-runtime global 추론 프로필 `global.anthropic.claude-sonnet-5-5`입니다. bedrock-mantle 엔드포인트는 Sonnet 5.5를 제공하지 않습니다(2026-11-20 확인). 출력값 `ApiUrl`을 Frontend의 `VITE_API_BASE_URL`에, `WsUrl`을 `VITE_WS_URL`에 넣고, `WebBucketName`에 Frontend 빌드를 올리십시오.

### 운영자 계정

고객사 사용자는 판매사가 전달한 기업 코드로 웹에서 회원가입합니다. 판매사 총관리자는 Cognito `admin` 그룹 계정이고, 웹 회원가입 대신 아래 명령으로 만드십시오. 임시 비밀번호가 메일로 발송되고, 첫 로그인 때 새 비밀번호로 바꿉니다.

```bash
POOL=$(aws cloudformation describe-stacks --stack-name maestro --profile maestro --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username 관리자@회사.com \
  --user-attributes Name=email,Value=관리자@회사.com Name=email_verified,Value=true --profile maestro
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username 관리자@회사.com --group-name admin --profile maestro
```

| 경로 | 내용 |
|---|---|
| `src/signup.py` | 가입 전 검사(PreSignUp): 기업 코드 확인 후 가입 대기 항목 저장, CLI 발급은 검사 생략, 그 밖의 가입 경로 거부 |
| `src/confirm.py` | 가입 확인(PostConfirmation): 이메일 인증 후 구성원 등록, 기업 첫 구성원은 manager, 이후 operator |
| `src/admin.py` | 판매사 관리 API(기업, 기업 코드, 구성원, 변경 이력, 건물 소속, 사용자 목록), `admin` 그룹 전용 |
| `tools/migrate_tenancy.py` | 2단계 이전: 데모 기업 생성, 기존 건물 4개 소속 지정, 기존 사용자 operator 등록 |

### 기업·회원

| 역할 | 판정 | 접근 가능 건물 | 수정 권한 |
|---|---|---|---|
| `admin`(판매사 총관리자) | 액세스 토큰 `cognito:groups`에 `admin` 포함 | 전체(소속 없는 건물 포함) | 모든 기업·구성원·건물 정보, 기업 상태·코드 |
| `manager`(고객사 관리자) | MembersTable 역할, 기업 코드로 처음 가입한 구성원 | 소속 기업 건물 | 기업 정보(상태 제외), 구성원 역할·해제, 소속 건물 정보 |
| `operator`(운영자) | MembersTable 역할, 두 번째 가입자부터 | 소속 기업 건물 | 없음(기업 정보·변경 이력 조회) |
| 없음 | 구성원 항목 없음 | 없음(`GET /buildings`는 빈 목록, 그 밖의 건물 API는 403) | 기업 코드 가입(`POST /me/join`)만 |

| 항목 | 규칙 |
|---|---|
| 중지 기업 | 기업 `status`가 `suspended`면 구성원의 모든 건물 API(`GET /buildings` 포함)와 `/company*`는 403 `{error: '서비스가 중지된 기업입니다. 판매사에 문의하십시오.', code: 'COMPANY_SUSPENDED'}`. WebSocket `ask`는 같은 문구의 `error` 이벤트. `GET /me`는 허용, `admin`은 검사 안 함 |
| 관리자 최소 1명 | 마지막 `manager`의 역할 변경·소속 해제는 409 `관리자는 최소 1명이어야 합니다.` |
| 소속 해제 | 구성원 항목만 삭제. Cognito 계정은 유지되고 기업 코드로 다시 가입 가능 |
| 건물 정보 수정 | `name`(1~40자), `use`(1~20자), `hours`([시작, 종료] 0~24 정수, 시작 < 종료), `weekend`(true·false)만 대상. 도면·층·호실은 대상 아님 |
| 수정 정보 저장 | BuildingOwnersTable 항목의 `overrides`. 트윈 Buildings 테이블은 적재 스크립트가 덮어써서 별도 저장. 소속 없는 건물은 `overrides`만 있는 항목 |
| 수정 반영 | 같은 실행 환경은 즉시, 다른 실행 환경은 건물 캐시(60초) 만료 후. 호실 운영 프로필(가상 상태 계산)에도 반영 |

주: 구성원, 건물 소속, 기업 상태는 실행 환경별 60초 캐시라, 역할·소속·중지 변경은 최대 60초 뒤 다른 실행 환경에 반영됩니다. 변경한 실행 환경에는 즉시 반영됩니다. 환경 변수 `MEMBERS_TABLE`이 없으면(로컬·테스트) 소속 검사를 하지 않습니다.

| 항목 | 규칙 |
|---|---|
| 기업 코드 | `EGE-XXXX-XXXX`, 문자 `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` 8자리. 입력은 대문자 변환, 공백·하이픈 제거 후 확인 |
| 코드 만료 | 기본 30일(`codeDays`·`days` 1~365). 재발급하면 이전 코드는 무효, 가입한 구성원은 유지 |
| 가입 | 웹 SignUp의 `ClientMetadata.companyCode` 확인(존재, 기업 `active`, 만료 전). 실패 문구 `기업 코드가 올바르지 않거나 만료되었습니다.` |
| 가입 대기 | MembersTable 키 `pending#<소문자 이메일>`, 2일 뒤 자동 삭제. 이메일 인증 전 만료되면 소속 없는 계정 |
| 변경 이력 | AuditTable(기업별, 정렬 키 `<ISO 시각(밀리초)>#<uuid>`). `company.create`, `company.update`, `company.delete`, `company.code`, `building.assign`, `building.update`, `member.join`, `member.role`, `member.remove`. 소속 없는 건물의 정보 수정은 기록 안 함 |

| API(로그인 필수) | 권한 | 응답 |
|---|---|---|
| `GET /me` | 전체 | `{email, role: 'admin'·'manager'·'operator'·null, company: {id, name, status}·null}` |
| `POST /me/join` | 소속 없는 사용자(`admin` 제외) | 본문 `{code}` → `{company: {id, name, status}, role}`. 첫 구성원은 `manager`. 코드 오류·만료·중지 기업 400, 이미 소속 409, `admin` 403 |
| `GET /company` | 구성원 | `{company, buildings: [{id, name, use, floors, roomCount, hours, weekend}], members?}`. `company.code`, `codeExpiresAt`, `members`는 `manager`만 |
| `PATCH /company` | `manager` | 본문 `{name, contactName, contactEmail, phone, address}` 일부(판매사 수정과 같은 검사, `status`는 400) → `{company}` |
| `PATCH /company/members/{sub}` | `manager` | 본문 `{role: 'manager'·'operator'}` → `{member: {sub, email, role, joinedAt}}`. 다른 기업 구성원 404 |
| `DELETE /company/members/{sub}` | `manager` | 소속 해제 → `{deleted: true}` |
| `GET /company/audit?limit=` | 구성원 | `{items: [{at, actor: {email, role}, action, target, detail}]}` 최신순. `limit` 기본 50, 최대 200, 1 미만·정수 아님은 400 |
| `PATCH /buildings/{id}` | `admin`, 소속 기업 `manager` | 본문 `{name, use, hours, weekend}` 일부 → `{building}`(건물 요약, `hours`, `weekend` 포함). 변경 이력 `detail`은 `{before, after}` |
| `GET /admin/companies` | `admin` | `{companies: [Company + buildingCount, memberCount]}` |
| `POST /admin/companies` | `admin` | 본문 `{name(1~60자), contactName?, contactEmail?, phone?, address?, codeDays?}` → 201 `{company}` |
| `GET /admin/companies/{id}` | `admin` | `{company, buildings: [{id, name, use, floors, roomCount}], members: [{sub, email, role, joinedAt}]}` |
| `PATCH /admin/companies/{id}` | `admin` | 본문 `{name, contactName, contactEmail, phone, address, status('active'·'suspended')}` 일부 → `{company}` |
| `DELETE /admin/companies/{id}` | `admin` | 건물이 남아 있으면 409, 아니면 구성원 항목과 함께 삭제 → `{deleted: true}` |
| `POST /admin/companies/{id}/code` | `admin` | 본문 `{days?}` → 새 코드 `{company}` |
| `GET /admin/buildings` | `admin` | `{buildings: [{id, name, companyId, companyName}]}`(소속 없는 건물은 null) |
| `PUT /admin/buildings/{id}/company` | `admin` | 본문 `{companyId}`(null이면 소속 해제) → `{buildingId, companyId}` |
| `GET /admin/users` | `admin` | 가입한 사용자 이메일, 상태, 관리자 여부, 가입일 |
| `PATCH /admin/companies/{id}/members/{sub}` | `admin` | 본문 `{role}` → `{member}`(고객사 구성원 API와 같은 규칙) |
| `DELETE /admin/companies/{id}/members/{sub}` | `admin` | 소속 해제 → `{deleted: true}` |
| `GET /admin/companies/{id}/audit?limit=` | `admin` | 고객사 변경 이력 API와 같은 응답 |

주: Company 객체는 `{id, name, contactName, contactEmail, phone, address, status, code, codeExpiresAt, createdAt}`입니다. `admin`이 아닌 사용자의 `/admin/*` 요청은 403입니다. 허용 목록 API(`/admin/allow*`)는 삭제했고, `AllowTable`은 기존 항목 보존용으로 남아 있습니다(삭제 예정).

2단계 첫 배포 후 아래 명령으로 기존 건물과 사용자를 데모 기업(`co-demo0000`)으로 옮기십시오. 먼저 `--dry-run`으로 대상을 확인하십시오. 여러 번 실행해도 결과는 같습니다.

```bash
POOL=$(aws cloudformation describe-stacks --stack-name maestro --profile maestro --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
python3 tools/migrate_tenancy.py --user-pool-id "$POOL" --profile maestro --dry-run
python3 tools/migrate_tenancy.py --user-pool-id "$POOL" --profile maestro
```

웹 빌드에는 `VITE_COGNITO_CLIENT_ID`(출력값 `UserPoolClientId`)를 함께 지정하십시오. 비어 있으면 로그인 없이 목업으로 실행합니다(로컬 확인용). 메일은 Cognito 기본 메일(하루 50통)입니다.

## 규칙

- `ModelId`는 Sonnet 5.5와 Haiku 5.5만 허용합니다. Opus 계열을 추가하지 마십시오.
- 제어는 스케줄 저장과 시뮬레이션 반영까지입니다. 실제 설비를 제어하는 코드를 추가하지 마십시오.

## 응답 속도

| 항목 | 방식 |
|---|---|
| 함수 구성 | 조회·관리 API 35개 경로를 `api.py` 함수 1개로 처리. 이전 9개 함수는 화면마다 콜드 스타트가 9번 발생(첫 호출 2.6~2.9초, 2026-11-20 실측) |
| 메모리 | 전체 기본 1024MB, API 함수 1769MB(vCPU 1개). 512MB에서 `/buildings` p50 4.0초 |
| 캐시 | 지난 시간·지난 날짜 계산은 대상 스케줄을 키로 실행 환경 메모리에 보관(스케줄 변경 시 자동 재계산), `/buildings` 응답은 30초 |

주: 로컬 측정(Apple Silicon) `/buildings` 계산 456ms → 재계산 52ms, 응답 캐시 적중 0.02ms. `/rooms/history` 68ms → 1ms.
