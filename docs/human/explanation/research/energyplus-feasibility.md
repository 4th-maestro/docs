# EnergyPlus 도입 검토와 Lambda 경량 열모델 비교

> **요약** (기준일 2026-11-20)
>
> - EnergyPlus는 미국 에너지부(DOE)가 배포하는 건물 에너지 시뮬레이션 엔진. 실측 센서가 없는 건물에서 기상, 일사, 열용량을 반영한 가상 온도·전력을 만들 때 사용
> - API 요청마다 EnergyPlus를 실행하는 구조는 부적합. 원인은 API Gateway 30초 제한, 무상태 시뮬레이터 구조, IFC→IDF 모델 작성 비용. 비동기 설계로 30초 제한은 해소되나 나머지 2가지는 유지(8절)
> - 소스와 알고리즘 문서가 공개되어 역설계 불필요. 권장안은 EnergyPlus 오프라인 계산으로 경량 열모델(ISO 13790 5R1C) 계수를 보정하고 Lambda는 경량 모델만 실행하는 방식
>
> | 항목 | 값 | 비교 기준 |
> |---|---|---|
> | EnergyPlus 최신판 | 26.2.0(2026-09-30) | Linux arm64 공식 빌드 223MB(tar.gz) |
> | 5R1C 순수 Python, 호실 533개 × 744시간(1개월) | 1.08초 | `EnergyFunction` 제한 시간 29초 |
> | 5R1C, 호실 533개 × 168시간(1주) | 0.24초 | 현재 `sim.state` 0.51초 |
> | EnergyPlus 연간 실행 시간(VRF 5구역 예제) | 5.33초(2026-11-20) | 2008년 LBNL 일반 모델 약 2분(당시 하드웨어), 호실 533개 규모 미측정 |
>
> **다음 작업**: 채택안 결정 후 기술 선택 기록 작성, 호실 533개 규모 EnergyPlus 실행 시간 측정(미정)

[시스템 설계](../architecture.md) 6절 가상 데이터 생성에 EnergyPlus를 도입할지 검토한 기록입니다. 2026-11-20 웹 검색 14회, GitHub API 조회 2회, 로컬 측정 1회로 확인했습니다. 채택안은 결정 후 [기술 선택 기록](../decisions/README.md)에 별도로 작성합니다.

## 1. EnergyPlus: 건물 모델과 기상 파일로 구역별 열부하를 계산하는 엔진

**1-1. EnergyPlus는 건물 모델(IDF·epJSON)과 시간별 기상 파일(EPW)을 입력받아 구역별 실내온도, 냉난방 부하, 설비 에너지를 계산합니다.**

계산 간격은 1시간보다 짧은 타임스텝입니다. 9.3 이후 버전은 Python API(`pyenergyplus`)를 제공합니다. 외부 스크립트는 실행 중인 시뮬레이션에 콜백을 등록하고 센서 값 조회와 설정값(액추에이터) 변경을 수행할 수 있습니다.

**표 1.1 EnergyPlus 입력, 출력, 배포 형태**

| 항목 | 내용 | 확인 수준 |
|---|---|---|
| 입력 | 건물 모델 IDF·epJSON(형상, 구조체, 내부 발열, 스케줄, 설비), 기상 EPW | 공식 문서 |
| 출력 | 구역·설비별 시계열(온도, 부하, 에너지), 요약 표, SQLite | 공식 문서 |
| 실행 형태 | 명령줄 실행 파일, C·Python 라이브러리(런타임 콜백) | 공식 문서 |
| 최신판 | 26.2.0, 2026-09-30 배포 | GitHub 릴리스 API |
| Linux 빌드 | Ubuntu 24.04 x86_64 231MB, arm64 223MB, AlmaLinux 9.6 x86_64 126MB(tar.gz) | GitHub 릴리스 API |
| macOS arm64 설치 크기 | 776MB(예제 263MB, 내장 Python 215MB, 전처리 도구 139MB 포함) | 로컬 압축 해제 |
| 저장소 | `NatLabRockies/EnergyPlus`(이전 주소 `NREL/EnergyPlus`) | GitHub API |

