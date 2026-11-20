#!/usr/bin/env bash
# 냉난방 기호 검출 학습을 AWS CLI로 실행
# 사용: ml/sagemaker.sh setup | data | train [smoke] | ddpg [smoke] | register <학습 작업 이름> | status <작업 이름> | logs <작업 이름>
# 환경 변수: DATASET(합성 데이터 버전, 기본 hvac-yolo), REAL(실제 도면 타일 S3 경로, train에서 real 채널로 추가)
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-maestro} AWS_REGION=${AWS_REGION:-ap-northeast-2}
cd "$(dirname "$0")"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
# 버킷 이름에 sagemaker가 있어야 AmazonSageMakerFullAccess 정책의 S3 권한이 적용됨
BUCKET=sagemaker-maestro-$ACCOUNT
ROLE=maestro-sagemaker
ROLE_ARN=arn:aws:iam::$ACCOUNT:role/$ROLE
ECR=763104351884.dkr.ecr.$AWS_REGION.amazonaws.com/pytorch-training
CPU_IMAGE=$ECR:2.8.0-cpu-py312-ubuntu22.04-sagemaker
GPU_IMAGE=$ECR:2.8.0-gpu-py312-cu129-ubuntu22.04-sagemaker
ECR_INF=763104351884.dkr.ecr.$AWS_REGION.amazonaws.com/pytorch-inference:2.6.0-gpu-py312-cu124-ubuntu22.04-sagemaker
INSTANCE=${INSTANCE:-ml.g6.xlarge}
DATA=s3://$BUCKET/data/${DATASET:-hvac-yolo}
SRC_URL=https://zenodo.org/api/records/2613548/files/cubicasa5k.zip/content
TS=$(date +%Y%m%d-%H%M%S)

case ${1:-} in
setup)
  aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null ||
    aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
  aws iam get-role --role-name $ROLE >/dev/null 2>&1 || {
    aws iam create-role --role-name $ROLE --assume-role-policy-document \
      '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"sagemaker.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/AmazonSageMakerFullAccess
  }
  echo "bucket=$BUCKET role=$ROLE_ARN" ;;
data)
  # CubiCasa5K 내려받기와 기호 합성을 CPU 처리 작업 1회로 실행, 결과는 $DATA
  # 원본 압축 파일(5.5GB)은 첫 실행 때 s3://$BUCKET/data/src/에 보관하고 이후에는 S3에서 읽음
  JOB=hvac-synth-$TS
  aws s3 cp synth.py "s3://$BUCKET/code/$JOB/synth.py" >/dev/null
  ZIP=s3://$BUCKET/data/src/cubicasa5k.zip
  if aws s3 ls "$ZIP" >/dev/null 2>&1; then
    SRC=/opt/ml/processing/input/src/cubicasa5k.zip OUT=''
    IN=", {\"InputName\": \"src\", \"S3Input\": {\"S3Uri\": \"$ZIP\", \"LocalPath\": \"/opt/ml/processing/input/src\", \"S3DataType\": \"S3Prefix\", \"S3InputMode\": \"File\"}}"
  else
    SRC=$SRC_URL IN=''
    OUT=", {\"OutputName\": \"src\", \"S3Output\": {\"S3Uri\": \"s3://$BUCKET/data/src\", \"LocalPath\": \"/opt/ml/processing/src_cache\", \"S3UploadMode\": \"EndOfJob\"}}"
  fi
  aws sagemaker create-processing-job --cli-input-json "$(cat <<EOF
{"ProcessingJobName": "$JOB", "RoleArn": "$ROLE_ARN",
 "AppSpecification": {"ImageUri": "$CPU_IMAGE",
   "ContainerEntrypoint": ["python3", "/opt/ml/processing/input/code/synth.py", "$SRC", "/opt/ml/processing/output"]},
 "ProcessingInputs": [{"InputName": "code", "S3Input": {"S3Uri": "s3://$BUCKET/code/$JOB/", "LocalPath": "/opt/ml/processing/input/code", "S3DataType": "S3Prefix", "S3InputMode": "File"}}$IN],
 "ProcessingOutputConfig": {"Outputs": [{"OutputName": "dataset", "S3Output": {"S3Uri": "$DATA", "LocalPath": "/opt/ml/processing/output", "S3UploadMode": "EndOfJob"}}$OUT]},
 "ProcessingResources": {"ClusterConfig": {"InstanceCount": 1, "InstanceType": "ml.c5.4xlarge", "VolumeSizeInGB": 40}},
 "StoppingCondition": {"MaxRuntimeInSeconds": 7200}}
EOF
)" >/dev/null
  echo "$JOB" ;;
