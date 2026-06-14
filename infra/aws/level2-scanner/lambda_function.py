import json
import os
import re
import time
import urllib.request
import urllib.error

import boto3
from botocore.exceptions import ClientError


ALLOWED_SITES = {
    site.strip().upper()
    for site in os.environ.get("ALLOWED_SITES", "KFCX,KRAX").split(",")
    if site.strip()
}

SOURCE_COUNT = str(os.environ.get("SOURCE_COUNT", "75"))
FRAME_COUNT = str(os.environ.get("FRAME_COUNT", "25"))
DISPATCH_COOLDOWN_SECONDS = int(os.environ.get("DISPATCH_COOLDOWN_SECONDS", "240"))
DISPATCH_LOCK_TABLE = os.environ["DISPATCH_LOCK_TABLE"]

# Keep current production behavior by default.
# Set LEVEL2_DISPATCH_TARGET=github later when direct GitHub dispatch is proven.
LEVEL2_DISPATCH_TARGET = os.environ.get("LEVEL2_DISPATCH_TARGET", "cloudflare").strip().lower()

CLOUDFLARE_LEVEL2_URL = os.environ.get("CLOUDFLARE_LEVEL2_URL", "")
RADAR_DISPATCH_SECRET = os.environ.get("RADAR_DISPATCH_SECRET", "")

GITHUB_REPOSITORY = os.environ.get("GITHUB_REPOSITORY", "ZacharyBeattyWx/ZacharologistWx")
GITHUB_DISPATCH_EVENT_TYPE = os.environ.get("GITHUB_DISPATCH_EVENT_TYPE", "radar_level2_scan")
GITHUB_DISPATCH_TOKEN = os.environ.get("GITHUB_DISPATCH_TOKEN", "")

dynamodb = boto3.client("dynamodb")


def extract_json(value):
    if isinstance(value, dict):
        return value

    if not isinstance(value, str):
        return {}

    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {}


def find_s3_keys(payload):
    keys = []

    records = payload.get("Records")

    if isinstance(records, list):
        for record in records:
            if not isinstance(record, dict):
                continue

            s3 = record.get("s3")
            if isinstance(s3, dict):
                obj = s3.get("object") or {}
                key = obj.get("key")

                if key:
                    keys.append(str(key))

            sns = record.get("Sns")
            if isinstance(sns, dict):
                message_payload = extract_json(sns.get("Message", ""))
                keys.extend(find_s3_keys(message_payload))

    for field in ("key", "Key", "object_key", "objectKey", "name"):
        value = payload.get(field)

        if isinstance(value, str):
            keys.append(value)

    return keys


def site_from_key(key):
    parts = str(key).split("/")
    filename = parts[-1] if parts else ""

    if len(parts) >= 2 and re.fullmatch(r"K[A-Z0-9]{3}", parts[-2].upper()):
        site = parts[-2].upper()
    else:
        site = filename[:4].upper()

    if not re.fullmatch(r"K[A-Z0-9]{3}", site):
        return ""

    if filename and not re.match(rf"^{site}\d{{8}}_\d{{6}}_V\d+", filename):
        return ""

    return site


def claim_dispatch_slot(site):
    now = int(time.time())
    expires_at = now + DISPATCH_COOLDOWN_SECONDS

    try:
        dynamodb.put_item(
            TableName=DISPATCH_LOCK_TABLE,
            Item={
                "site": {"S": site},
                "expiresAt": {"N": str(expires_at)},
                "lastDispatchEpoch": {"N": str(now)},
                "source": {"S": "aws-level2-scanner"},
            },
            ConditionExpression="attribute_not_exists(#site) OR #expiresAt < :now",
            ExpressionAttributeNames={
                "#site": "site",
                "#expiresAt": "expiresAt",
            },
            ExpressionAttributeValues={
                ":now": {"N": str(now)},
            },
        )

        return True

    except ClientError as error:
        code = error.response.get("Error", {}).get("Code")

        if code == "ConditionalCheckFailedException":
            return False

        raise


def release_dispatch_slot(site):
    dynamodb.delete_item(
        TableName=DISPATCH_LOCK_TABLE,
        Key={
            "site": {"S": site},
        },
    )


