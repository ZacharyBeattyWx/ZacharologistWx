import json
import os
import re
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

import boto3
from botocore import UNSIGNED
from botocore.config import Config
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

LEVEL2_DISPATCH_TARGET = os.environ.get("LEVEL2_DISPATCH_TARGET", "cloudflare").strip().lower()

CLOUDFLARE_LEVEL2_URL = os.environ.get("CLOUDFLARE_LEVEL2_URL", "")
RADAR_DISPATCH_SECRET = os.environ.get("RADAR_DISPATCH_SECRET", "")

GITHUB_REPOSITORY = os.environ.get("GITHUB_REPOSITORY", "ZacharyBeattyWx/ZacharologistWx")
GITHUB_DISPATCH_EVENT_TYPE = os.environ.get("GITHUB_DISPATCH_EVENT_TYPE", "radar_level2_scan")
GITHUB_DISPATCH_TOKEN = os.environ.get("GITHUB_DISPATCH_TOKEN", "")

WATCHDOG_MANIFEST_BASE_URL = os.environ.get(
    "WATCHDOG_MANIFEST_BASE_URL",
    "https://radar.zacharologistwx.com",
).rstrip("/")
WATCHDOG_STALE_SECONDS = int(os.environ.get("WATCHDOG_STALE_SECONDS", "300"))
WATCHDOG_MAX_DISPATCHES = int(os.environ.get("WATCHDOG_MAX_DISPATCHES", str(len(ALLOWED_SITES))))
WATCHDOG_SOURCE_BUCKET = os.environ.get("WATCHDOG_SOURCE_BUCKET", "noaa-nexrad-level2")
WATCHDOG_SOURCE_LOOKBACK_DAYS = int(os.environ.get("WATCHDOG_SOURCE_LOOKBACK_DAYS", "2"))
WATCHDOG_SOURCE_LIST_MAX_KEYS = int(os.environ.get("WATCHDOG_SOURCE_LIST_MAX_KEYS", "1000"))
SOURCE_STATE_TTL_SECONDS = int(os.environ.get("SOURCE_STATE_TTL_SECONDS", "172800"))

dynamodb = boto3.client("dynamodb")
source_s3 = boto3.client("s3", config=Config(signature_version=UNSIGNED))


def extract_json(value):
    if isinstance(value, dict):
        return value

    if not isinstance(value, str):
        return {}

    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {}


def as_bool(value):
    if isinstance(value, bool):
        return value

    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


WATCHDOG_REQUIRE_NEWER_SOURCE = str(os.environ.get("WATCHDOG_REQUIRE_NEWER_SOURCE", "true")).strip().lower() in {"1", "true", "yes", "y", "on"}


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


def parse_iso_datetime(value):
    if not value:
        return None

    text = str(value).strip()

    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"

    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed.astimezone(timezone.utc)


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


def dispatch_to_github(site, source_key, dispatch_reason, sites=None, dispatch_group=None):
    if not GITHUB_DISPATCH_TOKEN:
        raise RuntimeError("Missing GITHUB_DISPATCH_TOKEN.")

    url = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/dispatches"

    normalized_sites = []
    if sites:
        for value in sites:
            normalized = str(value).strip().upper()
            if normalized and normalized not in normalized_sites:
                normalized_sites.append(normalized)

    if not normalized_sites:
        normalized_sites = [str(site).strip().upper()]

    client_payload = {
        "site": normalized_sites[0],
        "sites": normalized_sites,
        "source_count": SOURCE_COUNT,
        "frame_count": FRAME_COUNT,
        "source_key": source_key,
        "source": "aws-level2-scanner",
        "dispatch_reason": dispatch_reason,
    }

    if dispatch_group:
        client_payload["dispatch_group"] = dispatch_group

    body = json.dumps(
        {
            "event_type": GITHUB_DISPATCH_EVENT_TYPE,
            "client_payload": client_payload,
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


def dispatch_render(site, source_key, dispatch_reason, dispatch_target=None, sites=None, dispatch_group=None):
    target = (dispatch_target or LEVEL2_DISPATCH_TARGET).strip().lower()

    if target == "github":
        status, response_body = dispatch_to_github(
            site,
            source_key,
            dispatch_reason,
            sites=sites,
            dispatch_group=dispatch_group,
        )
        return "github", status, response_body

    if target == "cloudflare":
        status, response_body = dispatch_to_cloudflare(site, source_key, dispatch_reason)
        return "cloudflare", status, response_body

    raise RuntimeError(
        f"Unsupported dispatch target={target!r}. "
        "Use 'cloudflare' or 'github'."
    )


def should_run_watchdog(event):
    if as_bool(event.get("watchdog", False)):
        return True

    if str(event.get("mode", "")).strip().lower() == "watchdog":
        return True

    if event.get("source") in {"aws.events", "aws.scheduler"}:
        return True

    if event.get("detail-type") in {"Scheduled Event", "EventBridge Scheduled Event"}:
        return True

    return False


def fetch_level2_manifest(site):
    cache_buster = int(time.time())
    url = (
        f"{WATCHDOG_MANIFEST_BASE_URL}/radar/tilesets/test/"
        f"{site}/LEVEL2/REF0/frames.json?watchdog={cache_buster}"
    )

    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "User-Agent": "zacharologistwx-level2-watchdog",
        },
    )

    with urllib.request.urlopen(request, timeout=20) as response:
        body = response.read().decode("utf-8", errors="replace")
        return json.loads(body)


