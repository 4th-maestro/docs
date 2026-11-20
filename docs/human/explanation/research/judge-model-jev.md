# 판단 특화 모델 JEV 조사

> **요약** (기준일 2026-11-20)
>
> - JEV는 TypeSafe AI의 판단 특화 모델("System One 모델")이며, 글 대신 미리 정한 선택지 중 하나와 선택지별 확률을 반환함. 2026-09-15 얼리 액세스 공개
> - AI 도구 선택 평가에는 정답이 정해져 있어 JEV 없이 정답 비교로 자동 채점 가능. JEV는 답변 글 품질(수치 일치, 되묻기 적절성)처럼 판단이 필요한 항목에 적합
> - 외부 API라 "AWS 서비스만 사용" 원칙과 충돌하므로, 사용한다면 제품 경로가 아닌 개발용 평가 스크립트에 한정
>
> | 항목 | 내용 | 확인 수준 |
> |---|---|---|
> | 반환 형식 | 선택지 1개 + 선택지별 확률(최대 확률을 확신도로 사용) | 2차 자료(Arize, Langfuse, 논문) |
> | 모델 이름 | `jev-latest`, 고정 버전 `jev-1.13.0` | 2차 자료(Arize, MLflow) |
> | 반복 실행 변동 | 같은 300문항 2회 실행에서 판단 최대 1.33% 변경 | 논문 초록·본문(미검증 사전 공개) |
> | 가격 | 입력 100만 토큰당 0.042달러, 출력 무료 | 2차 자료(Arize 표 1건, 공식 가격표 미확인) |
>
> **다음 작업**: 도구 선택 정답 비교 평가 세트 30문항 작성(미정)

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

주: JEV는 AWS 밖의 외부 API입니다. 시연 데이터는 가상 데이터라 개인정보는 없지만, 사용 시 API 키 발급과 외부 전송이 필요합니다. AWS 안에서 끝내려면 Bedrock Haiku 5.5 판정이 대안입니다.

## 4. 확인하지 못한 항목

- TypeSafe 공식 API 문서, 엔드포인트, 요금표는 검색되지 않아 확인하지 못했습니다.
- 가격은 Arize 블로그 표 1건의 값이며 공식 가격표와 대조하지 않았습니다.

## 관련 자료

- [JEV-as-a-Judge 논문](https://arxiv.org/pdf/2609.26550), [JEV vs LLM as a Judge](https://www.analyticsvidhya.com/blog/2026/10/jev-vs-llm-as-a-judge-evals/), [Typed Decision Models 점검 목록](https://arxiv.org/pdf/2609.32160)