train)
  # smoke: 1 에포크, 학습 데이터 5%로 환경 오류만 확인
  if [ "${2:-}" = smoke ]; then JOB=hvac-yolo-$TS-smoke HP='"epochs": "1", "fraction": "0.05"' MAX=3600
  else JOB=hvac-yolo-$TS HP='"epochs": "60"' MAX=14400; fi
  CH=''
  if [ -n "${REAL:-}" ]; then
    CH=", {\"ChannelName\": \"real\", \"DataSource\": {\"S3DataSource\": {\"S3DataType\": \"S3Prefix\", \"S3Uri\": \"$REAL\", \"S3DataDistributionType\": \"FullyReplicated\"}}}"
    HP="$HP, \"real_repeat\": \"${REAL_REPEAT:-20}\""
  fi
  T=$(mktemp -d)
  tar czf "$T/sourcedir.tar.gz" train.py requirements.txt
  aws s3 cp "$T/sourcedir.tar.gz" "s3://$BUCKET/code/$JOB/sourcedir.tar.gz" >/dev/null
  aws sagemaker create-training-job --cli-input-json "$(cat <<EOF
{"TrainingJobName": "$JOB", "RoleArn": "$ROLE_ARN",
 "AlgorithmSpecification": {"TrainingImage": "$GPU_IMAGE", "TrainingInputMode": "File"},
 "HyperParameters": {"sagemaker_program": "\"train.py\"", "sagemaker_submit_directory": "\"s3://$BUCKET/code/$JOB/sourcedir.tar.gz\"", $HP},
 "InputDataConfig": [{"ChannelName": "train", "DataSource": {"S3DataSource": {"S3DataType": "S3Prefix", "S3Uri": "$DATA/", "S3DataDistributionType": "FullyReplicated"}}}$CH],
 "OutputDataConfig": {"S3OutputPath": "s3://$BUCKET/models/"},
 "ResourceConfig": {"InstanceType": "$INSTANCE", "InstanceCount": 1, "VolumeSizeInGB": 50},
 "StoppingCondition": {"MaxRuntimeInSeconds": $MAX}}
EOF
)" >/dev/null
  echo "$JOB" ;;
ddpg)
  # DDPG HVAC 제어 학습(hvac_control/ddpg.py, CPU 1스레드). EnergyPlus·부산 기상은 작업 안에서 내려받음. smoke: 3,000단계
  # 기본 ml.m5.xlarge(16GiB): EnergyPlus가 실행 1회당 약 1MB를 해제하지 않아 50만 단계(약 5,200회)에 약 5GB 누적, ml.c5.xlarge(8GiB)는 메모리 부족 종료
  if [ "${2:-}" = smoke ]; then JOB=hvac-ddpg-$TS-smoke HP='"steps": "3000", "ckpt": "1500"' MAX=3600
  else JOB=hvac-ddpg-$TS HP='"steps": "500000", "ckpt": "25000"' MAX=14400; fi
  T=$(mktemp -d)
  tar czf "$T/sourcedir.tar.gz" -C hvac_control ddpg.py run.py control.py requirements.txt
  aws s3 cp "$T/sourcedir.tar.gz" "s3://$BUCKET/code/$JOB/sourcedir.tar.gz" >/dev/null
  aws sagemaker create-training-job --cli-input-json "$(cat <<EOF
{"TrainingJobName": "$JOB", "RoleArn": "$ROLE_ARN",
 "AlgorithmSpecification": {"TrainingImage": "$CPU_IMAGE", "TrainingInputMode": "File"},
 "HyperParameters": {"sagemaker_program": "\"ddpg.py\"", "sagemaker_submit_directory": "\"s3://$BUCKET/code/$JOB/sourcedir.tar.gz\"",
   "season": "${SEASON:-cooling}", "lam": "${LAM:-1}", "seed": "${SEED:-0}", $HP},
 "OutputDataConfig": {"S3OutputPath": "s3://$BUCKET/models/"},
 "ResourceConfig": {"InstanceType": "${DDPG_INSTANCE:-ml.m5.xlarge}", "InstanceCount": 1, "VolumeSizeInGB": 30},
 "StoppingCondition": {"MaxRuntimeInSeconds": $MAX}}
EOF
)" >/dev/null
  echo "$JOB" ;;
register)
  # 학습 결과를 모델 패키지 그룹에 승인 대기로 등록. 추론 코드(inference.py)는 Endpoint 배포 작업에서 추가
  GROUP=hvac-symbol-detector
  ART=$(aws sagemaker describe-training-job --training-job-name "$2" --query ModelArtifacts.S3ModelArtifacts --output text)
  M=$(aws s3 cp "$ART" - | tar xzO test_metrics.json | python3 -c 'import json,sys; m=json.load(sys.stdin); print(round(m["mAP50"], 4), round(m["mAP50-95"], 4))')
  aws sagemaker describe-model-package-group --model-package-group-name $GROUP >/dev/null 2>&1 ||
    aws sagemaker create-model-package-group --model-package-group-name $GROUP --model-package-group-description "도면 실내기 기호 검출(YOLO, 5종)" >/dev/null
  aws sagemaker create-model-package --cli-input-json "$(cat <<EOF
{"ModelPackageGroupName": "$GROUP", "ModelPackageDescription": "$2", "ModelApprovalStatus": "PendingManualApproval",
 "InferenceSpecification": {"Containers": [{"Image": "$ECR_INF", "ModelDataUrl": "$ART"}],
   "SupportedContentTypes": ["image/png", "image/jpeg"], "SupportedResponseMIMETypes": ["application/json"]},
 "CustomerMetadataProperties": {"trainingJob": "$2", "testMAP50": "${M% *}", "testMAP50-95": "${M#* }", "dataset": "$DATA"}}
EOF
)" --query ModelPackageArn --output text ;;
status)
  case $2 in
  hvac-synth-*) aws sagemaker describe-processing-job --processing-job-name "$2" --query '{status:ProcessingJobStatus,reason:FailureReason,exit:ExitMessage}' ;;
  *) aws sagemaker describe-training-job --training-job-name "$2" --query '{status:TrainingJobStatus,step:SecondaryStatus,reason:FailureReason,billableSec:BillableTimeInSeconds,model:ModelArtifacts.S3ModelArtifacts}' ;;
  esac ;;
logs)
  G=/aws/sagemaker/TrainingJobs; [[ $2 == hvac-synth-* ]] && G=/aws/sagemaker/ProcessingJobs
  aws logs tail $G --log-stream-name-prefix "$2" --since 1d ${3:-} ;;
*) sed -n 2,4p "$0"; exit 1 ;;
esac