def summarize_manifest(site, manifest, now_utc):
    frames = manifest.get("frames")
    if not isinstance(frames, list):
        frames = []

    latest = frames[-1] if frames else {}
    updated_at_raw = manifest.get("updatedAt")
    updated_at = parse_iso_datetime(updated_at_raw)

    age_seconds = None
    if updated_at:
        age_seconds = int((now_utc - updated_at).total_seconds())

    return {
        "site": site,
        "frames": len(frames),
        "updated_at": updated_at_raw,
        "latest_scan": latest.get("validTime"),
        "age_seconds": age_seconds,
    }


def watchdog_source_key(summary):
    latest_scan = summary.get("latest_scan") or summary.get("updated_at") or int(time.time())
    return f"watchdog://{summary['site']}/{latest_scan}"


def source_scan_time_from_key(key):
    filename = str(key).split("/")[-1]

    if "_MDM" in filename:
        return None

    match = re.match(r"^(K[A-Z0-9]{3})(\d{8})_(\d{6})_V\d+", filename)
    if not match:
        return None

    site, yyyymmdd, hhmmss = match.groups()

    try:
        return datetime.strptime(f"{yyyymmdd}{hhmmss}", "%Y%m%d%H%M%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def list_source_keys_for_prefix(prefix):
    keys = []
    continuation_token = None

    while True:
        request = {
            "Bucket": WATCHDOG_SOURCE_BUCKET,
            "Prefix": prefix,
            "MaxKeys": WATCHDOG_SOURCE_LIST_MAX_KEYS,
        }

        if continuation_token:
            request["ContinuationToken"] = continuation_token

        response = source_s3.list_objects_v2(**request)

        for item in response.get("Contents", []):
            key = item.get("Key")
            if key:
                keys.append(key)

        if not response.get("IsTruncated"):
            break

        continuation_token = response.get("NextContinuationToken")
        if not continuation_token:
            break

    return keys


def source_state_key(site):
    return f"source#{site}"


def source_summary_from_key(key):
    scan_time = source_scan_time_from_key(key)

    if not scan_time:
        return None

    return {
        "key": key,
        "scan_time": scan_time,
        "scan_time_iso": scan_time.isoformat().replace("+00:00", "Z"),
    }


def latest_renderable_source_key(keys):
    valid_keys = []

    for key in keys:
        if source_scan_time_from_key(key):
            valid_keys.append(key)

    if valid_keys:
        return sorted(valid_keys)[-1]

    return sorted(keys)[-1]


def remember_latest_source_key(site, key):
    source_summary = source_summary_from_key(key)

    if not source_summary:
        return {
            "ok": False,
            "site": site,
            "latest_key": key,
            "reason": "source key is not a renderable Level II volume",
        }

    scan_epoch = int(source_summary["scan_time"].timestamp())
    expires_at = int(time.time()) + SOURCE_STATE_TTL_SECONDS

    try:
        dynamodb.put_item(
            TableName=DISPATCH_LOCK_TABLE,
            Item={
                "site": {"S": source_state_key(site)},
                "radar_site": {"S": site},
                "latest_key": {"S": key},
                "scan_epoch": {"N": str(scan_epoch)},
                "scan_time": {"S": source_summary["scan_time_iso"]},
                "expires_at": {"N": str(expires_at)},
            },
            ConditionExpression="attribute_not_exists(#site) OR scan_epoch < :scan_epoch",
            ExpressionAttributeNames={
                "#site": "site",
            },
            ExpressionAttributeValues={
                ":scan_epoch": {"N": str(scan_epoch)},
            },
        )

        return {
            "ok": True,
            "site": site,
            "latest_key": key,
            "scan_time": source_summary["scan_time_iso"],
            "source": "sqs_event",
        }
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return {
                "ok": True,
                "site": site,
                "latest_key": key,
                "scan_time": source_summary["scan_time_iso"],
                "source": "sqs_event",
                "ignored": "older than cached source",
            }

        return {
            "ok": False,
            "site": site,
            "latest_key": key,
            "scan_time": source_summary["scan_time_iso"],
            "error": str(error),
        }


def latest_remembered_source_for_site(site):
    response = dynamodb.get_item(
        TableName=DISPATCH_LOCK_TABLE,
        Key={
            "site": {"S": source_state_key(site)},
        },
    )

    item = response.get("Item")
    if not item:
        return None

    key = item.get("latest_key", {}).get("S")
    scan_time_raw = item.get("scan_time", {}).get("S")

    if not key:
        return None

    scan_time = parse_iso_datetime(scan_time_raw) if scan_time_raw else None

    if not scan_time:
        source_summary = source_summary_from_key(key)
        if not source_summary:
            return None

        return source_summary

    return {
        "key": key,
        "scan_time": scan_time,
        "scan_time_iso": scan_time.isoformat().replace("+00:00", "Z"),
        "source": "dynamodb_source_event",
    }


def latest_source_for_site(site, now_utc):
    return latest_remembered_source_for_site(site)


def source_is_newer_than_manifest(source_summary, manifest_summary):
    if not source_summary:
        return False

    source_time = source_summary.get("scan_time")
    manifest_time = parse_iso_datetime(manifest_summary.get("latest_scan"))

    if not source_time:
        return False

    if not manifest_time:
        return True

    return source_time > manifest_time


def watchdog_site_lane(site):
    fema_region_iii = {"KFCX", "KLWX", "KAKQ", "KRLX"}
    fema_region_iv = {"KRAX", "KMHX", "KGSP", "KLTX", "KCAE", "KCLX", "KMRX", "KJKL"}

    if site in fema_region_iii:
        return "fema_region_iii"

    if site in fema_region_iv:
        return "fema_region_iv"

    return "unassigned"


def candidate_priority(candidate):
    age_seconds = candidate.get("age_seconds")
    if age_seconds is None:
        age_seconds = 999999

    source_gap_seconds = candidate.get("source_gap_seconds") or 0
    source_newer = 1 if candidate.get("source_newer_than_manifest") else 0
    source_lookup_failed = 1 if candidate.get("source_lookup_error") else 0

    return (
        source_newer,
        source_gap_seconds,
        source_lookup_failed,
        age_seconds,
    )


def grouped_dispatch_reason(lane, lane_candidates):
    if any(candidate.get("source_newer_than_manifest") for candidate in lane_candidates):
        return f"watchdog_{lane}_source_newer"

    if any(candidate.get("source_lookup_error") for candidate in lane_candidates):
        return f"watchdog_{lane}_source_lookup_failed"

    return f"watchdog_{lane}_stale"


def run_watchdog(event):
    now_utc = datetime.now(timezone.utc)
    stale_seconds = int(event.get("stale_seconds", WATCHDOG_STALE_SECONDS))
    max_dispatches = int(event.get("max_dispatches", WATCHDOG_MAX_DISPATCHES))
    manual_dispatch_target = str(event.get("dispatch_target", "")).strip().lower() or None
    force_dispatch = as_bool(event.get("force_dispatch", False))

    checked = []
    candidates = []
    skipped = []
    failed = []

    for site in sorted(ALLOWED_SITES):
        try:
            manifest = fetch_level2_manifest(site)
            summary = summarize_manifest(site, manifest, now_utc)
            checked.append(summary)
        except Exception as error:
            failed.append(
                {
                    "site": site,
                    "reason": "manifest fetch failed",
                    "error": str(error),
                }
            )
            continue

        age_seconds = summary.get("age_seconds")

        latest_source = None
        source_newer = False
        source_lookup_error = None
        source_gap_seconds = 0

        try:
            latest_source = latest_source_for_site(site, now_utc)
            source_newer = source_is_newer_than_manifest(latest_source, summary)

            manifest_scan = parse_iso_datetime(summary.get("latest_scan"))
            source_scan = latest_source.get("scan_time") if latest_source else None

            if manifest_scan and source_scan:
                source_gap_seconds = max(0, int((source_scan - manifest_scan).total_seconds()))
        except Exception as error:
            source_lookup_error = str(error)
            failed.append(
                {
                    "site": site,
                    "reason": "source lookup failed",
                    "error": source_lookup_error,
                    "age_seconds": age_seconds,
                }
            )

        summary["latest_source_key"] = latest_source.get("key") if latest_source else None
        summary["latest_source_scan"] = latest_source.get("scan_time_iso") if latest_source else None
        summary["source_newer_than_manifest"] = source_newer
        summary["source_gap_seconds"] = source_gap_seconds
        summary["watchdog_lane"] = watchdog_site_lane(site)

        render_is_stale = age_seconds is None or age_seconds > stale_seconds

        should_candidate = (
            force_dispatch
            or source_newer
            or (
                render_is_stale
                and (
                    not WATCHDOG_REQUIRE_NEWER_SOURCE
                    or source_lookup_error
                )
            )
        )

        if not should_candidate:
            if render_is_stale:
                skipped.append(
                    {
                        "site": site,
                        "reason": "source not newer than manifest",
                        "age_seconds": age_seconds,
                        "manifest_latest_scan": summary.get("latest_scan"),
                        "latest_source_key": summary.get("latest_source_key"),
                        "latest_source_scan": summary.get("latest_source_scan"),
                        "watchdog_lane": summary.get("watchdog_lane"),
                    }
                )
            continue

        candidates.append(
            {
                "site": site,
                "age_seconds": age_seconds,
                "frames": summary.get("frames"),
                "updated_at": summary.get("updated_at"),
                "latest_scan": summary.get("latest_scan"),
                "latest_source_key": summary.get("latest_source_key"),
                "latest_source_scan": summary.get("latest_source_scan"),
                "source_newer_than_manifest": source_newer,
                "source_gap_seconds": source_gap_seconds,
                "source_lookup_error": source_lookup_error,
                "watchdog_lane": summary.get("watchdog_lane"),
                "latest_source": latest_source,
            }
        )

    candidates = sorted(candidates, key=candidate_priority, reverse=True)

    selected = []
    attempted_sites = set()
    claimed_sites = set()

    def try_select_candidate(candidate, selection_reason):
        site = candidate["site"]

        if site in attempted_sites:
            return False

        attempted_sites.add(site)

        if len(selected) >= max_dispatches:
            skipped.append(
                {
                    "site": site,
                    "reason": "watchdog max dispatches reached",
                    "selection_reason": selection_reason,
                    "age_seconds": candidate.get("age_seconds"),
                    "latest_source_key": candidate.get("latest_source_key"),
                    "latest_source_scan": candidate.get("latest_source_scan"),
                    "watchdog_lane": candidate.get("watchdog_lane"),
                }
            )
            return False

        if not force_dispatch and not claim_dispatch_slot(site):
            skipped.append(
                {
                    "site": site,
                    "reason": "dispatch cooldown active",
                    "selection_reason": selection_reason,
                    "age_seconds": candidate.get("age_seconds"),
                    "latest_source_key": candidate.get("latest_source_key"),
                    "latest_source_scan": candidate.get("latest_source_scan"),
                    "watchdog_lane": candidate.get("watchdog_lane"),
                }
            )
            return False

        candidate["selection_reason"] = selection_reason
        selected.append(candidate)
        claimed_sites.add(site)
        return True

    for lane in ("fema_region_iii", "fema_region_iv", "unassigned"):
        if len(selected) >= max_dispatches:
            break

        lane_candidates = [
            candidate
            for candidate in candidates
            if candidate.get("watchdog_lane") == lane
        ]

        for candidate in lane_candidates:
            if try_select_candidate(candidate, f"lane:{lane}"):
                break

    for candidate in candidates:
        if len(selected) >= max_dispatches:
            break

        try_select_candidate(candidate, "global_priority")

    selected_by_lane = {}
    for candidate in selected:
        lane = candidate.get("watchdog_lane") or "unassigned"
        selected_by_lane.setdefault(lane, []).append(candidate)

    dispatched = []

    lane_order = ["fema_region_iii", "fema_region_iv", "unassigned"]
    lane_order.extend(
        lane
        for lane in sorted(selected_by_lane)
        if lane not in lane_order
    )

    for lane in lane_order:
        lane_candidates = selected_by_lane.get(lane) or []
        if not lane_candidates:
            continue

        sites = [candidate["site"] for candidate in lane_candidates]
        source_key = f"watchdog://{lane}/{now_utc.isoformat().replace('+00:00', 'Z')}"
        dispatch_reason = grouped_dispatch_reason(lane, lane_candidates)

        try:
            target, status, response_body = dispatch_render(
                site=sites[0],
                sites=sites,
                source_key=source_key,
                dispatch_reason=dispatch_reason,
                dispatch_target=manual_dispatch_target,
                dispatch_group=lane,
            )

            dispatched.append(
                {
                    "lane": lane,
                    "sites": sites,
                    "site_count": len(sites),
                    "selection_reasons": [
                        candidate.get("selection_reason")
                        for candidate in lane_candidates
                    ],
                    "candidate_summaries": [
                        {
                            "site": candidate.get("site"),
                            "age_seconds": candidate.get("age_seconds"),
                            "latest_scan": candidate.get("latest_scan"),
                            "latest_source_key": candidate.get("latest_source_key"),
                            "latest_source_scan": candidate.get("latest_source_scan"),
                            "source_newer_than_manifest": candidate.get("source_newer_than_manifest"),
                            "source_gap_seconds": candidate.get("source_gap_seconds"),
                            "watchdog_lane": candidate.get("watchdog_lane"),
                        }
                        for candidate in lane_candidates
                    ],
                    "source_key": source_key,
                    "dispatch_target": target,
                    "dispatch_status": status,
                    "dispatch_reason": dispatch_reason,
                    "dispatch_response": response_body,
                }
            )
        except Exception as error:
            for candidate in lane_candidates:
                release_dispatch_slot(candidate["site"])

            failed.append(
                {
                    "lane": lane,
                    "sites": sites,
                    "reason": "group dispatch failed",
                    "error": str(error),
                }
            )

    result = {
        "ok": True,
        "mode": "watchdog",
        "dispatch_target": manual_dispatch_target or LEVEL2_DISPATCH_TARGET,
        "stale_seconds": stale_seconds,
        "max_dispatches": max_dispatches,
        "allowed_sites": sorted(ALLOWED_SITES),
        "checked_count": len(checked),
        "candidate_count": len(candidates),
        "selected_site_count": len(selected),
        "dispatched_count": len(dispatched),
        "dispatched_site_count": sum(len(group.get("sites", [])) for group in dispatched),
        "skipped_count": len(skipped),
        "failed_count": len(failed),
        "checked": checked,
        "candidates": [
            {
                key: value
                for key, value in candidate.items()
                if key != "latest_source"
            }
            for candidate in candidates
        ],
        "selected": [
            {
                key: value
                for key, value in candidate.items()
                if key != "latest_source"
            }
            for candidate in selected
        ],
        "dispatched": dispatched,
        "skipped": skipped,
        "failed": failed,
    }

    print(json.dumps(result))
    return result

def lambda_handler(event, context):
    if should_run_watchdog(event):
        return run_watchdog(event)

    ignored = []
    keys_by_site = {}

    manual_dispatch_target = str(event.get("dispatch_target", "")).strip().lower() or None
    manual_force_dispatch = as_bool(event.get("force_dispatch", False))

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
        latest_key = latest_renderable_source_key(keys)
        source_state = remember_latest_source_key(site, latest_key)

        if not manual_force_dispatch and not manual_dispatch_target:
            skipped.append(
                {
                    "site": site,
                    "reason": "source event cached for watchdog grouping",
                    "keys_in_batch": len(keys),
                    "latest_key": latest_key,
                    "source_state": source_state,
                }
            )
            continue

        if not manual_force_dispatch and not claim_dispatch_slot(site):
            skipped.append(
                {
                    "site": site,
                    "reason": "dispatch cooldown active",
                    "keys_in_batch": len(keys),
                    "latest_key": latest_key,
                    "source_state": source_state,
                }
            )
            continue

        try:
            target, status, response_body = dispatch_render(
                site=site,
                source_key=latest_key,
                dispatch_reason="manual_test" if manual_dispatch_target else "source_event",
                dispatch_target=manual_dispatch_target,
            )

            dispatched.append(
                {
                    "site": site,
                    "latest_key": latest_key,
                    "keys_in_batch": len(keys),
                    "source_state": source_state,
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