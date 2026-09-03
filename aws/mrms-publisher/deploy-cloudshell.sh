#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-zwx-mrms-publisher}"
if aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" >/dev/null 2>&1; then
  CURRENT_SCHEDULE_STATE="$(aws cloudformation describe-stacks \
    --region "$REGION" \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Parameters[?ParameterKey==`ScheduleState`].ParameterValue' \
    --output text)"
else
  CURRENT_SCHEDULE_STATE="DISABLED"
fi
SCHEDULE_STATE="${SCHEDULE_STATE:-${CURRENT_SCHEDULE_STATE:-DISABLED}}"
ECR_REPOSITORY="${ECR_REPOSITORY:-zwx-mrms-publisher}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE_URI="${ECR_HOST}/${ECR_REPOSITORY}:${IMAGE_TAG}"

printf 'Region: %s\nStack: %s\nImage: %s\nSchedule: %s\n' "$REGION" "$STACK_NAME" "$IMAGE_URI" "$SCHEDULE_STATE"

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

# CloudShell has a very small persistent filesystem. Remove every stale Docker
# layer before building and stream the finished image directly to ECR instead of
# loading a second full copy into the local Docker image store.
printf '\nCleaning stale local Docker build data...\n'
docker builder prune --all --force >/dev/null 2>&1 || true
docker system prune --all --force --volumes >/dev/null 2>&1 || true

printf 'Disk available before build:\n'
df -h "$HOME" | tail -1

docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --push \
  -f aws/mrms-publisher/Dockerfile \
  -t "$IMAGE_URI" \
  .

# BuildKit may retain intermediate layers even when the final image was pushed
# directly to ECR. Release them immediately before CloudFormation work.
docker builder prune --all --force >/dev/null 2>&1 || true
docker system prune --all --force --volumes >/dev/null 2>&1 || true

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file aws/mrms-publisher/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ImageUri="$IMAGE_URI" \
    ScheduleState="$SCHEDULE_STATE"

printf '\nDeployment complete. The existing schedule state was preserved unless SCHEDULE_STATE was supplied.\n\n'
aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table
