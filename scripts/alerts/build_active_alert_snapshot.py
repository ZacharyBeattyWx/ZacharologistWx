from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import gzip
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_AREAS = [
    "TX", "OK", "KS", "CO", "NE", "SD", "ND", "MN",
    "IA", "MO", "AR", "LA", "WI", "IL", "IN", "MI",
    "OH", "KY", "TN", "MS", "AL", "GA", "FL", "SC",
    "NC", "VA", "WV", "PA", "NY", "VT", "NH", "ME",
    "MD", "DE", "NJ", "CT", "RI", "MA",
]

NWS_HEADERS = {
    "Accept": "application/geo+json, application/json",
    "User-Agent": "ZacharologistWx Alert Snapshot Builder (https://zacharologistwx.com)",
}

def request_json(url: str, attempts: int = 3, timeout: int = 45):
    last_error = None

    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, headers=NWS_HEADERS)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            if attempt < attempts:
                time.sleep(min(4, attempt))

    raise RuntimeError(f"{url} failed after {attempts} attempts: {last_error}")

def alert_key(feature: dict, index: int) -> str:
    properties = feature.get("properties") or {}

    for value in (
        feature.get("id"),
        properties.get("id"),
        properties.get("identifier"),
    ):
        value = str(value or "").strip()
        if value:
            return value

    return f"unknown-alert-{index}"

def has_polygon_geometry(geometry) -> bool:
    if not isinstance(geometry, dict):
        return False

    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")

    return (
        geometry_type in {"Polygon", "MultiPolygon"}
        and isinstance(coordinates, list)
        and len(coordinates) > 0
    )

def is_test_or_expired(feature: dict) -> bool:
    properties = feature.get("properties") or {}

    status = str(properties.get("status") or "").strip().lower()
    message_type = str(
        properties.get("messageType")
        or properties.get("message_type")
        or properties.get("msgType")
        or ""
    ).strip().lower()

    if status in {"test", "exercise", "draft"} or message_type == "test":
        return True

    text = " ".join([
        str(properties.get("event") or "").lower(),
        str(properties.get("headline") or "").lower(),
    ])

    if (
        "test message" in text
        or "required weekly test" in text
        or "required monthly test" in text
    ):
        return True

    expires_value = properties.get("expires") or properties.get("ends")
    if not expires_value:
        return False

    try:
        expires_text = str(expires_value).replace("Z", "+00:00")
        expires_at = dt.datetime.fromisoformat(expires_text)

        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=dt.timezone.utc)

        return expires_at <= dt.datetime.now(dt.timezone.utc)
    except ValueError:
        return False

def fetch_alerts_for_area(area: str):
    url = f"https://api.weather.gov/alerts/active?area={area}"
    payload = request_json(url)
    features = payload.get("features") or []

    if not isinstance(features, list):
        return area, [], "Unexpected alert response"

    return area, features, ""

def fetch_zone_geometry(zone_url: str):
    try:
        payload = request_json(zone_url)
        geometry = payload.get("geometry")

        if not has_polygon_geometry(geometry):
            return zone_url, None, "No polygon geometry"

        return zone_url, geometry, ""
    except Exception as error:
        return zone_url, None, str(error)


ZONE_CACHE_SCHEMA_VERSION = 1

def load_zone_geometry_cache(cache_path: Path):
    if not cache_path.exists():
        return {}, set()

    try:
        if cache_path.suffix.lower() == ".gz":
            with gzip.open(cache_path, "rt", encoding="utf-8") as handle:
                payload = json.load(handle)
        else:
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError(
            f"Unable to read zone geometry cache {cache_path}: {error}"
        ) from error

    if not isinstance(payload, dict):
        raise RuntimeError(f"Zone geometry cache is not an object: {cache_path}")

    if payload.get("schemaVersion") != ZONE_CACHE_SCHEMA_VERSION:
        raise RuntimeError(
            f"Unsupported zone cache schema in {cache_path}: "
            f"{payload.get('schemaVersion')!r}"
        )

    raw_geometries = payload.get("geometries") or {}
    raw_no_geometry_urls = payload.get("noGeometryUrls") or []

    geometries = {
        str(zone_url): geometry
        for zone_url, geometry in raw_geometries.items()
        if str(zone_url).strip() and has_polygon_geometry(geometry)
    }

    no_geometry_urls = {
        str(zone_url).strip()
        for zone_url in raw_no_geometry_urls
        if str(zone_url).strip()
    }

    return geometries, no_geometry_urls

def save_zone_geometry_cache(
    cache_path: Path,
    geometries: dict,
    no_geometry_urls: set,
):
    cache_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "schemaVersion": ZONE_CACHE_SCHEMA_VERSION,
        "generatedAt": dt.datetime.now(dt.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "geometries": geometries,
        "noGeometryUrls": sorted(no_geometry_urls),
    }

    temp_path = cache_path.with_name(cache_path.name + ".tmp")

    if cache_path.suffix.lower() == ".gz":
        with gzip.open(
            temp_path,
            "wt",
            encoding="utf-8",
            compresslevel=6,
        ) as handle:
            json.dump(payload, handle, separators=(",", ":"))
    else:
        temp_path.write_text(
            json.dumps(payload, separators=(",", ":")),
            encoding="utf-8",
        )

    os.replace(temp_path, cache_path)