주: 웹 검색 요약 일부는 "Linux arm64 공식 빌드 없음"이었으나, 릴리스 API 원문 확인 결과 26.2.0에는 arm64 빌드가 있습니다.

**1-2. 라이선스는 BSD 3조항에 이름 사용 조항 1개를 더한 형식이며, 소스 공개라 역설계 대상이 아닙니다.**

4번 조항은 수정하지 않은 배포본을 "EnergyPlus version X"로 표기하도록 요구합니다. 미국 에너지부 사전 동의 없이 제품명과 광고에 "EnergyPlus", "E+" 명칭을 쓰는 것도 금지합니다. 계산 알고리즘은 공식 Engineering Reference와 소스에 공개되어 있습니다. 필요한 계산식은 문서와 소스를 보고 옮길 수 있습니다.

## 2. 도입 이유: 현재 가상 데이터 생성기의 물리 근거 보완

**2-1. 현재 `lambda/src/sim.py`는 실내온도와 전력을 경험식으로 만들며, 열용량, 일사, 실제 기상을 반영하지 않습니다.**

[시스템 설계](../architecture.md) 6절은 실내온도를 "1차 지연 모델"로 설계했습니다. 구현은 운전 상태가 바뀌는 시각에 실내온도가 즉시 바뀌는 식입니다.

**표 2.1 현재 생성기와 EnergyPlus 비교**

| 항목 | 현재 `sim.py` | EnergyPlus | 영향 기능 |
|---|---|---|---|
| 실내온도(운전) | 설정온도 + 재실 1명당 0.08℃ + 변동 ±0.3℃ | 구역 열평형, 설비 용량 한도 | 상태 시각화, 이상 감지 기대값 |
| 실내온도(정지) | 외기 차이 × 0.3으로 즉시 결정 | 구조체 열용량에 따른 시간 지연 | OFF 스케줄 효과 표시 |
| 전력 | 정격(1㎡당 0.1kW) × 부하율(0.3 + 0.05×재실 + 설정·외기 차/40) | 구역 부하 ÷ 설비 효율 | 에너지 분석, 전기요금 |
| 외기 | 부산 근사 곡선(냉방 27℃, 난방 12℃, 일교차 ±4℃) | EPW 시간별 기상 | 전체 |
| 일사·방위 | 반영 안 함 | 창 방위·면적별 일사 취득 | 호실별 부하 차이 |
| 추천 절감량 | 부하율 식 전후 차이 | 열평형 계산 전후 차이 | 최적 제어 추천 |

**2-2. EnergyPlus를 거치면 절감량과 온도 변화에 물리 계산 근거가 생기며, 결과는 계속 가상 데이터입니다.**

[서비스 기획](../service-plan.md) 7절 위험 표의 "가상 데이터 신뢰도"에 대한 대응 근거입니다. 구조체와 설비 사양은 도면에 없어 가정값이 필요합니다. 화면과 발표의 가상 표시는 유지해야 합니다.

## 3. 구조 적합성: 요청 경로 실행 부적합

**3-1. 현재 구조는 요청마다 상태를 계산하는 무상태 Lambda이고, EnergyPlus는 연속 시계열을 한 번에 계산하는 배치 프로그램입니다.**

**표 3.1 현재 구조와 EnergyPlus 요구 조건**

| 현재 구조 | EnergyPlus 요구 | 필요한 변경 |
|---|---|---|
| HTTP API 응답 30초, `EnergyFunction` 29초 | 연간 계산 분 단위(2008년 LBNL 일반 모델 약 2분) | 비동기 실행과 완료 조회 |
| `sim.state(room, t)`가 시각만으로 값 재현, 저장소 없음 | 시작일부터 연속 계산, 결과 파일 출력 | S3 또는 DynamoDB 시계열 저장 |
| Lambda zip 배포(Python 3.12, arm64) | 실행 파일과 공유 라이브러리, arm64 배포본 223MB(압축) | 컨테이너 이미지와 ECR 추가 가능성 |
| 스케줄 저장 직후 다음 조회에 반영 | 스케줄 변경마다 재계산 | 재계산 대기 상태 표시 |
| IFC에서 호실 다각형·면적만 추출 | 구역, 표면, 구조체, 창, 설비 정의 | IFC→IDF 변환과 가정값 작성 |

