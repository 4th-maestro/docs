# lambda

에게(에너지게이트) API(Lambda, Python 3.12)와 AWS 리소스(SAM) 폴더입니다. 구조 설명은 [시스템 설계](../docs/human/explanation/architecture.md) 2절과 10절에 있습니다.

| 경로 | 내용 |
|---|---|
| `template.yaml` | API Gateway HTTP API, WebSocket API, Lambda 11개, DynamoDB, S3, CloudFront |
| `src/status.py` | `GET /rooms/status?building=main&floor=1F` 건물 호실별 가상 상태, 건물 정보와 층 목록 |
| `src/portfolio.py` | `GET /buildings` 건물별 현재 상태, 오늘 사용량, 절감 가능량, 점검 순서(전체 현황) |
| `src/query.py` | `POST /query` 자연어 질의(Bedrock Claude Sonnet 5.5, 본문 `buildingId`), 응답에 단계 기록 `steps` 포함 |
| `src/ws.py` | WebSocket `ask` 라우트(`buildingId`), 질의 단계 이벤트 실시간 전송([이벤트 형식](../docs/human/explanation/architecture.md#7-자연어-질의-llm-도구-호출과-서버-검증)) |
| `src/schedules.py` | `GET /schedules?building=` 건물별 조회, `POST /schedules` 저장(`buildingId`의 호실만 허용), `DELETE /schedules/{id}` 취소 |
| `src/recommend.py` | `GET /recommendations?building=&floor=` 낭비 규칙 3종 추천, 예상 절감량, 스케줄 초안 |
| `src/anomalies.py` | `GET /anomalies?building=&floor=` 설정온도 미도달 HVAC 상세, 기대 온도, 원인 후보(규칙 기반 추정) |
| `src/history.py` | `GET /rooms/history?building=&floor=` 층 전력 시간별 평균(kW)과 사용량(kWh), 오늘 0시~현재와 어제 0~23시 |
| `src/energy.py` | `GET /energy/compare·trend·heatmap·breakdown` 건물별 전력 사용량 비교, 기간 추이, 요일×시간 평균 kW, 층·용도 구성([설계](../docs/human/explanation/architecture.md) 11절) |
| `src/tools.py` | LLM 도구 정의와 서버 검증(층·용도는 질의 건물 기준) |
| `src/buildings.py`, `src/buildings.json` | 건물 4곳(본관 공개 IFC, 가상 3곳), 건물별 호실과 운영 프로필 |
| `src/sim.py`, `src/rooms.json` | 가상 HVAC 상태 생성, 본관 호실 137개(공개 IFC 의원 건물) |
| `tools/demo_status.py` | Frontend 데모 상태 생성(`frontend/public/demo/<건물>.json`, `index.json`) |
| `tools/build_floorplans.py` | 건물별 3D 도면 생성(`frontend/public/floorplans/<건물>.json`) |
| `src/chat.py` | `GET·DELETE /chat?building=` 사용자별 대화 기록(90일), 대화 메모리(24시간, 1KB 요약) 저장 |
| `src/auth.py` | WebSocket 연결 인증(쿼리 token, Cognito 액세스 토큰 검증) |

`building` 쿼리와 `buildingId` 본문 값이 없으면 `main`이고, 목록에 없는 건물은 400(`알 수 없는 건물: <id>`)입니다. 판정 기준과 응답 필드는 [시스템 설계](../docs/human/explanation/architecture.md) 2절, 8절, 9절에 있습니다.

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

두 번째 배포부터는 `sam deploy --stack-name maestro --region ap-northeast-2 --profile maestro --capabilities CAPABILITY_IAM --resolve-s3`를 사용하십시오. `ModelId` 기본값을 바꾼 배포는 `--parameter-overrides ModelId=global.anthropic.claude-sonnet-5-5`를 함께 지정하십시오. 스택에 저장된 이전 값이 허용 값 검사에서 거부됩니다.

모델은 bedrock-runtime global 추론 프로필 `global.anthropic.claude-sonnet-5-5`입니다. bedrock-mantle 엔드포인트는 Sonnet 5.5를 제공하지 않습니다(2026-11-20 확인). 출력값 `ApiUrl`을 Frontend의 `VITE_API_BASE_URL`에, `WsUrl`을 `VITE_WS_URL`에 넣고, `WebBucketName`에 Frontend 빌드를 올리십시오.

### 운영자 계정

허용 목록(개별 이메일 또는 @도메인)에 있는 이메일만 웹에서 회원가입할 수 있습니다. 허용 목록은 관리자 그룹 계정이 웹의 "사용자 관리" 화면에서 관리합니다. 첫 관리자는 아래 명령으로 만드십시오. 임시 비밀번호가 메일로 발송되고, 첫 로그인 때 새 비밀번호로 바꿉니다.

```bash
POOL=$(aws cloudformation describe-stacks --stack-name maestro --profile maestro --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username 관리자@회사.com \
  --user-attributes Name=email,Value=관리자@회사.com Name=email_verified,Value=true --profile maestro
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username 관리자@회사.com --group-name admin --profile maestro
```

| 경로 | 내용 |
|---|---|
| `src/signup.py` | 가입 전 검사(PreSignUp): 허용 목록 밖 이메일 거부, CLI 발급은 검사 생략 |
| `src/admin.py` | `GET·POST /admin/allow`, `DELETE /admin/allow/{entry}`, `GET /admin/users`(관리자 그룹 전용) |
| `src/allow.py` | 허용 목록 테이블(키 `entry`) 공용 함수 |

웹 빌드에는 `VITE_COGNITO_CLIENT_ID`(출력값 `UserPoolClientId`)를 함께 지정하십시오. 비어 있으면 로그인 없이 목업으로 실행합니다(로컬 확인용). 메일은 Cognito 기본 메일(하루 50통)입니다.

## 규칙

- `ModelId`는 Sonnet 5.5와 Haiku 5.5만 허용합니다. Opus 계열을 추가하지 마십시오.
- 제어는 스케줄 저장과 시뮬레이션 반영까지입니다. 실제 설비를 제어하는 코드를 추가하지 마십시오.
