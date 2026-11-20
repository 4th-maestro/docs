# lambda

Maestro API(Lambda, Python 3.12)와 AWS 리소스(SAM) 폴더입니다. 구조 설명은 [시스템 설계](../docs/human/explanation/architecture.md) 2절과 10절에 있습니다.

| 경로 | 내용 |
|---|---|
| `template.yaml` | API Gateway HTTP API, WebSocket API, Lambda 7개, DynamoDB, S3, CloudFront |
| `src/status.py` | `GET /rooms/status?floor=1F` 호실별 가상 상태 |
| `src/query.py` | `POST /query` 자연어 질의(Bedrock Claude Sonnet 5.5), 응답에 단계 기록 `steps` 포함 |
| `src/ws.py` | WebSocket `ask` 라우트, 질의 단계 이벤트 실시간 전송([이벤트 형식](../docs/human/explanation/architecture.md#7-자연어-질의-llm-도구-호출과-서버-검증)) |
| `src/schedules.py` | `GET·POST /schedules` 스케줄 조회·저장, `DELETE /schedules/{id}` 취소(UUID 형식 아니면 400, 없으면 404) |
| `src/recommend.py` | `GET /recommendations?floor=1F` 낭비 규칙 3종 추천, 예상 절감량, 스케줄 초안 |
| `src/anomalies.py` | `GET /anomalies?floor=1F` 설정온도 미도달 HVAC 상세, 기대 온도, 원인 후보(규칙 기반 추정) |
| `src/history.py` | `GET /rooms/history?floor=1F` 층 전력 시간별 평균(kW)과 사용량(kWh), 오늘 0시~현재와 어제 0~23시 |
| `src/tools.py` | LLM 도구 정의와 서버 검증 |
| `src/sim.py`, `src/rooms.json` | 가상 HVAC 상태 생성, 시연 호실 137개(공개 IFC 의원 건물) |
| `tools/demo_status.py` | Frontend 데모용 상태 JSON 출력 |

판정 기준과 응답 필드는 [시스템 설계](../docs/human/explanation/architecture.md) 8절과 9절에 있습니다.

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

## 규칙

- `ModelId`는 Sonnet 5.5와 Haiku 5.5만 허용합니다. Opus 계열을 추가하지 마십시오.
- 제어는 스케줄 저장과 시뮬레이션 반영까지입니다. 실제 설비를 제어하는 코드를 추가하지 마십시오.