주: Lambda 한도(최대 실행 15분, 컨테이너 이미지 10GB, zip 압축 해제 250MB)는 AWS 공식 문서 기준이며 이번 작업에서 원문을 다시 열람하지 않았습니다. arm64 배포본의 압축 해제 크기는 확인하지 않았습니다.

**3-2. 실행 시간보다 모델 작성 비용이 더 큰 위험입니다.**

IFC를 EnergyPlus 모델로 바꾸려면 2차 공간 경계(인접 구역 사이 표면 쌍)가 필요합니다. 연구 자료는 BIM 작성 도구가 이 정보를 올바르게 내보내지 않아 자동·수동 보정이 필요하다고 보고합니다(CBIP 논문, TU Dresden 석사 논문, 검색 요약). 본관 IFC는 호실 269개입니다. 호실 단위 구역으로 변환하면 실행 시간과 형상 오류 보정 부담이 함께 커집니다.

## 4. 후보 비교: 오프라인 보정과 경량 모델 병행 권장

**4-1. EnergyPlus 사용 위치(요청 경로, 오프라인, 미사용)와 Lambda 계산 방식으로 후보 5개를 비교했습니다.**

**표 4.1 후보별 장단점**

| 안 | 구성 | 장점 | 단점 |
|---|---|---|---|
| A. 현행 유지 | `sim.py` 경험식 | 추가 작업 없음 | 열 지연·일사 없음, 절감량 근거 약함 |
| B. 요청 시 EnergyPlus | 컨테이너 Lambda가 스케줄 변경마다 실행, 결과 S3 저장 | 모든 값이 EnergyPlus 결과 | 비동기 흐름, ECR, 시계열 저장, 모델 작성 모두 필요 |
| C. 오프라인 사전 계산 | 로컬에서 기준·시나리오 결과 생성, Lambda는 조회만 | Lambda 구조 변화 적음 | 사전 계산하지 않은 임의 스케줄 계산 불가 |
| D. Lambda 5R1C 자체 구현 | ISO 13790 간이 시간별 모델을 `sim.py`에 구현 | 임의 스케줄, 계산 1초 이내, 배포 구조 유지 | 계수가 가정값, 물리 근거 별도 제시 필요 |
| E. C + D(권장) | EnergyPlus로 대표 호실을 계산해 5R1C 계수 보정, Lambda는 5R1C 실행 | D의 속도와 EnergyPlus 근거 병행 | 대표 호실 IDF 작성, 보정 작업 1회 |

**표 4.2 제외한 후보**

| 후보 | 제외 이유 |
|---|---|
| EnergyPlus 전체 재구현(역설계) | 소스 공개라 역설계 불필요, 전체 기능 이식은 해커톤 범위 밖 |
| EnergyPlus 결과로 학습한 대리 모델(ML) | 학습용 반복 실행 필요(주택 사례 약 400회, 검색 요약), 계수 수가 적은 5R1C보다 설명이 어려움 |
| BOPTEST(Modelica 기반 테스트 환경) | 상시 실행 컨테이너 필요, 현재 서버리스 구조에 서버 운영 추가 |

**4-2. 자체 구현의 현실적 범위는 ISO 13790 5R1C이며, 국내 인증 도구 ECO2도 같은 표준 계열을 사용합니다.**

5R1C는 구역을 열저항 5개와 열용량 1개로 표현합니다. 입력은 바닥면적, 외피 열관류율, 창 면적, 환기량, 내부 발열입니다. 국내 건축물 에너지효율등급 평가 도구 ECO2는 ISO 13790과 DIN V 18599 기반 월간 계산법입니다(KoreaScience 논문 검색 요약). 5R1C를 ASHRAE Standard 140 테스트 케이스 4개로 검증한 연구가 있습니다(Maccarini 2021, 검색 요약). Python 구현체 RC_BuildingSimulator는 공개되어 있으나 기본 브랜치 마지막 갱신이 2021년 3월입니다.