def build_snapshot(
    areas: list[str],
    alert_workers: int,
    zone_workers: int,
    zone_cache_path: Path | None = None,
):
    raw_features = []
    alert_failures = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=alert_workers) as executor:
        futures = {
            executor.submit(fetch_alerts_for_area, area): area
            for area in areas
        }

        for future in concurrent.futures.as_completed(futures):
            area = futures[future]

            try:
                returned_area, features, error = future.result()
            except Exception as exc:
                returned_area, features, error = area, [], str(exc)

            raw_features.extend(features)

            if error:
                alert_failures.append({
                    "area": returned_area,
                    "error": error,
                })

    unique_alerts = []
    seen_alert_ids = set()

    for index, feature in enumerate(raw_features):
        key = alert_key(feature, index)

        if key in seen_alert_ids:
            continue

        seen_alert_ids.add(key)
        unique_alerts.append(feature)

    fallback_targets = []
    unique_zone_urls = set()

    for index, feature in enumerate(unique_alerts):
        if is_test_or_expired(feature):
            continue

        if has_polygon_geometry(feature.get("geometry")):
            continue

        properties = feature.get("properties") or {}
        zones = properties.get("affectedZones") or []

        if not isinstance(zones, list):
            continue

        parent_alert_id = alert_key(feature, index)

        for zone_url in dict.fromkeys(
            str(url or "").strip()
            for url in zones
            if str(url or "").strip()
        ):
            fallback_targets.append((parent_alert_id, feature, zone_url))
            unique_zone_urls.add(zone_url)

    cached_geometry_by_url = {}
    cached_no_geometry_urls = set()

    if zone_cache_path:
        cached_geometry_by_url, cached_no_geometry_urls = (
            load_zone_geometry_cache(zone_cache_path)
        )

        print(
            "Zone cache loaded: "
            f"{len(cached_geometry_by_url)} geometries, "
            f"{len(cached_no_geometry_urls)} no-geometry URLs"
        )

    zone_geometry_by_url = {
        zone_url: cached_geometry_by_url[zone_url]
        for zone_url in unique_zone_urls
        if zone_url in cached_geometry_by_url
    }

    cached_zone_geometry_hits = len(zone_geometry_by_url)

    cached_no_geometry_hits = len(
        unique_zone_urls.intersection(cached_no_geometry_urls)
    )

    zone_urls_to_fetch = sorted(
        zone_url
        for zone_url in unique_zone_urls
        if (
            zone_url not in zone_geometry_by_url
            and zone_url not in cached_no_geometry_urls
        )
    )

    zone_failures = []
    new_zone_geometries = 0
    new_no_geometry_urls = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=zone_workers) as executor:
        futures = {
            executor.submit(fetch_zone_geometry, zone_url): zone_url
            for zone_url in zone_urls_to_fetch
        }

        for future in concurrent.futures.as_completed(futures):
            zone_url = futures[future]

            try:
                returned_url, geometry, error = future.result()
            except Exception as exc:
                returned_url, geometry, error = zone_url, None, str(exc)

            if geometry:
                zone_geometry_by_url[returned_url] = geometry
                cached_geometry_by_url[returned_url] = geometry
                new_zone_geometries += 1
            elif error == "No polygon geometry":
                if returned_url not in cached_no_geometry_urls:
                    cached_no_geometry_urls.add(returned_url)
                    new_no_geometry_urls += 1
            else:
                zone_failures.append({
                    "zoneUrl": returned_url,
                    "error": error or "Unknown zone failure",
                })

    if zone_cache_path:
        save_zone_geometry_cache(
            zone_cache_path,
            cached_geometry_by_url,
            cached_no_geometry_urls,
        )

    # Collapse each zone-based alert into one Polygon/MultiPolygon.
    # The browser gets alert-level geometry, not thousands of separate county features.
    fallback_parts_by_alert = {}
    fallback_zone_count_by_alert = {}
    seen_geometry_per_alert = {}

    for parent_alert_id, feature, zone_url in fallback_targets:
        geometry = zone_geometry_by_url.get(zone_url)

        if not geometry:
            continue

        if geometry.get("type") == "Polygon":
            polygon_parts = [geometry.get("coordinates")]
        elif geometry.get("type") == "MultiPolygon":
            polygon_parts = geometry.get("coordinates") or []
        else:
            polygon_parts = []

        polygon_parts = [
            part for part in polygon_parts
            if isinstance(part, list) and len(part) > 0
        ]

        if not polygon_parts:
            continue

        geometry_signature = json.dumps(
            geometry,
            sort_keys=True,
            separators=(",", ":"),
        )

        seen_for_alert = seen_geometry_per_alert.setdefault(
            parent_alert_id,
            set(),
        )

        if geometry_signature in seen_for_alert:
            continue

        seen_for_alert.add(geometry_signature)

        fallback_parts_by_alert.setdefault(
            parent_alert_id,
            [],
        ).extend(polygon_parts)

        fallback_zone_count_by_alert[parent_alert_id] = (
            fallback_zone_count_by_alert.get(parent_alert_id, 0) + 1
        )

    resolved_features = []
    listed_only_alerts = []

    for index, feature in enumerate(unique_alerts):
        if is_test_or_expired(feature):
            continue

        properties = dict(feature.get("properties") or {})
        parent_alert_id = alert_key(feature, index)
        direct_geometry = feature.get("geometry")

        output_feature = {
            "type": "Feature",
            "id": feature.get("id") or parent_alert_id,
            "geometry": direct_geometry,
            "properties": properties,
        }

        if has_polygon_geometry(direct_geometry):
            resolved_features.append(output_feature)
            continue

        fallback_parts = fallback_parts_by_alert.get(parent_alert_id, [])

        if not fallback_parts:
            listed_only_alerts.append({
                "id": parent_alert_id,
                "event": properties.get("event") or "",
                "headline": properties.get("headline") or "",
            })
            continue

        output_feature["geometry"] = (
            {
                "type": "Polygon",
                "coordinates": fallback_parts[0],
            }
            if len(fallback_parts) == 1
            else {
                "type": "MultiPolygon",
                "coordinates": fallback_parts,
            }
        )

        output_feature["properties"] = {
            **properties,
            "_fallbackGeometry": True,
            "_fallbackZoneCount": fallback_zone_count_by_alert.get(
                parent_alert_id,
                0,
            ),
        }

        resolved_features.append(output_feature)

    generated_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")

    return {
        "type": "FeatureCollection",
        "schemaVersion": 2,
        "generatedAt": generated_at,
        "requestedAreas": areas,
        "features": resolved_features,
        "stats": {
            "rawAlertFeatures": len(unique_alerts),
            "snapshotFeatures": len(resolved_features),
            "uniqueFallbackZoneUrls": len(unique_zone_urls),
            "resolvedZoneGeometries": len(zone_geometry_by_url),
            "cachedZoneGeometryHits": cached_zone_geometry_hits,
            "cachedNoGeometryHits": cached_no_geometry_hits,
            "zoneFetchRequests": len(zone_urls_to_fetch),
            "newZoneGeometries": new_zone_geometries,
            "newNoGeometryUrls": new_no_geometry_urls,
            "resolvedFallbackAlerts": sum(
                1
                for feature in resolved_features
                if (feature.get("properties") or {}).get("_fallbackGeometry") is True
            ),
            "resolvedFallbackZones": sum(
                fallback_zone_count_by_alert.values()
            ),
            "listedOnlyAlerts": len(listed_only_alerts),
            "alertFetchFailures": len(alert_failures),
            "zoneFetchFailures": len(zone_failures),
        },
        "partialFailures": {
            "alerts": alert_failures,
            "zones": zone_failures,
        },
        "listedOnlyAlerts": listed_only_alerts,
    }
