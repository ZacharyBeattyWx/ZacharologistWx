# AWS MRMS publisher

This is the parallel AWS publisher for the ZacharologistWx national MRMS radar.
It is intentionally isolated from the current production feed until it is proven.

## Architecture

NOAA MRMS -> Lambda container -> private S3 archive

The worker prioritizes the newest missing observations first. Remaining invocation
capacity is used to backfill older gaps, preventing a large backlog from blocking
live radar recovery.

## First deploy from AWS CloudShell

From the repository root:

```bash
chmod +x aws/mrms-publisher/deploy-cloudshell.sh
./aws/mrms-publisher/deploy-cloudshell.sh
```

The deploy script:

1. Creates/reuses a private ECR repository.
2. Builds the Lambda-compatible container image.
3. Pushes the image to ECR.
4. Deploys a private S3 bucket, Lambda function, IAM role, and EventBridge rule.
5. Leaves the EventBridge rule **DISABLED** for the first test.

## Manual first invocation

```bash
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-zwx-mrms-publisher}"

FUNCTION_NAME="$(aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`PublisherFunctionName`].OutputValue' \
  --output text)"

BUCKET_NAME="$(aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`RadarBucketName`].OutputValue' \
  --output text)"

aws lambda invoke \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  /tmp/mrms-response.json

cat /tmp/mrms-response.json
aws s3 cp "s3://${BUCKET_NAME}/mrms/manifest.json" - | head -60
```

The first invocation creates only a small, current loop. Subsequent invocations
fill older history while continuing to keep the newest observation first.

## Enable the two-minute schedule after validation

```bash
aws cloudformation deploy \
  --region "${AWS_REGION:-us-east-1}" \
  --stack-name "${STACK_NAME:-zwx-mrms-publisher}" \
  --template-file aws/mrms-publisher/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ImageUri="$(aws lambda get-function \
      --region "${AWS_REGION:-us-east-1}" \
      --function-name "$(aws cloudformation describe-stacks \
        --region "${AWS_REGION:-us-east-1}" \
        --stack-name "${STACK_NAME:-zwx-mrms-publisher}" \
        --query 'Stacks[0].Outputs[?OutputKey==`PublisherFunctionName`].OutputValue' \
        --output text)" \
      --query 'Code.Location' \
      --output text)" \
    ScheduleState=ENABLED
```

Do not use the enable command above until the first manual invocation has been
validated. The production website should not be pointed at this S3 archive until
the AWS publisher has remained current under repeated tests.