## 5. 측정 결과: 5R1C 호실 533개 1개월 계산 1.08초

**5-1. 순수 Python 5R1C는 같은 기간 계산에서 현재 `sim.state`보다 계산 시간이 짧았습니다.**

현재 `sim.state`는 호출마다 SHA-256 해시를 여러 번 계산합니다. 5R1C 1시간 계산은 사칙연산 수십 회입니다.

**표 5.1 로컬 계산 시간(호실 533개, 1시간 간격)**

| 계산 | 기간 | 반복 | 중앙값 | 비교 기준 |
|---|---|---|---|---|
| 5R1C | 24시간 | 5회 | 0.036초 | 현재 `sim.state` 0.074초 |
| 5R1C | 168시간 | 3회 | 0.243초 | 현재 `sim.state` 0.508초 |
| 5R1C | 744시간 | 3회 | 1.083초 | `EnergyFunction` 제한 29초 |
| 5R1C | 8,760시간 | 1회 | 12.740초 | API 응답 제한 30초 |

주: Apple M4 Pro, Python 3.14.7, 외부 라이브러리 없음. 계수는 ISO 13790 기본값(중량 구조)과 호실당 외벽 1면 가정이며 정확도는 검증하지 않았습니다. 재실 인원과 외기온도는 현재 `sim.py` 함수를 사용했습니다. Lambda(arm64, Python 3.12) 실행 시간은 측정하지 않았습니다. 측정 스크립트는 저장소에 포함하지 않았습니다.

**5-2. EnergyPlus 실행 시간은 VRF 5구역 예제 모델 연간 5.33초이며, 호실 533개 규모는 측정하지 못했습니다.**

2026-11-20 [HVAC 제어 방식 비교](../decisions/2026-11-20%28HVAC%20%EC%A0%9C%EC%96%B4%20%EB%B0%A9%EC%8B%9D%20%EB%B9%84%EA%B5%90%29.md)에서 `VariableRefrigerantFlow_5Zone`(바닥 463.6㎡, 15분 간격, 부산 기상)을 실행했습니다. 연간 5.33초(2회), 14일 0.62~0.74초(3회)이며 제어 콜백과 모델 변환 시간을 포함합니다.

최초 조사 시에는 공식 macOS arm64 배포본(26.2.0)을 내려받아 SHA-256 체크섬을 확인했습니다. 예제 모델 실행은 작업 환경 권한 정책으로 진행하지 않았습니다. 측정 후보는 의원 건물과 용도가 같은 외래 진료 원형 모델(`RefBldgOutPatientNew2004_Chicago.idf`)과 소형 사무소 원형 모델입니다.

참고 수치는 2008년 LBNL 보고서의 "일반 모델 실행 시간 2000년 116분, 2008년 2분"입니다. PNNL 연구는 실행 기간 단축으로 실행 시간이 약 75% 줄고 결과 차이는 1% 이내라고 보고합니다. 두 수치 모두 검색 요약 기준입니다.

## 6. 권장 구성: EnergyPlus 오프라인 보정, Lambda 5R1C 실행

**6-1. 안 E는 현재 API와 배포 구조를 유지하면서 온도 지연과 절감량에 EnergyPlus 근거를 더합니다.**

**표 6.1 안 E 처리 순서**

| 단계 | 위치 | 내용 |
|---|---|---|
| 1 | 로컬 | 대표 호실 원형(용도 4종 × 방위) IDF 작성, 부산 기상 EPW로 연간 계산 |
| 2 | 로컬 | EnergyPlus 시간별 결과에 맞춰 5R1C 계수(열용량, 외피 열손실) 보정 |
| 3 | Lambda 패키지 | 보정 계수 JSON을 `rooms.json`과 같은 방식으로 패키지에 포함 |
| 4 | `sim.py` | 실내온도·전력 계산을 5R1C로 교체, 조회 시각 48시간 전부터 계산해 초기값 영향 제거 |
| 5 | `energy.py` 등 | 시각별 개별 호출을 호실별 연속 계산 결과 재사용으로 변경 |

