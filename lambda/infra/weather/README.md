# infra/weather — 기상청 초단기실황 수집

별도 스택 `maestro-weather`의 Python 3.12 / arm64 Lambda가 30분마다 기상청을
조회하고, 기존 `maestro-Weather` 테이블에 관측값을 저장합니다.
`maestro`, `maestro-twin`, `src/`, 루트 `tests/`는 변경하지 않습니다.

## 동작과 데이터 계약

```text
EventBridge (30분) → weather Lambda → 기상청 getUltraSrtNcst
                         ↓ API 키: Secrets Manager
                         ↓ 저장: maestro-twin-WeatherTable Export → maestro-Weather
```

- `Location`은 실제 건물의 기상청 격자 `nx,ny`입니다. 위도·경도가 아닙니다.
  인수인계 문서의 `98,76`은 예시이므로 기본값으로 넣지 않았습니다.
  공식 격자표에서 건물 주소에 해당하는 값을 확인하고 simulator 담당자와 맞춥니다.
- **기준 시각:** 2026-10-19 공식 활용가이드의 초단기실황 설명은 매시 10분 이후
  호출을 안내합니다. KST 현재 시각에서 10분을 빼고 정시로 내립니다.
  `15:09 → 14:00`, `15:10 → 15:00`, `00:05 → 전날 23:00`입니다.
- **API 호출:** 실행당 1회, HTTP 타임아웃 10초, 이전 시각으로 추가 조회하지 않습니다.
  30분 주기이면 격자 하나당 하루 약 48회입니다. 공공데이터포털이 안내하는
  개발계정 신청 가능 트래픽은 10,000이며, 실제 승인된 일일 한도는 키 소유자가
  활용신청 상세에서 확인해야 합니다.
- **중복:** PK=`location`, SK=`ts`로 `PutItem`하여 같은 관측 시각은 덮어씁니다.
  기상청이 관측값을 보정하면 해당 시각의 값도 갱신됩니다.
- **숫자:** boto3용 `Decimal`을 사용합니다. 필수 항목 누락, 결측값, 다른 시간·격자의
  응답은 저장하지 않습니다. 정상적인 기온·습도·풍속·강수량 4개가 모두 필요합니다.
- **TTL:** 관측 기준 시각으로부터 30일 뒤 epoch 초입니다. 실제 삭제는 DynamoDB가
  비동기로 처리합니다. 기존 twin 테이블의 `ttl` 기능이 활성화되어 있어야 합니다.
- **실패:** `{"status":"failed","reason":"..."}`를 반환하고 ERROR 로그를 남깁니다.
  Lambda 호출 자체는 정상 종료되므로 `FunctionError`나 Lambda `Errors` 지표만으로는
  수집 실패를 판단할 수 없습니다. 응답의 `status`와 로그를 확인하세요.
  애플리케이션 재시도는 없고, EventBridge 전달 및 Lambda 비동기 함수 오류 재시도는
  0회로 제한합니다. AWS SDK는 일시적 AWS 오류에 한해 최대 2회 시도합니다.
- **권한:** 기존 Weather 테이블 `PutItem`, 해당 시크릿 `GetSecretValue`, 자기 로그
  그룹의 로그 기록만 허용합니다. Lambda는 VPC에 연결하지 않습니다.
- **비밀:** API 키, URL, 원본 응답, 예외 메시지·traceback을 로그에 출력하지 않습니다.
  Secrets Manager 기본 AWS 관리 키로 암호화하고 평문을 템플릿에 넣지 않습니다.

저장 예시(아래 좌표·값은 테스트 예시입니다):

```json
{
  "location": "60,127",
  "ts": "2026-11-20T15:00:00+09:00",
  "tempC": 14.2,
  "humidity": 55,
  "windMs": 3.1,
  "precipMm": 0,
  "source": "kma-ultra-srt-ncst",
  "ttl": 1797746400
}
```

최신 1건은 `location`으로 Query하고 `ScanIndexForward=false`, `Limit=1`로 읽습니다.
조회 결과가 오래된 자료인지 판단하는 것은 simulator 담당자와 협의합니다.

## 로컬 검증

아래 명령은 모두 `Lambda/`에서 실행합니다.

```bash
sam validate --lint --template-file infra/weather/template.yaml --region ap-northeast-2
sam build --template-file infra/weather/template.yaml --build-dir .aws-sam/weather-build
```

추가 런타임 패키지는 없습니다. boto3는 Lambda Python 런타임 제공본을 사용합니다.
오프라인 테스트에는 boto3가 설치된 Python 환경이 필요합니다. 별도 임시 환경 예시:

```bash
python3.12 -m venv /private/tmp/maestro-weather-venv
/private/tmp/maestro-weather-venv/bin/python -m pip install boto3
/private/tmp/maestro-weather-venv/bin/python -m unittest discover -s infra/weather/tests -v
```

