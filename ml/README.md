# ml

도면의 냉난방 실내기 기호 검출 모델(YOLO) 학습 폴더입니다. 방법 선택 근거와 학습 결과는 [도면 실내기 기호 검출 모델 기술 선택 기록](../docs/human/explanation/decisions/2026-11-20%28%EB%8F%84%EB%A9%B4%20%EC%8B%A4%EB%82%B4%EA%B8%B0%20%EA%B8%B0%ED%98%B8%20%EA%B2%80%EC%B6%9C%20%EB%AA%A8%EB%8D%B8%29.md)에 있습니다.

| 경로 | 내용 |
|---|---|
| `synth.py` | CubiCasa5K 평면도의 방 다각형 안에 실내기 기호 6종을 합성하고 YOLO 라벨 생성. 기호 크기는 도면별 벽 두께 중앙값 기준. 도면 절반은 국내 CAD 기호와 주변 표시로 그림 |
| `train.py` | SageMaker 학습 진입점. ultralytics YOLO11s 미세조정(이미지 1024px). 실제 도면 타일(`real` 채널)을 반복해 섞고, 합성·실제 테스트 결과를 `test_metrics.json`에 저장 |
| `requirements.txt` | 학습 컨테이너 추가 패키지(ultralytics 8.4.200) |
| `sagemaker.sh` | AWS CLI 실행: 역할·버킷 생성, 데이터 생성 처리 작업, 학습 작업, Registry 등록, 상태·로그 조회 |
| `hvac_types.json` | 검출 클래스별 LG 실내기 예시 모델과 매뉴얼 링크(FR-19 표 조회). 확인하지 못한 값은 `null` |
| `test_synth.py` | 합성 단위 테스트 5건 |
| `real_labels/` | 실제 설계도면 실내기 라벨(페이지 좌표, 출처 공고번호). 도면 파일은 저장소에 넣지 않음 |
| `real_tiles.py` | 실제 도면 라벨과 PDF로 YOLO 타일 생성(1m당 80px, 1400px 타일) |
| `serve/` | Serverless Inference 진입점(`inference.py`, ONNX와 onnxruntime CPU), 후처리 테스트 2건. 요청·응답 규약은 [도면 변환 규약](../docs/human/reference/plan-ingest.md) 5절 |
| `ifc_eval.py` | IFC 평가 세트: 의원 건물 급기구 좌표를 천장형 기호 3종으로 치환한 평면도 타일(1m당 80px, 1400px)과 라벨. 학습에는 미사용 |
| `hvac_control/` | 규칙 기반·JEV 기반·DDPG HVAC 설정온도 제어 비교(EnergyPlus). DDPG SageMaker 학습은 `sagemaker.sh ddpg`. 실행은 [hvac_control/README.md](hvac_control/README.md) |

## 검출 클래스

모델은 실내기 유형만 검출합니다. 같은 유형의 모델번호는 기호 모양으로 구분할 수 없으므로 `hvac_types.json` 표로 연결합니다.

| 번호 | 클래스 | 유형 | 합성 기호 | 배치 |
|---|---|---|---|---|
| 0 | `cassette_4way` | 천장형 4방향 카세트 | 정사각형, 안쪽 정사각형, 모서리 연결선 | 방 내부 |
| 1 | `cassette_1way` | 천장형 1방향 카세트 | 직사각형, 한쪽 긴 변 토출구 2줄 | 방 내부 |
| 2 | `wall_mounted` | 벽걸이형 | 얇은 직사각형, 루버 선, 방 안쪽 화살표 | 벽에 붙임 |
| 3 | `ceiling_duct` | 천장 매립 덕트형 | 점선 직사각형, X 표시 토출구 | 방 내부 |
| 4 | `floor_standing` | 스탠드형 | 직사각형, 원, 앞면 선 | 벽에 붙임 |
| 5 | `cassette_2way` | 천장형 2방향 카세트 | 직사각형, 양쪽 긴 변 토출구 | 방 내부 |

주: 방마다 75% 확률로 기호 1개(큰 방 2개), 도면의 10%는 기호 없음. 위 표는 단순 선 기호입니다. 기호의 50%에 태그 문자(`IDU-3` 등)를 붙이고 라벨에는 포함하지 않습니다.

도면의 50%는 국내 CAD 실시설계 도면 형태로 그립니다. 4방향은 굵은 이중 테두리와 중앙 채움 사각형, 2방향은 I자 막대, 스탠드형은 부채꼴 토출 화살표 3개입니다. 기호 주변에는 라벨 없는 연결 박스(⊠), 냉매·드레인 배관, 관경 박스(`32`, `H`), 용량 팔각 태그(`14.5KW`, `E-5.0HP`)를 함께 그립니다. 단순 선 기호만으로 학습한 v1 모델의 실제 도면 mAP50은 0.006이었습니다(2026-11-20, 춘천초 도면).

## 실행

AWS 자격 증명은 `aws configure --profile maestro`로 입력하십시오. 리전은 ap-northeast-2입니다.

```bash
python3 -m unittest ml/test_synth.py        # Pillow 필요
ml/sagemaker.sh setup                       # 1회: S3 버킷 sagemaker-maestro-<계정>, IAM 역할 maestro-sagemaker
ml/sagemaker.sh data                        # CubiCasa5K 합성(ml.c5.4xlarge), 출력 s3://<버킷>/data/<DATASET>. 원본은 첫 실행 때 data/src/에 보관
ml/sagemaker.sh train smoke                 # 환경 점검: 1 에포크, 학습 데이터 5%
ml/sagemaker.sh train                       # 본 학습: 최대 60 에포크, 최대 4시간
ml/sagemaker.sh register <학습 작업 이름>     # Model Registry 그룹 hvac-symbol-detector에 승인 대기로 등록
ml/sagemaker.sh deploy <best.onnx> <버전>     # Serverless Endpoint hvac-symbol-detector-sls 생성 또는 갱신(메모리 6,144MB, 동시 실행 2)
ml/sagemaker.sh status <작업 이름>
ml/sagemaker.sh logs <작업 이름> --follow
```

