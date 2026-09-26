#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-zwx-satellite-truecolor}"
SOURCE_STACK_NAME="${SOURCE_STACK_NAME:-zwx-mrms-publisher}"
ECR_REPOSITORY="${ECR_REPOSITORY:-zwx-satellite-truecolor}"
SCHEDULE_STATE="${SCHEDULE_STATE:-ENABLED}"

if [[ -z "${TARGET_BUCKET:-}" ]]; then
  TARGET_BUCKET="$(aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$SOURCE_STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`RadarBucketName`].OutputValue' \
    --output text)"
fi

if [[ -z "$TARGET_BUCKET" || "$TARGET_BUCKET" == "None" ]]; then
  echo "Could not resolve RadarBucketName from stack $SOURCE_STACK_NAME" >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
IMAGE_URI="${ECR_HOST}/${ECR_REPOSITORY}:${IMAGE_TAG}"

printf 'Region: %s\nStack: %s\nTarget bucket: %s\nImage: %s\nSchedule: %s\n' \
  "$REGION" "$STACK_NAME" "$TARGET_BUCKET" "$IMAGE_URI" "$SCHEDULE_STATE"

if ! aws ecr describe-repositories \
  --region "$REGION" \
  --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1; then
  aws ecr create-repository \
    --region "$REGION" \
    --repository-name "$ECR_REPOSITORY" \
    --image-scanning-configuration scanOnPush=true >/dev/null
fi

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_HOST"

# CloudShell has a small Docker filesystem. Clean Docker build data only; this
# script never runs git clean/reset and does not alter unrelated working files.
docker builder prune --all --force >/dev/null 2>&1 || true
docker system prune --all --force --volumes >/dev/null 2>&1 || true

printf 'Disk available before build:\n'
df -h "$HOME" | tail -1

docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --push \
  -f aws/satellite-truecolor-publisher/Dockerfile \
  -t "$IMAGE_URI" \
  .

docker builder prune --all --force >/dev/null 2>&1 || true
docker system prune --all --force --volumes >/dev/null 2>&1 || true

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file aws/satellite-truecolor-publisher/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ImageUri="$IMAGE_URI" \
    TargetBucketName="$TARGET_BUCKET" \
    ScheduleState="$SCHEDULE_STATE"

FUNCTION_NAME="$(aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`SatelliteTrueColorFunctionName`].OutputValue' \
  --output text)"

printf '\nInvoking one seed run: %s\n' "$FUNCTION_NAME"
aws lambda invoke \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  /tmp/zwx-satellite-truecolor-seed.json >/dev/null
cat /tmp/zwx-satellite-truecolor-seed.json
printf '\n\n'

for PLATFORM in east west; do
  MANIFEST="s3://${TARGET_BUCKET}/satellite-truecolor/${PLATFORM}/manifest.json"
  printf '%s manifest:\n' "$PLATFORM"
  if aws s3 cp --region "$REGION" "$MANIFEST" - >/tmp/zwx-satellite-manifest.json 2>/dev/null; then
    python3 - <<'PY'
import json
with open('/tmp/zwx-satellite-manifest.json') as f:
    m=json.load(f)
print('  satellite:', m.get('satellite'))
print('  product:', m.get('product'))
print('  cadenceMinutes:', m.get('cadenceMinutes'))
print('  frameCount:', m.get('frameCount'))
frames=m.get('frames') or []
if frames:
    print('  oldest:', frames[0].get('time'))
    print('  newest:', frames[-1].get('time'))
    print('  newestPath:', frames[-1].get('path'))
PY
  else
    echo '  manifest not published yet'
  fi
done

printf '\nSatellite stack deployment complete. Existing MRMS/GLM stack was not modified.\n'