테스트는 AWS·기상청 호출을 하지 않으며, 제공 시각 경계·날짜 전환·데이터 계약·
중복 키·결측값·실패 시 저장 방지·API 키 로그 노출 방지를 확인합니다.

## 시험 배포

### 부산대학교 부산캠퍼스 수집 위치

수집 대상은 부산대학교 부산캠퍼스(부산광역시 금정구 부산대학로63번길 2,
장전동)이며 `Location=98,77`을 사용합니다. 기상청 2026-10-19 공식 활용가이드에
첨부된 격자표에서 장전제1동·장전제2동 모두 X=98, Y=77임을 확인했습니다.
이는 캠퍼스의 지역 대표 관측값이며 건물 내부 센서값이 아닙니다.

- 주소: https://pusan.ac.kr/kor/CMS/Contents/Contents.do?mCode=MN176
- 격자표: https://www.data.go.kr/data/15084084/openapi.do 의 참고문서 ZIP

실제 건물의 격자를 먼저 확정합니다. `maestro-twin` 스택이 같은 계정의 서울 리전에
배포되어 `maestro-twin-WeatherTable`을 Export해야 합니다.

```bash
aws cloudformation list-exports --profile maestro --region ap-northeast-2 \
  --query "Exports[?Name=='maestro-twin-WeatherTable'].[Name,Value]" --output table

# 실제 확인한 격자 입력. 비밀값이 아닙니다.
read 'weather_location?확정한 격자 nx,ny: '

sam deploy --template-file .aws-sam/weather-build/template.yaml \
  --stack-name maestro-weather-dev --region ap-northeast-2 --profile maestro \
  --capabilities CAPABILITY_IAM --resolve-s3 \
  --parameter-overrides "Location=$weather_location" \
    SecretName=maestro/dev/kma-api-key ScheduleEnabled=false
```

위 `read`는 macOS 기본 zsh 문법입니다. 초기 배포는 스케줄이 꺼진 상태입니다.
시크릿은 **값 없이** 생성됩니다. 이미 같은 이름의 시크릿이 있으면 배포가 실패하므로
타 스택의 시크릿을 덮어쓰지 말고 소유자를 확인하세요.

## 시크릿 값 입력 — 키 소유자가 직접 실행

다음은 macOS zsh용입니다. 터미널에 입력한 키는 화면에 표시하지 않고,
셸 기록·프로세스 인수·임시 파일에 키 문자열을 직접 남기지 않습니다.
키를 채팅이나 커밋에 붙여넣지 마세요.

```bash
read -rs 'kma_service_key?공공데이터포털 API 키: '
printf '\n'
printf '%s' "$kma_service_key" | aws secretsmanager put-secret-value \
  --secret-id maestro/dev/kma-api-key --secret-string file:///dev/stdin \
  --profile maestro --region ap-northeast-2 --query ARN --output text
unset kma_service_key
```

일반 인증키(Decoding)를 권장합니다. URL 인코딩된 키도 한 번 디코딩하여 사용합니다.
콘솔에서 입력한다면 일반 문자열 또는 `{"serviceKey":"키"}` 형태를 지원합니다.

## 실행·저장·스케줄 확인

```bash
aws lambda invoke --function-name maestro-weather-dev-collector \
  --profile maestro --region ap-northeast-2 /private/tmp/maestro-weather-result.json
cat /private/tmp/maestro-weather-result.json

# 위에서 입력한 weather_location 변수를 사용합니다.
aws dynamodb query --table-name maestro-Weather \
  --key-condition-expression '#loc = :loc' \
  --expression-attribute-names '{"#loc":"location"}' \
  --expression-attribute-values "{\":loc\":{\"S\":\"$weather_location\"}}" \
  --no-scan-index-forward --limit 1 --profile maestro --region ap-northeast-2
```

응답의 `status`가 `stored`이고, 최신 항목의 시각·수치가 맞는지 확인합니다.
같은 관측 기준 시각에 두 번 호출하여 키가 같고 항목이 덮어써지는지도 확인합니다.
확인 후 같은 배포 명령에서 `ScheduleEnabled=true`로 바꿔 재배포합니다.
30분 안에 Lambda가 실행되고 자료가 저장되는지 로그와 테이블을 확인합니다.

```bash
aws logs tail /aws/lambda/maestro-weather-dev-collector --since 1h \
  --profile maestro --region ap-northeast-2
```

시험 스택도 공유 Weather 테이블에 기록합니다. 시험 배포 삭제로 이 관측값은
지워지지 않고, TTL에 따라 만료됩니다. 정식 스케줄과 동시에 켜둘 필요는 없습니다.

## 정식 배포·삭제

