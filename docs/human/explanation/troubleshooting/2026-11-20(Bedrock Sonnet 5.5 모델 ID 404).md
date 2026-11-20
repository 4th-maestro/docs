# Bedrock Sonnet 5.5 모델 ID 404

> **요약** (기준일 2026-11-20)
>
> - 첫 배포 후 `POST /query`가 500을 반환함. 원인은 bedrock-mantle 엔드포인트의 Sonnet 5.5 모델 ID 미제공(404)
> - bedrock-runtime의 global 추론 프로필 `global.anthropic.claude-sonnet-5-5`로 바꿔 해결함. 배포 API 질의 2건 200 응답(3.8초, 8.5초)
> - 모델 상한 Sonnet 5.5는 유지함
>
> | 호출 경로 | 모델 ID | 결과 |
> |---|---|---|
> | bedrock-mantle(서울) | `anthropic.claude-sonnet-5-5` | 404 |
> | bedrock-mantle(서울) | `global.anthropic.claude-sonnet-5-5` | 404 |
> | bedrock-mantle(버지니아) | `anthropic.claude-sonnet-5-5` | 404 |
> | bedrock-mantle(서울) | `anthropic.claude-sonnet-5` | 200 |
> | bedrock-runtime(서울) | `anthropic.claude-sonnet-5-5` | 400, 온디맨드 직접 호출 불가 |
> | bedrock-runtime(서울) | `global.anthropic.claude-sonnet-5-5` | 200 |
>
> **다음 작업**: 없음

## 1. 증상: 질의 API 500, 화면은 목업 응답

**1-1. 배포 직후 `POST /query`가 `Internal Server Error`를 반환했습니다.**

상태 조회(`GET /rooms/status`)와 스케줄 API는 정상이었습니다. 웹 화면은 질의 실패 시 목업으로 대체하므로 "목업 응답" 표시와 정규식 기반 답변이 나왔습니다. CloudWatch 로그의 오류는 다음과 같습니다.

```text
NotFoundError: Error code: 404 - The model 'anthropic.claude-sonnet-5-5' does not exist
```

배경 지식으로, Bedrock의 Claude 호출 경로는 2가지입니다. bedrock-mantle은 Anthropic Messages API 형식 엔드포인트이고, bedrock-runtime은 `InvokeModel`·`Converse` 엔드포인트입니다. 최신 모델은 리전 직접 호출 대신 추론 프로필(`global.` 접두사) 경유만 허용하는 경우가 있습니다.

## 2. 조사 과정: 경로와 모델 ID 조합 6건

**2-1. 로컬 프로필(`maestro`)로 최소 호출(최대 16토큰)을 보내 경로별 응답을 비교했습니다.**

| 가설 | 확인 방법 | 결과 |
|---|---|---|
| 서울 리전에 Sonnet 5.5 미제공 | `list_inference_profiles`, 버지니아 Mantle 호출 | 제외. 서울에 global 프로필 존재, 버지니아 Mantle도 404 |
| Mantle의 모델 ID 형식 차이 | `global.` 접두사로 Mantle 호출 | 제외. 404 |
| Mantle 자체 장애 | Mantle로 Sonnet 5 호출 | 제외. 200 |
| Sonnet 5.5는 추론 프로필 경유만 허용 | bedrock-runtime 직접 ID와 global 프로필 비교 | 채택. 직접 ID 400, global 프로필 200 |

주: Mantle 모델 목록 API(`GET /v1/models`)는 404라서 Mantle이 제공하는 전체 모델 목록은 확인하지 못했습니다.

## 3. 원인: Mantle의 Sonnet 5.5 미제공

**3-1. 2026-11-20 기준 이 계정의 bedrock-mantle은 Sonnet 5.5 모델 ID를 제공하지 않았습니다.**

설계 단계에서 Mantle 지원 여부를 import 테스트로만 확인하고 실제 호출은 하지 않았습니다([기술 선택 기록](../decisions/2026-11-20%28AWS%20%EC%95%84%ED%82%A4%ED%85%8D%EC%B2%98%EC%99%80%20%EA%B8%B0%EC%88%A0%20%EC%8A%A4%ED%83%9D%29.md) 표의 "호출은 미실행").

## 4. 해결: bedrock-runtime global 추론 프로필

**4-1. 클라이언트를 `AnthropicBedrock`(bedrock-runtime)으로 바꾸고 모델 ID를 global 프로필로 바꿨습니다.**

| 항목 | 이전 | 변경 |
|---|---|---|
| 클라이언트 | `AnthropicBedrockMantle` | `AnthropicBedrock` |
| 모델 ID | `anthropic.claude-sonnet-5-5` | `global.anthropic.claude-sonnet-5-5` |
| 허용 값 | Sonnet 5.5, Haiku 5.5(직접 ID) | Sonnet 5.5, Haiku 5.5(global 프로필) |
| IAM | `bedrock-mantle:CreateInference`, 전체 리소스 | `bedrock:InvokeModel`, 프로필 ARN과 기반 모델 ARN만 |

Mantle의 Sonnet 5는 동작했지만 결정한 모델(Sonnet 5.5)과 달라 채택하지 않았습니다. 요청 형식(strict 도구, `output_config.effort`)은 바꾸지 않았고 두 경로 모두 동작했습니다.

## 5. 검증: 로컬 2건, 배포 API 2건, 웹 1건

**5-1. 배포 API 질의 2건이 200으로 응답했고, 웹 화면에서 "목업 응답" 표시가 사라졌습니다.**

| 질의 | 응답 시간 | 결과 |
|---|---:|---|
| 2층 13시 이후 미사용 회의실 냉방 OFF | 8.5초 | 스케줄 초안, 대상 3곳 |
| 1층에서 온도가 가장 높은 곳 3곳 | 3.8초 | 조회 결과, 강조 3곳 |

## 6. 재발 시 확인 순서

1. CloudWatch에서 `QueryFunction` 로그의 오류 코드를 확인하십시오. 404는 모델 ID, 403은 IAM 또는 모델 접근 권한입니다.
2. `aws bedrock list-inference-profiles --profile maestro`로 global 프로필 ID를 확인하십시오.
3. `ModelId` 기본값을 바꿨다면 `sam deploy`에 `--parameter-overrides ModelId=...`를 함께 지정하십시오. 스택에 저장된 이전 값이 `AllowedValues` 검사에서 거부됩니다.

## 관련 코드

- `lambda/src/query.py`: 클라이언트와 모델 ID
- `lambda/template.yaml`: `ModelId` 허용 값, `QueryFunction` IAM 정책
