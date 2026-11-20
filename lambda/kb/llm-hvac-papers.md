# LLM 기반 실내환경 모니터링·HVAC 제어 논문(공개 라이선스 2편 요약, 2편 서지 정보)

| 항목 | 내용 |
|---|---|
| 문서명 | LLM 실내환경·HVAC 운영 관련 논문 4편 |
| 발행 기관 | Elsevier(Energy and Buildings), MDPI(Energies), arXiv |
| 출처 URL | https://doi.org/10.1016/j.enbuild.2025.116276, https://doi.org/10.3390/en18071813, https://arxiv.org/abs/2606.22911, https://arxiv.org/abs/2609.05314 |
| 기준일 | 2026-11-20(arXiv 2606.22911은 v2 2026-11-05 기준) |
| 원문 확인일 | 2026-11-20(초록과 서지 정보 확인, 본문 미확인) |
| 라이선스·근거 | 1·2번은 CC BY 4.0이라 초록 내용을 자체 문장으로 요약. 3·4번은 arXiv 비독점 배포 라이선스라 서지 정보와 링크만 수록 |

## 1. ThermalComfortBot: Agentic RAG-LLM 실내환경 모니터링(Energy and Buildings, 2025)

- 서지: Muhammad Arslan, Saba Munawar, Lamine Mahdjoubi, Patrick Manu. "Monitoring indoor environmental conditions in office buildings using a sustainable Agentic RAG-LLM system". Energy and Buildings 347, 116276(2025-11). DOI 10.1016/j.enbuild.2025.116276. 오픈 액세스, CC BY 4.0.
- 문제: 열쾌적 모니터링에는 여러 데이터 원천의 통합이 필요합니다. 저자들은 BIM과 실시간 센서 데이터 연계가 충분히 활용되지 않고, 기존 시스템은 자연어 질의를 지원하지 않는다고 지적했습니다.
- 방법: 오픈소스 LLM과 Agentic RAG로 구성한 정보 시스템 ThermalComfortBot을 제안했습니다. BIM, 센서 데이터, 외부 데이터를 결합해 텍스트 설명과 그래프로 결과를 제공합니다.
- 결과: 실제 사무 건물 사례에서 정확도 94%, 정밀도 92%, 재현율 89%를 보고했습니다. 비교 기준은 일반 RAG-LLM이며, 저자들은 이 기준보다 높은 성능이라고 보고했습니다.
- 참고: 지표의 평가 문항 수와 정의는 초록에 없습니다. 본문은 확인하지 않았습니다.

## 2. LLM 결합 MPC 온습도 제어(Energies, 2025)

- 서지: Xuanrong Zhu, Hui Li. "Heating, Ventilation, and Air Conditioning (HVAC) Temperature and Humidity Control Optimization Based on Large Language Models (LLMs)". Energies 18(7), 1813(2025-04-03). DOI 10.3390/en18071813. 오픈 액세스, CC BY 4.0.
- 문제: 저자들은 PID와 MPC가 상위 수준 정보 해석, 드문 상황 대응, 제어 결정 최적화에 한계가 있다고 보았습니다.
- 방법: LLM이 운전 상황을 해석해 상위 결정을 내리고, 연쇄 추론(chain-of-thought)과 변환 알고리즘으로 결정을 HVAC 제어 명령으로 바꿉니다. 하위 제어는 MPC가 담당하고, 파라미터 행렬로 LLM 결정을 MPC에 반영합니다.
- 결과(시뮬레이션): 여름 조건 에너지 소비가 ON/OFF 제어 대비 33.3%, 기존 MPC 대비 6.7% 감소했습니다. 기동 구간 에너지는 ON/OFF 대비 약 17.1% 감소했습니다. 온도 평균제곱오차는 MPC 대비 약 35%, ON/OFF 대비 약 45% 감소했습니다.
- 참고: 결과는 시뮬레이션 값이며 실제 건물 적용 결과가 아닙니다.

## 3. ThermoLLM(arXiv, 2026, 서지 정보만)

- 서지: Kirtan Bhatt, Xiachong Lin, Matthew Amos, Flora D. Salim, Wen Hu. "ThermoLLM: LLM-Based Multi-Zone HVAC Control with a Spatiotemporal Context". arXiv:2606.22911, v1 2026-06-22, v2 2026-11-05. 동료 심사 학술지 게재 정보 없음(arXiv 주석: ACM 투고).
- v1 제목: "ThermoLLM: Thermodynamics-Aware HVAC Control with Spatial-Semantic Knowledge Graph".
- 주제 분류: 다중 구역 HVAC 제어, Brick 형식 건물 의미 정보 기반 지식 그래프.
- 라이선스: arXiv 비독점 배포 라이선스. 초록 요약은 KB에 수록하지 않습니다. 내용은 원문 링크에서 확인하십시오.

## 4. LLM의 HVAC 운영 적용 비판적 리뷰(arXiv, 2026, 서지 정보만)

- 서지: Alexander Neubauer, Tianzhen Hong, Han Li, Mengbo Yu, Amin Darbandi, Yannick Fürst, Martin Kriegel. "Large Language Models for HVAC Operations in Building Energy Systems: A Critical Review of Methods, Applications, and Deployment Readiness". arXiv:2609.05314, 2026-09-04. arXiv 주석: Energy and Buildings 투고.
- 주제 분류: 2023~2026년 3월 LLM HVAC 운영 연구의 체계적 리뷰.
- 라이선스: arXiv 비독점 배포 라이선스. 초록 요약은 KB에 수록하지 않습니다. 내용은 원문 링크에서 확인하십시오.
