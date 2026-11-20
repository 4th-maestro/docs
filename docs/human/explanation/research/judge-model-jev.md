# 판단 특화 모델 JEV 조사

> **요약** (기준일 2026-11-20)
>
> - JEV는 TypeSafe AI의 판단 특화 모델("System One 모델")이며, 글 대신 미리 정한 선택지 중 하나와 선택지별 확률을 반환함. 2026-09-15 얼리 액세스 공개
> - AI 도구 선택 평가에는 정답이 정해져 있어 JEV 없이 정답 비교로 자동 채점 가능. JEV는 답변 글 품질(수치 일치, 되묻기 적절성)처럼 판단이 필요한 항목에 적합
> - 외부 API라 "AWS 서비스만 사용" 원칙과 충돌함. 2026-11-20 완성안에 따라 운영 빈 방·이상 판단에 한해 예외로 확정([외부 판단 API JEV 운영 사용](../decisions/2026-11-20%28%EC%99%B8%EB%B6%80%20%ED%8C%90%EB%8B%A8%20API%20JEV%20%EC%9A%B4%EC%98%81%20%EC%82%AC%EC%9A%A9%29.md))
>
> | 항목 | 내용 | 확인 수준 |
> |---|---|---|
> | 반환 형식 | 선택지 1개 + 선택지별 확률(최대 확률을 확신도로 사용) | 2차 자료(Arize, Langfuse, 논문) |
> | 모델 이름 | `jev-latest`(=`jev-1.14.0`), `jev-1.13.0` | 원문(docs.typesafe.ai) |
> | 반복 실행 변동 | 같은 300문항 2회 실행에서 판단 최대 1.33% 변경 | 논문 초록·본문(미검증 사전 공개) |
> | 가격 | 입력 100만 토큰당 0.042달러, 출력 무료 | 원문(docs.typesafe.ai) |
>
> **다음 작업**: 없음(30문항 판단 결과는 [도구 선택 평가](ai-tool-eval.md) 4절)

AI 운영 도우미가 새 도구(묶음 합계, 기간 추이)를 질문에 맞게 선택하는지 평가할 방법을 정하기 위해 조사했습니다.

## 1. 모델 개요: 선택지 판단과 확률

**1-1. JEV는 긴 글을 생성하지 않고, 정해진 선택지에 대한 판단과 확률만 반환합니다.**