주: 5R1C는 직전 시각 온도가 필요한 상태 의존 모델입니다. 시각만으로 값을 재현하는 현재 `sim.state` 구조를 그대로 쓰면 호출마다 48시간 계산이 반복됩니다.

**6-2. 발표 근거는 "EnergyPlus version 26.2.0으로 보정한 경량 열모델"이며, 원형 호실 결과와 5R1C 결과의 오차를 함께 제시해야 합니다.**

라이선스 4번 조항에 따라 EnergyPlus는 버전 번호를 포함한 이름으로 표기합니다. 서비스 이름이나 기능 이름에는 EnergyPlus 명칭을 쓰지 않습니다.

## 7. 제한 사항: 실행 시간과 정확도 미검증

**7-1. EnergyPlus 실행 시간과 5R1C 정확도는 이번 조사에서 확인하지 못했습니다.**

**표 7.1 미확인 항목**

| 항목 | 상태 |
|---|---|
| EnergyPlus 실행 시간 | 5구역 예제 연간 5.33초 측정(2026-11-20), 호실 533개 규모 미측정 |
| 5R1C 정확도 | 미검증, 계수 가정값, 일사는 상수 근사 |
| Lambda arm64 실행 시간 | 미측정 |
| Linux arm64 압축 해제 크기, zip 250MB 적합 여부 | 미확인 |
| 부산 EPW | PHIKO 한국 TRY 22개 지점 존재 확인, 부산 포함 여부 미확인 |
| 2008년 LBNL, PNNL 실행 시간 수치 | 당시 하드웨어·버전 기준, 검색 요약 |
| ECO2 계산 기준 | 논문 검색 요약 기준, 최신 버전 계산식 미확인 |

## 8. 비동기 설계 검토: 30초 제한 해소, 모델 작성과 조회 구조 변경 부담 유지

**8-1. 안 B를 비동기 작업으로 바꾸면 API Gateway 30초 제한은 해소되고, 실행 한도는 Lambda 15분으로 바뀝니다.**

스케줄 저장 API는 작업 ID를 즉시 반환합니다. 별도 Lambda가 EnergyPlus를 실행하고 결과를 S3에 저장합니다. 화면은 작업 상태를 조회합니다. 화면은 이미 5초(실시간 상태)와 60초(패널) 간격으로 조회하므로 폴링 방식은 화면 구조 변경이 적습니다. WebSocket 알림은 연결 ID 저장 테이블이 추가로 필요합니다. 현재 `ws.py`는 요청한 연결에만 응답합니다.

**표 8.1 비동기 처리 흐름**

| 단계 | 구성 | 비고 |
|---|---|---|
| 요청 | `POST /schedules` 저장 후 작업 등록, 작업 ID 반환 | 스케줄 묶음 해시를 작업 키로 사용, 마지막 요청만 유효 |
| 대기열 | Lambda 비동기 호출 또는 SQS | 실패 재시도, 실패 작업 보관(DLQ) |
| 실행 | 컨테이너 이미지 Lambda(EnergyPlus 26.2.0 Linux 빌드) | 실행 기간은 오늘 1일 + 워밍업 |
| 저장 | S3 `건물/날짜/스케줄해시` 시계열, DynamoDB 작업 상태 | 지난 날짜는 매일 밤 예약 실행(EventBridge) |
| 조회 | 상태·이력·에너지 API가 저장 결과를 읽음 | 결과가 없으면 `sim.py` 값으로 대체하고 표시 |

주: EnergyPlus 26.2.0의 최소 워밍업 기본값은 1일, 최대 25일입니다(로컬 `Energy+.idd`). 실행 기간을 1일로 줄이면 연간 계산보다 짧아지나 실행 시간은 측정하지 않았습니다.

**8-2. 비동기 설계로도 해소되지 않는 부담은 모델 작성, 조회 구조 변경, 추천 절감량 계산 횟수 3가지입니다.**

**표 8.2 비동기 안 B와 권장안 E 비교**