def dispatch_to_cloudflare(site, source_key, dispatch_reason):
    if not CLOUDFLARE_LEVEL2_URL:
        raise RuntimeError("Missing CLOUDFLARE_LEVEL2_URL.")
    if not RADAR_DISPATCH_SECRET:
        raise RuntimeError("Missing RADAR_DISPATCH_SECRET.")

    body = json.dumps(
        {
            "site": site,
            "source_count": SOURCE_COUNT,
            "frame_count": FRAME_COUNT,
            "source_key": source_key,
            "source": "aws-level2-scanner",
            "dispatch_reason": dispatch_reason,
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        CLOUDFLARE_LEVEL2_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-ZWX-Radar-Secret": RADAR_DISPATCH_SECRET,
            "User-Agent": "zacharologistwx-level2-scanner",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            return response.status, response_body

    except urllib.error.HTTPError as error:
        response_body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Cloudflare dispatch failed: {error.code} {response_body}"
        ) from error


def dispatch_to_github(site, source_key, dispatch_reason):
    if not GITHUB_DISPATCH_TOKEN:
        raise RuntimeError("Missing GITHUB_DISPATCH_TOKEN.")

    url = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/dispatches"

    body = json.dumps(
        {
            "event_type": GITHUB_DISPATCH_EVENT_TYPE,
            "client_payload": {
                "site": site,
                "source_count": SOURCE_COUNT,
                "frame_count": FRAME_COUNT,
                "source_key": source_key,
                "source": "aws-level2-scanner",
                "dispatch_reason": dispatch_reason,
            },
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {GITHUB_DISPATCH_TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "zacharologistwx-level2-scanner",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            return response.status, response_body

    except urllib.error.HTTPError as error:
        response_body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"GitHub repository_dispatch failed: {error.code} {response_body}"
        ) from error


def dispatch_render(site, source_key, dispatch_reason):
    if LEVEL2_DISPATCH_TARGET == "github":
        status, response_body = dispatch_to_github(site, source_key, dispatch_reason)
        return "github", status, response_body

    if LEVEL2_DISPATCH_TARGET == "cloudflare":
        status, response_body = dispatch_to_cloudflare(site, source_key, dispatch_reason)
        return "cloudflare", status, response_body

    raise RuntimeError(
        f"Unsupported LEVEL2_DISPATCH_TARGET={LEVEL2_DISPATCH_TARGET!r}. "
        "Use 'cloudflare' or 'github'."
    )


def lambda_handler(event, context):
    ignored = []
    keys_by_site = {}

    for record in event.get("Records", []):
        body_payload = extract_json(record.get("body", ""))

        if "Message" in body_payload:
            body_payload = extract_json(body_payload["Message"])

        keys = find_s3_keys(body_payload)

        for key in keys:
            site = site_from_key(key)

            if not site:
                ignored.append(
                    {
                        "key": key,
                        "reason": "could not determine Level II site",
                    }
                )
                continue

            if site not in ALLOWED_SITES:
                ignored.append(
                    {
                        "site": site,
                        "key": key,
                        "reason": "site not allowed",
                    }
                )
                continue

            keys_by_site.setdefault(site, set()).add(key)

    dispatched = []
    skipped = []

    for site, keys in sorted(keys_by_site.items()):
        latest_key = sorted(keys)[-1]

        if not claim_dispatch_slot(site):
            skipped.append(
                {
                    "site": site,
                    "reason": "dispatch cooldown active",
                    "keys_in_batch": len(keys),
                    "latest_key": latest_key,
                }
            )
            continue

        try:
            target, status, response_body = dispatch_render(
                site=site,
                source_key=latest_key,
                dispatch_reason="source_event",
            )

            dispatched.append(
                {
                    "site": site,
                    "latest_key": latest_key,
                    "keys_in_batch": len(keys),
                    "source_count": SOURCE_COUNT,
                    "frame_count": FRAME_COUNT,
                    "dispatch_target": target,
                    "dispatch_status": status,
                    "dispatch_response": response_body,
                }
            )

        except Exception:
            release_dispatch_slot(site)
            raise

    result = {
        "ok": True,
        "allowed_sites": sorted(ALLOWED_SITES),
        "dispatch_target": LEVEL2_DISPATCH_TARGET,
        "site_count": len(keys_by_site),
        "dispatched_count": len(dispatched),
        "skipped_count": len(skipped),
        "ignored_count": len(ignored),
        "dispatched": dispatched[:10],
        "skipped": skipped[:10],
        "ignored": ignored[:10],
    }

    print(json.dumps(result))
    return result