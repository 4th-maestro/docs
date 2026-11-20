# hvac_control

규칙 기반 제어와 JEV 기반 제어로 공간별 냉난방 설정온도를 정하고, EnergyPlus 26.2.0 시뮬레이션에서 두 방식을 비교하는 폴더입니다. 비교 조건과 결과는 [HVAC 제어 방식 비교 기술 선택 기록](../../docs/human/explanation/decisions/2026-11-20%28HVAC%20%EC%A0%9C%EC%96%B4%20%EB%B0%A9%EC%8B%9D%20%EB%B9%84%EA%B5%90%29.md)에 있습니다.

| 경로 | 내용 |
|---|---|
| `control.py` | 공간 5곳 정보, 사용 일정, 규칙 기반 제어, JEV 선택지·판단 지시·API 호출 |
| `run.py` | 모델 생성(예제 VRF 5구역 + 부산 기상·설계일), EnergyPlus 실행, 15분 제어 콜백, 지표 계산 |
| `test_control.py` | 규칙, 사용 일정, 선택지, 지표 단위 테스트 7건(EnergyPlus 불필요) |
| `vacancy_off.py` | 공실 OFF 규칙(사용 N분 전 재가동) 실행. `run.py`·`control.py`는 수정하지 않고 규칙 함수만 교체. 예: `python3 vacancy_off.py --season cooling --start 2026-08-03 --days 14 --lead 30 60 90` |
| `test_vacancy_off.py` | 공실 OFF 규칙 단위 테스트 1건(EnergyPlus 불필요) |
| `ddpg.py` | DDPG 학습·평가. `run.simulate`를 스레드로 실행하는 Gymnasium 환경, 체크포인트별 검증, 평가 기간 지표 산출. SageMaker에서는 EnergyPlus Linux 빌드와 기상 파일을 작업 안에서 내려받음 |
| `test_ddpg.py` | 행동 변환, 보상, 학습 날짜 단위 테스트 3건(numpy 필요) |
| `requirements.txt` | DDPG 추가 패키지(stable-baselines3 2.9.2, gymnasium 1.4.0). torch는 SageMaker PyTorch 컨테이너 기본 패키지 사용 |
| `results/` | 비교에 사용한 실행별 `summary.json` 사본. `-v1`은 조정 전, `-v2`는 조정 1회 후 JEV 판단 기준 |
| `runs/` | 실행 출력(15분 기록 `steps.csv`, `summary.json`, EnergyPlus 파일). 커밋 제외 |

## 준비

1. EnergyPlus 26.2.0 macOS arm64 tar.gz를 [GitHub 릴리스](https://github.com/NatLabRockies/EnergyPlus/releases/tag/v26.2.0)에서 내려받아 `~/.local/opt/`에 압축을 푸십시오. 다른 위치는 환경 변수 `ENERGYPLUS_DIR`로 지정합니다.
2. 부산 기상 파일 `KOR_PU_Busan-Daecheongdong.WS.471590_TMYx.2009-2023.zip`을 [climate.onebuilding.org](https://climate.onebuilding.org/WMO_Region_2_Asia/KOR_South_Korea/index.html)에서 내려받아 `~/.local/opt/epw-busan/`에 압축을 푸십시오. 같은 폴더의 `.ddy`(설계일)도 사용합니다. 다른 위치는 `EPW`로 지정합니다.
3. JEV 실행에는 `ml/hvac_control/.env` 파일에 `TYPESAFE_API_KEY=키` 1줄을 넣으십시오. 환경 변수도 사용할 수 있습니다. `.env`는 커밋하지 마십시오.

규칙 기반·JEV 실행에는 외부 패키지가 없습니다. Python 3.10 이상과 EnergyPlus 내장 `pyenergyplus`를 사용합니다. DDPG는 `requirements.txt`와 torch가 필요합니다.

## 실행

```bash
cd ml/hvac_control
python3 -m unittest test_control
python3 run.py --controller rule --season cooling --start 2026-08-03 --days 14
python3 run.py --controller jev --season cooling --start 2026-08-03 --days 14
```

| 인자 | 값 |
|---|---|
| `--controller` | `rule`(규칙 기반), `jev`(JEV 기반) |
| `--season` | `cooling`(냉방, 쾌적 24~26℃), `heating`(난방, 쾌적 20~22℃) |
| `--start`, `--days` | 실행 시작일과 일수. 연도는 요일 계산에만 사용, 기상은 TMYx 대표 연도 |

규칙 기반 14일 실행은 약 1초입니다. JEV 기반은 15분마다 API를 1회 호출하므로 14일 실행에 1,344회 호출이 필요합니다. 모델 이름은 `JEV_MODEL`로 바꿀 수 있으며 기본값은 `jev-latest`입니다.

## DDPG 학습

```bash
cd ml/hvac_control
python3 -m unittest test_ddpg
python3 ddpg.py --season cooling --steps 500000 --ckpt 25000 --lam 1 --seed 0 --out runs/ddpg-cooling   # 로컬
ml/sagemaker.sh ddpg smoke    # SageMaker 환경 점검: 3,000단계
ml/sagemaker.sh ddpg          # SageMaker 학습: 50만 단계, 최대 4시간. SEASON, LAM, SEED, DDPG_INSTANCE(기본 ml.m5.xlarge, 16GiB)로 변경
```

| 항목 | 값 |
|---|---|
| 학습 기간 | 냉방 2026-06-01~07-12, 난방 01-01~01-11과 12-01~12-31. 에피소드마다 1일 무작위 선택 |
| 검증 기간 | JEV 조정 기간과 같음(냉방 07-13~19, 난방 01-12~18). 체크포인트마다 평가, 보상 최고 체크포인트 선택 |
| 평가 기간 | 규칙 기반·JEV와 같음(냉방 08-03~16, 난방 02-02~15) |
| 관측·행동·보상 | `ddpg.py` 첫 주석. 다음 사용까지 남은 시간은 명세에 없는 입력으로, 규칙 기반·JEV와 같은 정보를 주려고 추가 |
| 출력 | `summary.json`(평가 지표, 학습 시간, 체크포인트별 검증 곡선), `steps.csv`, `train.monitor.csv`, `ckpt/` |

## 지표

| 지표 | 계산 |
|---|---|
| `energy_kwh` | `Facility Total HVAC Electricity Demand Rate` × 시스템 시간 간격 합계. VRF 실외기, 실내기 팬 포함 |
| `peak_kw` | 15분 평균 HVAC 전력의 최댓값 |
| `discomfort_zone_h` | 재실 중 실내온도가 쾌적 범위 ±0.5℃ 밖인 공간·시간 합계. `cold_zone_h`, `hot_zone_h`로 분리 |
| `discomfort_degree_h` | 허용 범위를 벗어난 온도 × 시간 합계 |
| `energy_kwh_vacant` | 재실 공간이 없는 15분 구간의 HVAC 전력량 |
| `jev` | 호출 수, 오류, 규칙 기반 대체 횟수, 잘못된 선택, 입력 토큰, 확신도 평균, 확신도 0.8 미만 건수 |
