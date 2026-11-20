#!/usr/bin/env bash
# 규정·쾌적성 문서(lambda/kb)를 KB 원본 버킷에 동기화하고 수집 작업 실행 후 완료 대기
# 사용: tools/kb_sync.sh (lambda 폴더, sam deploy 이후). 스택 출력 KbDocsBucketName, KbId, KbDataSourceId 사용
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-maestro} AWS_REGION=${AWS_REGION:-ap-northeast-2}
cd "$(dirname "$0")/.."
STACK=${STACK:-maestro}
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out KbDocsBucketName) KB=$(out KbId) DS=$(out KbDataSourceId)
aws s3 sync kb/ "s3://$BUCKET/" --delete --exclude '*' --include '*.md' --include '*.md.metadata.json'
JOB=$(aws bedrock-agent start-ingestion-job --knowledge-base-id "$KB" --data-source-id "$DS" --query ingestionJob.ingestionJobId --output text)
while :; do
  read -r STATUS STATS < <(aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB" --data-source-id "$DS" --ingestion-job-id "$JOB" \
    --query '[ingestionJob.status, join(`,`, [to_string(ingestionJob.statistics.numberOfNewDocumentsIndexed), to_string(ingestionJob.statistics.numberOfModifiedDocumentsIndexed), to_string(ingestionJob.statistics.numberOfDocumentsFailed)])]' --output text)
  case $STATUS in
  COMPLETE) echo "수집 완료(신규, 변경, 실패): $STATS"; break ;;
  FAILED | STOPPED) echo "수집 $STATUS: $STATS" >&2; exit 1 ;;
  esac
  sleep 5
done
