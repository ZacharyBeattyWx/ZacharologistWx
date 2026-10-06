#!/usr/bin/env bash
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
STACK="zwx-satellite-mesoscale"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${TARGET_BUCKET:-$(aws cloudformation describe-stacks --region "$REGION" --stack-name zwx-mrms-publisher --query 'Stacks[0].Outputs[?OutputKey==`RadarBucketName`].OutputValue' --output text)}"
[[ -n "$BUCKET" && "$BUCKET" != None ]] || { echo 'Target bucket not found'; exit 1; }
REPO="zwx-satellite-mesoscale"
HOST="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
IMAGE="$HOST/$REPO:$(git rev-parse --short HEAD)"
aws ecr describe-repositories --region "$REGION" --repository-names "$REPO" >/dev/null 2>&1 || aws ecr create-repository --region "$REGION" --repository-name "$REPO" >/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$HOST"
docker buildx build --platform linux/amd64 --provenance=false --push -f aws/satellite-truecolor-publisher/Dockerfile.mesoscale -t "$IMAGE" .
aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file aws/satellite-truecolor-publisher/template-mesoscale.yaml --capabilities CAPABILITY_IAM --parameter-overrides ImageUri="$IMAGE" TargetBucketName="$BUCKET" ScheduleState=DISABLED Platforms="${MESOSCALE_PLATFORMS:-East}"
FUNCTION="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].Outputs[?OutputKey==`FunctionName`].OutputValue' --output text)"
aws lambda invoke --region "$REGION" --cli-read-timeout 0 --function-name "$FUNCTION" /tmp/zwx-mesoscale-seed.json >/dev/null
python3 - <<'PY'
import json
with open('/tmp/zwx-mesoscale-seed.json') as f:
    result = json.load(f)
print(json.dumps(result))
if result.get('statusCode') != 200 or not result.get('results') or any(not row.get('frames') or any(n < 1 for n in row['frames'].values()) for row in result['results']):
    raise SystemExit('Seed failed or empty: schedule left disabled. Share this output before retrying.')
PY
RULE="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].Outputs[?OutputKey==`ScheduleName`].OutputValue' --output text)"
aws events enable-rule --region "$REGION" --name "$RULE"
echo 'Mesoscale seed verified. Two-minute schedule enabled; one-minute scan history builds over time.'
echo 'Existing satellite, radar and Lightning stacks were not changed.'