| 항목 | 비동기 안 B | 안 E |
|---|---|---|
| 수치 근거 | 모든 값이 EnergyPlus 결과 | EnergyPlus로 보정한 5R1C |
| 스케줄 반영 | 작업 완료 후(실행 시간 미측정), 대기 중 표시 필요 | 다음 조회에 즉시 |
| 추가 AWS 자원 | ECR, 컨테이너 Lambda, 대기열, S3 결과, 작업 상태 테이블 | 없음 |
| 코드 변경 | `sim` 사용 파일 9개를 저장 결과 조회로 변경 | `sim.py`와 반복 호출 파일 |
| 모델 작성 | 건물 4곳 전체 IDF(호실 533개) | 대표 호실 원형 몇 종 |
| 추천 절감량 | 기준 1회 + 초안 적용 1회 실행 | 요청마다 계산 |

주: 추천 절감량 2회 실행은 호실 사이 벽을 단열(열교환 없음)로 가정할 때 성립합니다. 이 가정이면 호실별 전후 차이를 실행 2회로 구할 수 있습니다. 가정하지 않으면 초안마다 1회씩 실행해야 합니다.

**8-3. 비동기 EnergyPlus는 지연을 허용하는 "절감량 정밀 계산"에만 쓰는 방식이 안 E와 병행 가능합니다.**

실시간 상태와 스케줄 반영은 안 E의 5R1C로 즉시 처리합니다. 추천 패널에서 요청한 경우에만 EnergyPlus 비동기 작업을 실행합니다. 완료 후 "EnergyPlus 검증값"을 추가로 표시합니다. 이 방식은 대기 중에도 화면이 비지 않습니다. 비동기 인프라는 작업 1종으로 제한됩니다.

## 다음 작업

| 작업 | 기한 | 담당 |
|---|---|---|
| 후보 A~E 중 채택안 결정, 기술 선택 기록 작성 | 미정 | 팀 전체 |
| EnergyPlus 예제(외래 진료 원형, 소형 사무소) 연간·1일 실행 시간 로컬 측정 | 미정 | 미정 |
| 부산 EPW 확보(PHIKO TRY 또는 기상청 ASOS 변환) | 미정 | 미정 |

## 관련 자료

- [EnergyPlus 릴리스(GitHub)](https://github.com/NatLabRockies/EnergyPlus/releases), [라이선스 원문](https://github.com/NatLabRockies/EnergyPlus/blob/develop/LICENSE.txt)
- [Using EnergyPlus as a Library](https://bigladdersoftware.com/epx/docs/9-6/input-output-reference/api-usage.html), [Python Runtime API](https://nrel.github.io/EnergyPlus/api/python/runtime.html)
- [EnergyPlus Run Time Analysis(LBNL 2008)](https://www.osti.gov/servlets/purl/951766), [Reducing EnergyPlus Run Time(PNNL)](https://www.osti.gov/biblio/1178507-reducing-energyplus-run-time-code-compliance-tools)
- [CBIP 논문(UCL)](https://discovery-pp.ucl.ac.uk/id/eprint/1546334/1/CBIP_revised.pdf), [IFC→IDF 변환 석사 논문(TU Dresden)](https://tu-dresden.de/bu/bauingenieurwesen/cib/ressourcen/dateien/publikationen/Projekt-_Diplomarbeiten/Masterarbeit_Patel.pdf?lang=en)
- [ECO2 관련 논문(KoreaScience)](https://koreascience.kr/article/JAKO202324043287571.pdf)
- [5R1C ASHRAE 140 검증(Maccarini 2021)](https://research.unipd.it/retrieve/add1cc7f-2e27-489d-b0ac-149bf2871bbc/Maccarini_2021_J._Phys.__Conf._Ser._2042_012078.pdf), [RC_BuildingSimulator](https://github.com/architecture-building-systems/RC_BuildingSimulator)
- [EnergyPlus 대리 모델 사례(TU/e)](https://research.tue.nl/en/publications/fast-building-performance-simulation-method-for-evaluating-renova/)
- [기상 파일 출처 목록(climate.onebuilding.org)](https://climate.onebuilding.org/sources)
- [AWS Lambda 할당량](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), [HTTP API 할당량](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html)
- [도면 인식·공조 고장 진단 기술 조사](floorplan-hvac-twin-tech.md) 5절(BOPTEST)