def main():
    parser = argparse.ArgumentParser(
        description="Build a ready-to-render ZacharologistWx active NWS alert snapshot."
    )

    parser.add_argument(
        "--output",
        default="alerts/active-alert-snapshot.json",
        help="Snapshot output path.",
    )

    parser.add_argument(
        "--areas",
        default=",".join(DEFAULT_AREAS),
        help="Comma-separated NWS state area codes.",
    )

    parser.add_argument(
        "--alert-workers",
        type=int,
        default=6,
        help="Concurrent NWS active-alert area requests.",
    )

    parser.add_argument(
        "--zone-workers",
        type=int,
        default=12,
        help="Concurrent individual NWS zone requests.",
    )

    parser.add_argument(
        "--zone-cache",
        default="alerts/nws-zone-cache.json.gz",
        help=(
            "Persistent zone geometry cache path. "
            "Use an empty value to disable persistent caching."
        ),
    )

    args = parser.parse_args()

    areas = list(dict.fromkeys(
        area.strip().upper()
        for area in args.areas.split(",")
        if area.strip()
    ))

    zone_cache_path = (
        Path(args.zone_cache).expanduser()
        if str(args.zone_cache or "").strip()
        else None
    )

    snapshot = build_snapshot(
        areas=areas,
        alert_workers=max(1, args.alert_workers),
        zone_workers=max(1, args.zone_workers),
        zone_cache_path=zone_cache_path,
    )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    temp_path = output_path.with_suffix(output_path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(snapshot, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temp_path, output_path)

    size_mb = output_path.stat().st_size / (1024 * 1024)

    print(json.dumps({
        **snapshot["stats"],
        "output": str(output_path),
        "outputSizeMB": round(size_mb, 2),
        "generatedAt": snapshot["generatedAt"],
    }, indent=2))

if __name__ == "__main__":
    main()