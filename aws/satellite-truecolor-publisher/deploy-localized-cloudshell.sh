#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${LOCALIZED_STACK_NAME:-zwx-satellite-localized}"
SOURCE_STACK_NAME="${SOURCE_STACK_NAME:-zwx-satellite-truecolor}"
ECR_REPOSITORY="${ECR_REPOSITORY:-zwx-satellite-truecolor}"
SCHEDULE_STATE="${SCHEDULE_STATE:-ENABLED}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [[ -z "${TARGET_BUCKET:-}" ]]; then
  MANIFEST_URI="$(aws cloudformation describe-stacks --region "$REGION" \
    --stack-name "$SOURCE_STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`SatelliteTrueColorEastManifestS3Uri`].OutputValue' \
    --output text)"
  TARGET_BUCKET="${MANIFEST_URI#s3://}"
  TARGET_BUCKET="${TARGET_BUCKET%%/*}"
fi
if [[ -z "$TARGET_BUCKET" || "$TARGET_BUCKET" == "None" ]]; then
  echo 'Set TARGET_BUCKET to the existing satellite S3 bucket.' >&2
  exit 1
fi

if [[ -z "${IMAGE_URI:-}" ]]; then
  docker info >/dev/null
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  ECR_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
  IMAGE_URI="${ECR_HOST}/${ECR_REPOSITORY}:localized-$(git rev-parse --short HEAD)"
  aws ecr describe-repositories --region "$REGION" --repository-names "$ECR_REPOSITORY" >/dev/null
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$ECR_HOST"
  docker buildx build --platform linux/amd64 --provenance=false --push \
    -f aws/satellite-truecolor-publisher/Dockerfile -t "$IMAGE_URI" .
fi

aws cloudformation validate-template --region "$REGION" \
  --template-body file://aws/satellite-truecolor-publisher/template-localized.yaml >/dev/null
aws cloudformation deploy --region "$REGION" --stack-name "$STACK_NAME" \
  --template-file aws/satellite-truecolor-publisher/template-localized.yaml \
  --capabilities CAPABILITY_IAM --parameter-overrides \
  ImageUri="$IMAGE_URI" TargetBucketName="$TARGET_BUCKET" ScheduleState="$SCHEDULE_STATE"

echo "Localized stack deployed: $STACK_NAME (schedule $SCHEDULE_STATE)."
echo 'Wait for a five-minute publish cycle, then verify the dedicated public manifests:'
echo 'python3 aws/satellite-truecolor-publisher/verify-localized-live.py'
echo 'Do not mark Localized live until that verification succeeds.'