- 학습 인스턴스는 `INSTANCE` 환경 변수로 바꾸십시오. 기본값은 `ml.g6.xlarge`(L4 24GB, 서울 리전 시간당 $1.385, 2026-11-20 조회)입니다. 이 인스턴스에서는 GPU 사용률 83~98%, vCPU 4개 사용률 약 93%로 모두 포화되었습니다. `INSTANCE=ml.g6e.4xlarge`(L40S, vCPU 16개, 시간당 $4.62)에서는 학습 속도가 3 it/s에서 8.8 it/s로 올랐습니다.
- 합성 데이터 버전은 `DATASET` 환경 변수로 구분하십시오. 기본값은 `hvac-yolo`(v1, 단순 선 기호 5종)이고, 국내 CAD 기호 6종은 `DATASET=hvac-yolo-v2`입니다. `data`와 `train`에 같은 값을 주십시오.
- 실제 도면 타일을 섞으려면 `REAL=s3://<버킷>/data/hvac-real/`을 지정하십시오. 학습 타일은 `REAL_REPEAT`(기본 20)회 반복해 넣고, `images/test` 타일은 별도로 채점해 `test_metrics.json`의 `real`에 저장합니다.
- 결과는 `s3://<버킷>/models/<작업 이름>/output/model.tar.gz`입니다. 압축 안의 `hvac/weights/best.pt`가 가중치이고, `test_metrics.json`이 테스트 지표입니다.
- 합성 결과를 로컬에서 확인하려면 `python3 ml/synth.py <cubicasa5k 폴더> <출력 폴더> --limit 5`를 실행하십시오.
- Registry 등록 모델은 학습 산출물(`best.pt`)이며, 배포는 `deploy`로 ONNX를 `serve/inference.py`와 묶어 Serverless Endpoint에 올립니다. `train.py`는 학습 끝에 `hvac/weights/best.onnx`를 저장합니다. 이전 산출물은 `yolo export model=best.pt format=onnx imgsz=1024`로 만드십시오.
- Serverless Endpoint는 호출이 없으면 요금이 없습니다. 실시간 Endpoint로 바꾸면 루트 `AGENTS.md`의 "SageMaker Endpoint 비용 관리"를 따르십시오.
- 추론 전처리는 학습과 같은 OpenCV INTER_LINEAR 축소입니다. PIL bilinear로 바꾸면 얇은 선 도면에서 신뢰도가 0.76에서 0.54로 달라졌습니다(2026-11-20). 응답 시간은 첫 호출 2.3초, 이후 타일당 1.0초입니다(1400px 타일, 2026-11-20).

IFC 평가 세트는 다음 순서로 만들고 채점하십시오. IFC 원본은 buildingsmart-community 저장소의 `Clinic_Architectural.ifc`, `Clinic_HVAC.ifc`(Git LFS)입니다.

```bash
python3 docs/reports/tools/ifc_extract.py Clinic_Architectural.ifc Clinic_HVAC.ifc clinic_extract.json   # ifcopenshell, shapely 필요
python3 ml/ifc_eval.py clinic_extract.json ifc_eval
yolo val model=best.pt data=ifc_eval/data.yaml split=test imgsz=1024
```

실제 도면은 나라장터 냉난방기 관급자재 공고의 첨부 설계도면을 사용합니다. 다음 순서로 타일을 만드십시오.

1. 공공데이터포털에서 "조달청_나라장터 입찰공고정보서비스" 활용 신청 후 인증키를 `~/.config/maestro/datagokr.key`에 저장하십시오. 키는 커밋하거나 대화에 붙여 넣지 마십시오.
2. 공고의 첨부파일은 `https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do?bidPbancNo=<공고번호>&bidPbancOrd=000&fileType=&fileSeq=<순번>&prcmBsneSeCd=<업무구분>`으로 내려받습니다. 업무구분은 물품 `01`, 공사 `07`입니다. 도면 PDF는 저장소에 넣지 말고 S3 `data/hvac-real-src/`에 보관하십시오.
3. 라벨은 `real_labels/<건물>.json`에 페이지 좌표(`dpi` 기준)와 출처 공고번호로 기록하십시오. 같은 실내기 배치를 다시 그린 쪽(제어선 평면도 등)은 `dup: true`로 표시합니다.
4. 타일을 만들고 S3에 올리십시오. 평가용 건물은 `--split test`로 만듭니다.

```bash
python3 ml/real_tiles.py real_tiles ml/real_labels/chuncheon_elem.json=<도면.pdf>   # poppler(pdftoppm) 필요
aws s3 sync real_tiles s3://<버킷>/data/hvac-real/ --profile maestro
```

## 라이선스

- CubiCasa5K는 CC BY-NC-SA 4.0입니다(Zenodo 기록 2613548). 합성 데이터셋과 이를 학습한 가중치는 비상업 용도로만 사용하고, 배포 시 같은 라이선스를 적용하십시오.
- ultralytics는 AGPL-3.0입니다. 서비스에 포함해 배포하기 전에 라이선스를 검토하십시오.