정식 배포는 PR을 `dev`에 머지하고 팀의 `main` 반영·배포 절차를 따른 후 합니다.
`main`의 코드로 다시 build하고, `maestro-weather` 스택과
`SecretName=maestro/kma-api-key`를 사용합니다. 초기에는 스케줄을 끄고 같은 검증을 합니다.
루트 `maestro`나 `maestro-twin`을 배포하지 않습니다.

시험 스택 정리:

```bash
sam delete --stack-name maestro-weather-dev --profile maestro --region ap-northeast-2
```

기존 Weather 테이블과 그 데이터는 이 스택의 삭제 대상이 아닙니다.
시크릿은 `Retain`이므로 남습니다. 시험용 시크릿이 더 이상 필요 없고 다른 곳에서
사용하지 않는 것을 확인한 뒤, 소유자가 7일 복구 기간을 두고 별도로 삭제합니다.

```bash
aws secretsmanager delete-secret --secret-id maestro/dev/kma-api-key \
  --recovery-window-in-days 7 --profile maestro --region ap-northeast-2
```

## 공식 자료

- [기상청 단기예보 조회서비스](https://www.data.go.kr/data/15084084/openapi.do):
  초단기실황 요청·응답, 개발계정 트래픽, 2026-10-19 활용가이드와 격자표 ZIP.
- [SAM Schedule](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-property-function-schedule.html):
  팀 인수인계에서 지정한 30분 Schedule 이벤트를 사용합니다.
- [Secrets Manager CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-secretsmanager-secret.html):
  SecretString과 GenerateSecretString을 생략하여 빈 시크릿만 생성합니다.

## 구현 시 확인 결과 (2026-11-20)

- AWS에서 `maestro-twin-WeatherTable → maestro-Weather` Export, 테이블 `ACTIVE`,
  키 `location`/`ts`, TTL 속성 `ttl` 활성화를 확인했습니다.
- `maestro/kma-api-key` 시크릿은 당시 존재하지 않았습니다. 비밀값은 조회하지 않았습니다.
- Python 3.12에서 오프라인 테스트 21개, `sam validate --lint`, `sam build`,
  AWS `cloudformation validate-template`이 통과했습니다.
  로컬 테스트에는 기존 SAM CLI에 포함된 boto3를 사용했습니다.
- cfn-guard 전용 보안·준수 검사는 도구 미설치로 실행하지 않았습니다.
  위 템플릿 검사 통과는 해당 검사를 대체하지 않습니다.
- 부산대학교 부산캠퍼스의 수집 격자는 공식 격자표 기준 `98,77`로 확인했습니다.
- `maestro-weather-dev` 시험 스택 배포 및 수정 배포가 완료됐습니다.
  Lambda는 `Active`, Python 3.12 / arm64, `LOCATION=98,77`입니다.
- `Enabled: !If`를 사용한 최초 배포에서 규칙이 활성화되어 즉시 비활성화했습니다.
  `State: !If [RunSchedule, ENABLED, DISABLED]`로 수정해 다시 배포했습니다.
- 키 담당자가 시험용 `maestro/dev/kma-api-key`와 정식 `maestro/kma-api-key`에
  값을 입력했습니다. 확인 과정에서 키 값은 출력하지 않았습니다.
- 시험·정식 Lambda 모두 실제 기상청 호출 후 `status=stored`를 반환하고
  `maestro-Weather`에 저장했습니다. 같은 `location`/`ts`로 재호출한 뒤에도
  항목 수는 1개였습니다.
- 시험 스케줄은 19:55(KST) EventBridge `Invocations` 합계 1과 Lambda 저장 성공
  로그로 자동 실행을 확인했습니다. 이후 시험 스케줄을 비활성화했습니다.
- 정식 스택 `maestro-weather`는 PR #32가 머지된 `main` 커밋 `268cb4e`에서
  배포했습니다. Lambda는 `Active`, `LOCATION=98,77`, 스케줄은
  `ENABLED` / `rate(30 minutes)`입니다.
- 정식 스케줄은 20:30(KST) EventBridge `Invocations` 합계 1과
  20:30:47의 Lambda `stored` 로그로 자동 실행을 확인했습니다.
  최신 항목은 `2026-11-20T20:00:00+09:00`, 기온 3.2°C, 습도 42%,
  풍속 1.1m/s, 강수량 0mm였으며, TTL은 관측 시각의 30일 뒤입니다.
- 정식 자동 수집 확인 후 `maestro-weather-dev` 스택을 삭제했고
  `DELETE_COMPLETE`를 확인했습니다. 공용 Weather 테이블은 유지됩니다.
  시험용 시크릿은 `Retain` 정책대로 보존했으며, 더 이상 사용하지 않으면
  키 소유자가 위 절차에 따라 복구 기간을 두고 삭제할 수 있습니다.
- CloudTrail trail 조회 결과는 비어 있었습니다. 지속 보관되는 감사 로그 설정은
  확인하지 못했으며, 템플릿 검증과 실행 검증은 이를 대신하지 않습니다.
