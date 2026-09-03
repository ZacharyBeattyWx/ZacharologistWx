# AWS MRMS publisher

This is the AWS publisher for the ZacharologistWx national MRMS radar.

## Architecture

NOAA MRMS -> Lambda container -> private S3 archive -> CloudFront

The active publisher uses a **paired transactional frame model**. Every playable
observation has both products before it is added to the public timeline:

- `mrms/`: a lightweight 4096px overview texture for national/regional playback.
- `mrms-detail/`: the same observation at native MRMS grid resolution, split into
  1024px lossless WebP chunks for close zooms.

Each observation is downloaded and decoded **once**. The decoded numeric dBZ grid
feeds both the overview texture and the native chunks. The detail manifest is
published first and the overview/base manifest is published last, so a client
that discovers a new public frame can expect its matching native assets to have
already been published.

The worker prioritizes the newest missing or unpaired observations first, then
uses remaining invocation capacity to grow paired history backward. The public
base timeline is the intersection of available overview and native-detail frames;
this prevents playback from advancing onto a frame that has no matching detail
representation.

The browser keeps the base radar playback scheduler as the **single animation
clock**. Native detail acts as a level-of-detail texture service underneath that
clock rather than owning a competing play/stop loop.

## Deploy from AWS CloudShell

From the repository root:

```bash
git pull origin main
chmod +x aws/mrms-publisher/deploy-cloudshell.sh
./aws/mrms-publisher/deploy-cloudshell.sh
```

The deploy script:

1. Creates/reuses the private ECR repository.
2. Builds the Lambda-compatible container image from the current Git commit.
3. Pushes the image to ECR.
4. Deploys/updates the CloudFormation stack.
5. Preserves the stack's existing EventBridge schedule state unless
   `SCHEDULE_STATE` is explicitly supplied.

The current Docker image uses `handler_v2.py` and
`render_mrms_frame_bundle.py`.

## Manual validation

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

aws s3 cp \
  "s3://${BUCKET_NAME}/mrms/manifest.json" \
  /tmp/mrms-manifest.json >/dev/null

aws s3 cp \
  "s3://${BUCKET_NAME}/mrms-detail/manifest.json" \
  /tmp/mrms-detail-manifest.json >/dev/null

python3 - <<'PY'
import json

with open('/tmp/mrms-manifest.json') as f:
    base = json.load(f)
with open('/tmp/mrms-detail-manifest.json') as f:
    detail = json.load(f)

base_ids = [str(frame['id']) for frame in base.get('frames', [])]
detail_ids = [str(frame['revision']) for frame in detail.get('frames', [])]

print('Base mode:', base.get('mode'))
print('Detail mode:', detail.get('mode'))
print('Base frames:', len(base_ids))
print('Detail frames:', len(detail_ids))
print('1:1 paired:', base_ids == detail_ids)
print('Base newest:', base_ids[-1] if base_ids else None)
print('Detail newest:', detail_ids[-1] if detail_ids else None)
print('Publisher:', base.get('publisher', {}).get('strategy'))
PY
```

Expected values after the new publisher has run:

- Base mode: `paired-overview-native-archive`
- Detail mode: `native-grid-chunk-archive`
- `1:1 paired: True`
- Publisher strategy: `paired-transactional-v2`

## Schedule

The stack normally runs every two minutes. To explicitly enable the schedule:

```bash
SCHEDULE_STATE=ENABLED ./aws/mrms-publisher/deploy-cloudshell.sh
```

The default deploy command without `SCHEDULE_STATE` preserves the current state.

## Native-detail browser behavior

At close zoom, the browser uses native MRMS chunks with:

- one base playback clock at every speed;
- atomic observation-to-observation texture swaps;
- zoom hysteresis to prevent LOD thrashing during pinch zoom;
- viewport overscan so nearby chunks begin loading before they enter view;
- GPU-memory-aware lookahead depth rather than a fixed frame ring;
- continued playback while the user pans or zooms the map.

When leaving detail zoom, the previous complete native frame stays visible until
the overview texture has synchronized to the same timeline observation. This
prevents stale low-resolution radar from flashing during the LOD handoff.
