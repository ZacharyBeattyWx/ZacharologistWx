#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-zwx-mrms-publisher}"
ECR_REPOSITORY="${ECR_REPOSITORY:-zwx-mrms-publisher}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE_URI="${ECR_HOST}/${ECR_REPOSITORY}:${IMAGE_TAG}"

printf 'Region: %s\nStack: %s\nImage: %s\n' "$REGION" "$STACK_NAME" "$IMAGE_URI"

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

docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --load \
  -f aws/mrms-publisher/Dockerfile \
  -t "$ECR_REPOSITORY:$IMAGE_TAG" \
  .

docker tag "$ECR_REPOSITORY:$IMAGE_TAG" "$IMAGE_URI"
docker push "$IMAGE_URI"

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file aws/mrms-publisher/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ImageUri="$IMAGE_URI" \
    ScheduleState=DISABLED

printf '\nDeployment complete. The schedule is intentionally DISABLED.\n\n'
aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table
