# AWS MRMS publisher

This is the parallel AWS publisher for the ZacharologistWx national MRMS radar.
It is intentionally isolated from the current production feed until it is proven.

## Architecture

NOAA MRMS -> Lambda container -> private S3 archive -> CloudFront\n\nThe worker publishes two coordinated products:\n\n- `mrms/`: the lightweight 4096px rolling loop used for playback.\n- `mrms-detail/`: the newest native-resolution scan split into a small fixed grid of lossless WebP chunks. Browsers fetch only chunks intersecting the zoomed viewport.

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
5. Preserves the current EventBridge schedule state on an existing stack. A brand-new stack remains **DISABLED** for its first test.

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
aws s3 cp "s3://${BUCKET_NAME}/mrms/manifest.json" - | head -60\naws s3 cp "s3://${BUCKET_NAME}/mrms-detail/manifest.json" - | head -80
```

The first invocation creates only a small, current loop. Subsequent invocations
fill older history while continuing to keep the newest observation first.

## Enable the two-minute schedule after validation

```bash
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-zwx-mrms-publisher}"
FUNCTION_NAME="$(aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`PublisherFunctionName`].OutputValue' \
  --output text)"
IMAGE_URI="$(aws lambda get-function \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --query 'Code.ImageUri' \
  --output text)"

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file aws/mrms-publisher/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ImageUri="$IMAGE_URI" \
    ScheduleState=ENABLED
```

Do not use the enable command above until the first manual invocation has been
validated. The production website should not be pointed at this S3 archive until
the AWS publisher has remained current under repeated tests.


## Native-detail behavior

The detail feed is intentionally latest-frame only. It keeps storage and S3 request
costs low while restoring native MRMS resolution for close zooms. Historical
playback continues to use the lightweight rolling frames. The browser retains the
rolling frame until every visible native chunk is ready, so a detail publishing
failure falls back cleanly without blanking the radar.
