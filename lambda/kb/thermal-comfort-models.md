# 온열 쾌적 지표 PMV·PPD와 공개 도구·데이터(pythermalcomfort, CBE Thermal Comfort Tool, ASHRAE Global Thermal Comfort Database II)

| 항목 | 내용 |
|---|---|
| 문서명 | pythermalcomfort 문서와 소스(v4.8.1), CBE Thermal Comfort Tool 논문, pythermalcomfort 논문, ASHRAE Global Thermal Comfort Database II 데이터 기록 |
| 발행 기관 | UC Berkeley Center for the Built Environment(CBE), Elsevier SoftwareX, Dryad |
| 출처 URL | https://github.com/CenterForTheBuiltEnvironment/pythermalcomfort, https://doi.org/10.1016/j.softx.2020.100563, https://doi.org/10.1016/j.softx.2020.100578, https://doi.org/10.6078/D1F671 |
| 기준일 | 2026-11-20(pythermalcomfort v4.8.1, 데이터셋 2022-07-15 게시 버전) |
| 원문 확인일 | 2026-11-20 |
| 라이선스·근거 | pythermalcomfort MIT(소프트웨어와 문서), SoftwareX 논문 2편 CC BY 4.0, 데이터셋 CC0 1.0. 모두 자체 문장으로 요약하고 출처 표시. ASHRAE 55, ISO 7730 표준 원문은 유료라 미수록 |

## 요점

- PMV(예측 평균 온열감)는 여러 사람의 평균 온열감을 예측하는 지표입니다. 입력은 건구온도, 평균복사온도, 상대풍속, 상대습도, 대사량(met), 착의량(clo) 6개입니다.
- PPD(예측 불만족률)는 PMV로 계산합니다. 식은 PPD = 100 − 95 × exp(−0.03353 × PMV⁴ − 0.2179 × PMV²)입니다. PMV 0에서 PPD는 5%, PMV ±0.5에서 약 10%입니다.
- pythermalcomfort의 ASHRAE 55 판정(`compliance`)은 −0.5 < PMV < 0.5일 때 1입니다.
- 실내 기온과 습도만으로는 PMV를 계산할 수 없습니다. 평균복사온도, 풍속, 대사량, 착의량은 측정값이 없으면 가정값입니다. 가정값을 썼다면 답변에 가정임을 밝혀야 합니다.

## PMV 온열감 구간(pythermalcomfort 기준)

| PMV 구간 | 온열감 |
|---|---|
| −2.5 미만 | 추움(Cold) |
| −2.5 이상 −1.5 미만 | 서늘함(Cool) |
| −1.5 이상 −0.5 미만 | 약간 서늘함(Slightly Cool) |
| −0.5 이상 0.5 미만 | 중립(Neutral) |
| 0.5 이상 1.5 미만 | 약간 따뜻함(Slightly Warm) |
| 1.5 이상 2.5 미만 | 따뜻함(Warm) |
| 2.5 이상 | 더움(Hot) |

자료: pythermalcomfort `pmv_ppd_iso.py`의 구간 정의(MIT).

## 입력 적용 범위

| 기준 | 건구온도(℃) | 평균복사온도(℃) | 상대풍속(m/s) | 대사량(met) | 착의량(clo) | 기타 |
|---|---|---|---|---|---|---|
| ISO 7730(pmv_ppd_iso) | 10~30 | 10~40 | 0~1 | 0.8~4 | 0~2 | 수증기압 0~2,700Pa, PMV −2~2 |
| ASHRAE 55-2020(pmv_ppd_ashrae) | 10~40 | 10~40 | 0~2 | 1~4 | 0~1.5 | 재실자가 풍속을 조절할 수 없으면 추가 제한 |

주: 범위를 벗어나면 pythermalcomfort는 기본 설정에서 값 대신 NaN을 반환합니다. ASHRAE 55 방식은 풍속의 냉각 효과를 SET로 먼저 계산한 뒤 PMV에 반영합니다.

## 적응 쾌적 모델의 적용 조건

- ASHRAE 55 적응 모델은 기계식 냉난방을 가동하지 않는 자연환기 공간에만 적용합니다.
- 추가 조건은 대사량 1.0~1.5met, 착의량 0.5~1.0clo 범위의 자유로운 조절, 외기 이동평균온도 10~33.5℃입니다.
- 따라서 HVAC 가동 중인 호실의 쾌적 판정에는 적응 모델을 쓰지 않습니다.

## CBE Thermal Comfort Tool

- UC Berkeley CBE가 운영하는 무료 웹 도구입니다.
- 주소: https://comfort.cbe.berkeley.edu
- 논문(Tartarini 외 3인, SoftwareX 12, 100563, 2020) 기준으로 ASHRAE 55-2017, ISO 7730:2005, EN 16798-1:2019 계산을 지원합니다.
- 같은 논문은 PMV, SET, 적응 모델, 국부 불쾌감 모델, SolarCal을 포함하고 연간 4.9만 명 이상이 사용한다고 보고했습니다.
- 도구 소스와 문서 저장소(CenterForTheBuiltEnvironment/comfort_tool)는 GPL-2.0입니다. 이 KB에는 도구 문서 문장을 옮기지 않았습니다.

## pythermalcomfort

- CBE가 관리하는 Python 열쾌적 계산 패키지입니다. 논문은 Tartarini, Schiavon, SoftwareX 12, 100578(2020)입니다.
- PMV·PPD(ISO, ASHRAE), SET, 적응 모델, UTCI, 열지수, 불쾌지수 등 모델 모듈 약 40개를 포함합니다(v4.8.1 소스의 models 폴더 공개 모듈 40개).
- 이 패키지의 불쾌지수는 기상청 불쾌지수와 식과 단계가 다릅니다. 관련 문서는 discomfort-index-kma.md입니다.

## ASHRAE Global Thermal Comfort Database II

- 실제 건물 현장 조사에서 수집한 주관 응답과 동시 측정값을 묶은 공개 데이터셋입니다. 2014년 CBE와 시드니대 IEQ 연구실이 시작했습니다.
- 행 수는 품질 검증 후 77,304행, RP-884 데이터 25,288행, 2.1 버전 추가 6,441행을 더한 109,033행입니다.
- 라이선스는 CC0 1.0입니다. 개발 논문은 Földváry Ličina 외, Building and Environment 142, 502~512쪽(2018)입니다.
- 이 데이터는 쾌적 모델 검증용 원자료입니다. 특정 건물의 운영 기준값으로 직접 쓰는 자료가 아닙니다.