| 항목 | 내용 | 출처 |
|---|---|---|
| 호출 구성 | state(판단할 데이터), instructions(판단 지시), criteria(허용 선택지와 설명) | [Arize](https://arize.com/blog/jev-llm-judge-consistency/) |
| 인증 | TypeSafe API 키 1개 | [Langfuse](https://langfuse.com/docs/evaluation/evaluation-methods/jev-as-a-judge) |
| 연동 | Langfuse(실험 기능), MLflow `make_judge`(모델 `typesafe:/jev-latest`) | [Langfuse](https://langfuse.com/docs/evaluation/evaluation-methods/jev-as-a-judge), [MLflow](https://mlflow.org/blog/jev-llm-judge) |
| 판단 속도 | 0.6~1.2초(비교 LLM 2.9~4.3초, 방사선 보고서 과제 5회) | [논문](https://arxiv.org/pdf/2609.27607) |
| 정확도 | 일반 선호 판단에서 최신 LLM 판정기와 3%p 이내 | [논문](https://arxiv.org/pdf/2609.26550) |

## 2. 주의점: 미검증, 변동, 형식과 내용

**2-1. 동료 심사 평가가 아직 없고, 형식이 맞아도 판단이 틀릴 수 있어 확신도가 낮은 건은 사람이나 더 강한 모델에 넘기는 설계가 권장됩니다.**

- 공개 논문은 사전 공개본이며, 가중치와 구조는 공개되지 않았습니다([한국어 정리](https://www.remio.ai/ko/post/jev-benchmark-finds-a-useful-decision-model-not-a-frontier-reasoner-ko)).
- 같은 입력에서도 확률이 조금씩 달라지며, 판단이 바뀌는 경우는 드뭅니다([Arize](https://arize.com/blog/jev-llm-judge-consistency/)).
- MLflow 사례에서는 빠르고 저렴하지만 어려운 답변에서 오류가 문제가 되었다고 보고했습니다([MLflow](https://mlflow.org/blog/jev-llm-judge)).

## 3. 이 프로젝트 적용 판단

**3-1. 도구 선택은 정답 비교로, 답변 글 품질만 판단 모델로 평가하는 것이 적합합니다.**

| 평가 항목 | 방법 | 이유 |
|---|---|---|
| 고른 도구와 인자(층, 용도, 기간) | 질문별 정답과 정확히 비교 | 정답이 정해져 있어 재현 가능, 판단 모델의 오류 가능성 제거 |
| 답변 글이 도구 결과 수치와 일치하는지, 되묻기가 적절한지 | JEV 또는 Bedrock Haiku 5.5 판정, 확신도 낮은 건은 사람 검토 | 정해진 정답이 없는 판단 항목 |

주: JEV는 AWS 밖의 외부 API입니다. 운영 사용 범위와 조건은 [외부 판단 API JEV 운영 사용](../decisions/2026-11-20%28%EC%99%B8%EB%B6%80%20%ED%8C%90%EB%8B%A8%20API%20JEV%20%EC%9A%B4%EC%98%81%20%EC%82%AC%EC%9A%A9%29.md)에 있습니다. AWS 안에서 끝내려면 Bedrock Haiku 5.5 판정이 대안입니다.

## 4. 호출 형식: TypeSafe 직접 호출

**4-1. 직접 호출은 `POST https://api.typesafe.ai/v1/systemone`이며, 인증은 `Authorization: Bearer` API 키입니다.**

| 항목 | 내용 | 출처 |
|---|---|---|
| 모델 | `jev-1.14.0`(현재, 2026-10-14부터), `jev-1.13.0`, 별칭 `jev-latest`(=1.14.0) | [모델 목록](https://docs.typesafe.ai/models) |
| 요청 | `{model, state, questions}`, 선택형은 `type: "choice"`, `criteria`(1~255개), `instructions`(선택) | [API 참조](https://docs.typesafe.ai/api) |
| 응답 | `{model, answers, usage}`, 선택형 응답은 `choice`, `confidence`, `probabilities` | [API 참조](https://docs.typesafe.ai/api) |
| 한도 | 요청 전체 64K 토큰, state와 질문 1개 32K 토큰, 질문 개수 제한 없음, 요청 본문 32MiB | [모델 목록](https://docs.typesafe.ai/models), [오류](https://docs.typesafe.ai/api/errors.md) |
| 가격 | 입력 100만 토큰당 0.042달러, 출력 무료(1.14, 1.13 동일) | [모델 목록](https://docs.typesafe.ai/models) |
| 키 | `https://console.typesafe.ai/keys` 발급, 환경 변수 `TYPESAFE_API_KEY` 권장 | [빠른 시작](https://docs.typesafe.ai/introduction/quickstart) |

주: 사용자는 2026-11-20 TypeSafe에서 선불 충전 키를 발급했습니다. 평가 스크립트 `lambda/tools/eval_ai.py`는 `TYPESAFE_API_KEY`가 있으면 직접 호출합니다.

## 5. 중개 서비스 경로: 참고



**5-1. 요청은 `{model, state, questions}`, 선택형 응답은 `choice`, `confidence`, `probabilities`이며, 세 중개 서비스 문서의 필드 이름이 같습니다.**

| 이용 경로 | 주소 | 모델 이름 | 출처 |
|---|---|---|---|
| DigitalOcean | `POST https://inference.do-ai.run/v1/systemone` | `typesafe-jev-1.13.0` | [DigitalOcean 문서](https://docs.digitalocean.com/products/inference/how-to/use-system-one-api/) |
| AIML API | `POST https://api.aimlapi.com/v1/decisions` | `typesafe/jev`(현재 1.14) | [AIML API 문서](https://docs.aimlapi.com/api-references/decision-models/typesafe/jev.md) |
| Cloudflare | `POST .../accounts/{계정}/ai/run`, 본문 `input` 아래에 state·questions | `typesafe/jev` | [Cloudflare 문서](https://developers.cloudflare.com/ai/models/typesafe/jev/) |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` | [OpenRouter 문서](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request) |

- 선택형 질문: `type: "choice"`, `instructions`, `criteria`(선택지별 적용 기준). 선택지는 1~255개입니다(AIML API).
- 응답: `answers.<질문>.choice`(선택), `confidence`(0~1), `probabilities`(합계 1).
- 문맥 한도는 문서마다 다릅니다(DigitalOcean 요청 전체 64K·state와 가장 긴 질문 32K, Cloudflare 32,000, AIML API 262,144 토큰).

## 6. 확인하지 못한 항목

- 조직별 요청 한도(초당 토큰·요청 수)는 문서에 없고 콘솔에서만 확인할 수 있습니다.

## 관련 자료

- [JEV-as-a-Judge 논문](https://arxiv.org/pdf/2609.26550), [JEV vs LLM as a Judge](https://www.analyticsvidhya.com/blog/2026/10/jev-vs-llm-as-a-judge-evals/), [Typed Decision Models 점검 목록](https://arxiv.org/pdf/2609.32160)
