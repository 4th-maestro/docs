# HVAC 시나리오 v1.0 재현 실험

이 실행기는 설계도의 오프라인 전처리·검증 단계에서 사용할 수 있다. 관리자 대시보드는 기존 API를 사용한다. EventBridge의 1분 상태 계산 및 5분 운전 판단 주기와 이 실험의 15분 제어 간격은 별개다. Jev는 설계도에서 Lambda가 호출하는 외부 판단 API이며, 이 실행기는 외부 호출 없이 동작한다.

## 실행

example에는 제6공학관 한 호실의 합성 입력과 자원 레지스트리가 있다. 실제 비교에서는 보유 중인 대상 지역의 KST EPW를 사용한다. 예시를 실행하려면 EPW를 example/busan.epw 위치에 두거나 scenario.json의 weather.file을 상대 경로로 바꾼다. EnergyPlus 24.2가 자동으로 발견되지 않으면 ENERGYPLUS_DIR에 설치 폴더를 지정한다.

~~~sh
node twin/tools/run-experiment.mjs twin/experiments/example/scenario.json twin/experiments/example/registry.json validate
node twin/tools/run-experiment.mjs twin/experiments/example/scenario.json twin/experiments/example/registry.json compare
~~~

validate는 공통 입력 계약을 검증한다. compare는 선택한 엔진의 지원 범위까지 확인하고 상시 운전과 재실 기반 운전을 실행한다. 마지막 인자로 결과 디렉터리를 지정할 수 있다. 기본값은 OS 임시 디렉터리의 maestro-hvac-experiments다. 단일 운전안은 compare 대신 always 또는 occupancy를 지정한다.

- scenario.json의 참조 파일 경로는 scenario.json 기준, registry.json에 적는 building.json 경로는 registry.json 기준이다. 실제 실험에서는 건물·설비 설정과 부하 프로필의 버전을 고정한다.
- always는 지정된 설정온도로 운전 가능 상태를 유지한다. occupancy는 현재 재실 또는 공개 범위 내 예정 재실이 있으면 가동한다. 두 정책 모두 레지스트리의 고정 설정온도를 사용한다. comfort.priority의 정책별 해석, 실내 상태를 읽는 제어 루프, Jev 어댑터는 후속 연동 범위다.
- 초기화 프로필 preceding_day_off는 양쪽 모두 동일한 전날 기상과 침기 아래 HVAC 및 시간별 부하를 끈 상태로 시작한다. 전날과 구간 밖 결과는 통계에서 제외한다. 실행 날짜는 전날을 포함한 같은 달력 연도 범위이며 윤일은 지원하지 않는다.
- 자원 레지스트리의 HVAC 모드는 호실당 COOL 또는 HEAT 중 하나다. 끄기 동작은 지원한다. FAN, 모드 전환, 최소 가동·정지 제한, 동일 공유 설비의 복수 호실 제어, 창문 개방은 현재 어댑터에서 지원하지 않는다. 시간별 활동 발열값은 바꿀 수 있으며 동일 호실의 현열·복사 분율은 일정해야 한다.
- 실행마다 고유 폴더에 result.json이 생성되며 EnergyPlus는 엔진 로그도 저장한다. 동일 입력은 같은 체크섬을 사용한다. 온도는 구간 평균이고 EnergyPlus 전력은 Ideal Loads 열량을 고정 COP로 환산한 추정치다. 송풍기·공용 설비 소비전력과 실측 보정은 포함하지 않는다. 쾌적 이탈은 재실한 호실의 15분 구간 평균 온도로 집계한다.


## 5R1C

같은 명령의 마지막에 --engine=5r1c를 넣으면 EnergyPlus 설치 없이 실행한다. --engine=both는 두 엔진의 결과를 각각 반환한다. 옵션이 없으면 EnergyPlus를 사용한다.

~~~sh
node twin/tools/run-experiment.mjs twin/experiments/example/scenario.json twin/experiments/example/registry.json compare --engine=5r1c
~~~

호실별 thermal_5r1c에는 공기–표면, 표면–열질량, 열질량–외기, 창–외기 열전달 계수(W/K), 열용량(J/K), 체적(m³), 유효 일사 면적(m²), 출처를 설정한다. 다섯 번째 열전달 계수는 침기와 시간별 환기량에서 계산한다. 예시 계수는 실행 검증용 가정값이며 호실별 실측이나 EnergyPlus 결과에 맞춰 보정할 수 있다.

5R1C는 ISO 13790의 열회로 구조를 참고한다. 각 15분 동안 EPW 시간별 외기와 일사를 유지하고, 수평면 일사에 유효 면적을 곱해 일사 취득을 근사한다. 복사열은 열질량과 표면에 절반씩 배분한다. 전날 0시 외기온도를 초기 열질량 온도로 두고 전날부터 열 상태를 계산해 초기화한다. 잠열·습도와 공용 설비 전력은 계산하지 않는다. 전력은 현열 부하를 고정 COP로 나눈 추정치다. 두 엔진의 온도·전력 차이는 보정에 참고할 수 있다.

5R1C는 설정온도나 가동 시각 후보를 빠르게 평가할 수 있는 예측 모델이다. 현재 비교 명령은 두 가지 규칙을 평가한다. 후보 탐색이나 MPC는 이 모델을 호출하는 별도 제어기에서 구현한다.