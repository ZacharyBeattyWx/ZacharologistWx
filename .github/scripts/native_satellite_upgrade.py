from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one {label}, found {count}")
    return text.replace(old, new, 1)


def replace_count(text, old, new, expected, label):
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"Expected {expected} {label}, found {count}")
    return text.replace(old, new)


# -----------------------------------------------------------------------------
# Publisher: native Clean IR + Air Mass sidecar products and regional C13 night.
# -----------------------------------------------------------------------------
p = Path("aws/satellite-truecolor-publisher/satellite_truecolor_publisher.py")
s = p.read_text(encoding="utf-8")

s = replace_once(
    s,
    '''TARGET_PREFIX = os.getenv(
    "SATELLITE_TRUECOLOR_PREFIX",
    "satellite-truecolor",
).strip("/")
''',
    '''TARGET_PREFIX = os.getenv(
    "SATELLITE_TRUECOLOR_PREFIX",
    "satellite-truecolor",
).strip("/")
NATIVE_PREFIX = os.getenv(
    "SATELLITE_NATIVE_PREFIX",
    "satellite-native",
).strip("/")
''',
    "native prefix insertion",
)

s = replace_count(
    s,
    '''        "render_version": RENDER_VERSION,
        "c02_stride": 1,
''',
    '''        "render_version": 4,
        "night_channel": "13",
        "native_products": True,
        "c02_stride": 1,
''',
    2,
    "regional render-version blocks",
)

s = replace_count(
    s,
    '''        "render_version": 9,
        "night_channel": "13",
''',
    '''        "render_version": 9,
        "night_channel": "13",
        "native_products": True,
''',
    2,
    "global native-product flags",
)

s = replace_once(
    s,
    '''SOURCE_RE = re.compile(
    r"-M\\dC(?P<channel>01|02|03|13)_G\\d+_s(?P<scan>\\d{11})"
)
''',
    '''SOURCE_RE = re.compile(
    r"-M\\dC(?P<channel>01|02|03|13)_G\\d+_s(?P<scan>\\d{11})"
)
NATIVE_SOURCE_RE = re.compile(
    r"-M\\dC(?P<channel>08|10|12|13)_G\\d+_s(?P<scan>\\d{11})"
)
''',
    "native source regex",
)

s = replace_once(
    s,
    "def list_complete_scans(spec, now):\n",
    '''def native_manifest_key(spec, product):
    return (
        f"{NATIVE_PREFIX}/{spec['prefix']}/"
        f"{product}/manifest.json"
    )


def native_frame_key(spec, product, scan_dt):
    stamp = scan_dt.strftime("%Y%m%dT%H%M00Z")
    return (
        f"{NATIVE_PREFIX}/{spec['prefix']}/{product}/"
        f"frames/v1/{stamp}.webp"
    )


def read_native_manifest(spec, product):
    try:
        response = TARGET_S3.get_object(
            Bucket=TARGET_BUCKET,
            Key=native_manifest_key(spec, product),
        )
        data = json.loads(response["Body"].read().decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except TARGET_S3.exceptions.NoSuchKey:
        return {}
    except Exception as exc:
        print(
            f"{spec['satellite']} {product} manifest unavailable: {exc}"
        )
        return {}


def list_complete_scans(spec, now):
''',
    "native manifest helpers",
)

s = replace_once(
    s,
    "def solar_elevation_deg(dt, lat, lon):\n",
    '''def list_complete_native_scans(spec, now):
    grouped = {}

    for hour_offset in range(HISTORY_HOURS + 1):
        hour = now - timedelta(hours=hour_offset)
        prefix = source_hour_prefix(spec, hour)
        paginator = SOURCE_S3.get_paginator("list_objects_v2")

        for page in paginator.paginate(
            Bucket=spec["source_bucket"],
            Prefix=prefix,
        ):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                match = NATIVE_SOURCE_RE.search(key)

                if not match or not key.endswith(".nc"):
                    continue

                scan = match.group("scan")
                channel = match.group("channel")
                group = grouped.setdefault(
                    scan,
                    {
                        "scan": scan,
                        "time": parse_scan(scan),
                        "channels": {},
                    },
                )

                previous = group["channels"].get(channel)
                if previous is None or key > previous:
                    group["channels"][channel] = key

    required = ("08", "10", "12", "13")
    complete = [
        group
        for group in grouped.values()
        if all(
            channel in group["channels"]
            for channel in required
        )
    ]
    complete.sort(key=lambda group: group["time"], reverse=True)
    return complete


def solar_elevation_deg(dt, lat, lon):
''',
    "native scan discovery",
)

s = replace_once(
    s,
    "def solar_daylight_alpha(\n",
    '''def clean_ir_rgb(bt):
    valid = np.isfinite(bt)
    bt_safe = np.where(valid, bt, 320.0)

    # Neutral Clean Longwave IR: warm land/ocean stays dark while colder
    # cloud tops progressively brighten toward white.
    intensity = np.clip(
        (315.0 - bt_safe) / 125.0,
        0.0,
        1.0,
    )
    intensity = np.power(intensity, 0.82)
    rgb = np.repeat(intensity[..., None], 3, axis=-1)
    rgb[~valid] = 0.0
    return rgb, valid


def _normalize_rgb_channel(values, low, high):
    return np.clip(
        (values - low) / (high - low),
        0.0,
        1.0,
    )


def air_mass_rgb(bt08, bt10, bt12, bt13):
    valid = (
        np.isfinite(bt08)
        & np.isfinite(bt10)
        & np.isfinite(bt12)
        & np.isfinite(bt13)
    )

    c08 = np.where(valid, bt08, 250.0)
    c10 = np.where(valid, bt10, 250.0)
    c12 = np.where(valid, bt12, 250.0)
    c13 = np.where(valid, bt13, 250.0)

    # Standard GOES-R Air Mass RGB recipe.
    red = _normalize_rgb_channel(c08 - c10, -26.2, 0.6)
    green = _normalize_rgb_channel(c12 - c13, -42.2, 6.7)
    blue = 1.0 - _normalize_rgb_channel(
        c08 - 273.15,
        -64.65,
        -29.25,
    )

    rgb = np.stack([red, green, blue], axis=-1)
    rgb[~valid] = 0.0
    return rgb, valid


def solar_daylight_alpha(
''',
    "native RGB recipes",
)

s = replace_once(
    s,
    "def publish_manifest(spec, existing, frames, checked_scans, now):\n",
    '''def render_native_scan(spec, group):
    paths = {}
    channels = ("08", "10", "12", "13")

    try:
        for channel in channels:
            paths[channel] = download_source(
                spec["source_bucket"],
                group["channels"][channel],
                f"-C{channel}.nc",
            )

        source_crs = source_crs_from_path(paths["13"])
        gx, gy, width, height = output_grid(spec, source_crs)

        sampled = {}
        for channel in channels:
            source = read_brightness_temperature(
                paths[channel],
                gx,
                gy,
                stride=1,
            )
            sampled[channel] = sample_grid(source, gx, gy)

        clean_rgb, clean_valid = clean_ir_rgb(sampled["13"])
        air_rgb, air_valid = air_mass_rgb(
            sampled["08"],
            sampled["10"],
            sampled["12"],
            sampled["13"],
        )

        products = {
            "clean-ir": (clean_rgb, clean_valid),
            "air-mass": (air_rgb, air_valid),
        }
        frames = {}

        for product, (rgb, finite) in products.items():
            payload, image_width, image_height = encode_webp(rgb, finite)
            key = native_frame_key(spec, product, group["time"])
            TARGET_S3.put_object(
                Bucket=TARGET_BUCKET,
                Key=key,
                Body=payload,
                ContentType="image/webp",
                CacheControl="public,max-age=31536000,immutable",
            )
            frames[product] = {
                "time": iso_z(group["time"]),
                "path": key[len(NATIVE_PREFIX) + 1 :],
                "width": image_width,
                "height": image_height,
                "scan": group["scan"],
            }

        print(
            f"{spec['satellite']} native {group['scan']} "
            f"{width}x{height} CleanIR+AirMass"
        )
        return frames

    finally:
        for path in paths.values():
            try:
                os.unlink(path)
            except OSError:
                pass


def publish_manifest(spec, existing, frames, checked_scans, now):
''',
    "native renderer",
)

s = replace_once(
    s,
    "def lambda_handler(event, context):\n",
    '''def publish_native_manifest(spec, product, frames, checked_scans, now):
    cadence_minutes = int(spec.get("cadence_minutes", 5))
    frame_count = int(spec.get("frame_count", FRAME_COUNT))

    frames_by_scan = {
        frame["scan"]: frame
        for frame in frames
        if isinstance(frame, dict) and frame.get("scan")
    }
    all_ordered = sorted(
        frames_by_scan.values(),
        key=lambda frame: frame["time"],
    )

    contiguous = []
    if all_ordered:
        contiguous.append(all_ordered[-1])
        newer_time = datetime.fromisoformat(
            all_ordered[-1]["time"].replace("Z", "+00:00")
        )
        for frame in reversed(all_ordered[:-1]):
            frame_time = datetime.fromisoformat(
                frame["time"].replace("Z", "+00:00")
            )
            if newer_time - frame_time > timedelta(
                minutes=cadence_minutes + 2
            ):
                break
            contiguous.append(frame)
            newer_time = frame_time

    ordered = list(reversed(contiguous))[-frame_count:]

    if product == "clean-ir":
        product_name = "Clean IR"
        source_channels = "C13"
        recipe = {
            "channel": "C13 10.3um Clean Longwave IR",
            "palette": "neutral grayscale",
            "transparentNoData": True,
        }
    else:
        product_name = "Air Mass RGB"
        source_channels = "C08+C10+C12+C13"
        recipe = {
            "red": "C08-C10 (-26.2 to 0.6 K)",
            "green": "C12-C13 (-42.2 to 6.7 K)",
            "blue": "C08 BT (-64.65 to -29.25 C), inverted",
            "transparentNoData": True,
        }

    output = {
        "version": 1,
        "renderVersion": 1,
        "generated": iso_z(now),
        "platform": spec["platform"],
        "satellite": spec["satellite"],
        "sector": spec["sector"],
        "product": product_name,
        "sourceProduct": f"{spec['source_product']} {source_channels}",
        "cadenceMinutes": cadence_minutes,
        "frameCount": len(ordered),
        "targetFrameCount": frame_count,
        "nativeProduct": True,
        "bbox": list(spec["bbox"]),
        "recipe": recipe,
        "checkedScans": checked_scans[-160:],
        "frames": ordered,
    }

    TARGET_S3.put_object(
        Bucket=TARGET_BUCKET,
        Key=native_manifest_key(spec, product),
        Body=json.dumps(output, separators=(",", ":")).encode("utf-8"),
        ContentType="application/json",
        CacheControl="public,max-age=20,stale-while-revalidate=60",
    )
    return output


def process_native_platform(platform, spec, now):
    products = ("clean-ir", "air-mass")
    existing = {
        product: read_native_manifest(spec, product)
        for product in products
    }

    frames = {
        product: [
            frame
            for frame in existing[product].get("frames", [])
            if isinstance(frame, dict) and frame.get("scan")
        ]
        for product in products
    }

    checked_clean = [
        str(scan)
        for scan in existing["clean-ir"].get("checkedScans", [])
        if scan
    ]
    checked_air = set(
        str(scan)
        for scan in existing["air-mass"].get("checkedScans", [])
        if scan
    )
    checked = [scan for scan in checked_clean if scan in checked_air]
    checked_set = set(checked)

    candidates = list_complete_native_scans(spec, now)

    candidate_floor = None
    shared_frames = frames["clean-ir"]
    if shared_frames:
        newest_existing = max(
            datetime.fromisoformat(
                frame["time"].replace("Z", "+00:00")
            )
            for frame in shared_frames
        )
        cadence_minutes = int(spec.get("cadence_minutes", 5))
        frame_count = int(spec.get("frame_count", FRAME_COUNT))
        candidate_floor = newest_existing - timedelta(
            minutes=(frame_count * cadence_minutes) + (cadence_minutes * 2)
        )

    attempted = 0
    rendered = 0
    max_render = int(spec.get("native_max_render", 1))

    for group in candidates:
        if candidate_floor is not None and group["time"] < candidate_floor:
            break
        if group["scan"] in checked_set:
            continue
        if attempted >= max_render:
            break

        attempted += 1
        try:
            rendered_frames = render_native_scan(spec, group)
            for product in products:
                frames[product].append(rendered_frames[product])
            checked.append(group["scan"])
            checked_set.add(group["scan"])
            rendered += 1
        except Exception as exc:
            print(
                f"{spec['satellite']} native {group['scan']} failed: {exc}"
            )

    manifests = {
        product: publish_native_manifest(
            spec,
            product,
            frames[product],
            checked,
            now,
        )
        for product in products
    }

    return {
        "platform": platform,
        "attempted": attempted,
        "rendered": rendered,
        "cleanIrFrames": manifests["clean-ir"]["frameCount"],
        "airMassFrames": manifests["air-mass"]["frameCount"],
        "latestTime": (
            manifests["clean-ir"]["frames"][-1]["time"]
            if manifests["clean-ir"]["frames"]
            else None
        ),
    }


def lambda_handler(event, context):
''',
    "native manifest publisher",
)

s = replace_once(
    s,
    '''    for platform, spec in PLATFORMS.items():
        results.append(
            process_platform(
                platform,
                spec,
                now,
            )
        )
''',
    '''    for platform, spec in PLATFORMS.items():
        result = process_platform(platform, spec, now)
        if spec.get("native_products"):
            result["native"] = process_native_platform(
                platform,
                spec,
                now,
            )
        results.append(result)
''',
    "lambda native-product hook",
)

p.write_text(s, encoding="utf-8")


# -----------------------------------------------------------------------------
# CloudFormation: explicit native archive prefix for both Lambda workers.
# -----------------------------------------------------------------------------
p = Path("aws/satellite-truecolor-publisher/template.yaml")
s = p.read_text(encoding="utf-8")
old = "          SATELLITE_TRUECOLOR_PREFIX: satellite-truecolor\n"
new = (
    "          SATELLITE_TRUECOLOR_PREFIX: satellite-truecolor\n"
    "          SATELLITE_NATIVE_PREFIX: satellite-native\n"
)
if s.count(old) != 2:
    raise SystemExit(f"Expected 2 template prefix blocks, found {s.count(old)}")
s = s.replace(old, new)
p.write_text(s, encoding="utf-8")


# -----------------------------------------------------------------------------
# Viewer: prefer native products, retain GIBS as automatic fallback.
# -----------------------------------------------------------------------------
p = Path("weather-viewer.html")
s = p.read_text(encoding="utf-8")

s = replace_once(
    s,
    '    const TRUECOLOR_BASE="https://dt0cd6bl1yqh2.cloudfront.net/satellite-truecolor";\n',
    '    const TRUECOLOR_BASE="https://dt0cd6bl1yqh2.cloudfront.net/satellite-truecolor";\n'
    '    const NATIVE_SAT_BASE="https://dt0cd6bl1yqh2.cloudfront.net/satellite-native";\n',
    "native satellite base",
)

s = replace_once(
    s,
    '''      Band13_Clean_Infrared:{label:"Clean IR",layer:"Band13_Clean_Infrared"},
      Air_Mass:{label:"Air Mass",layer:"Air_Mass"}
''',
    '''      Band13_Clean_Infrared:{label:"Clean IR",layer:"Band13_Clean_Infrared",nativeProduct:"clean-ir"},
      Air_Mass:{label:"Air Mass",layer:"Air_Mass",nativeProduct:"air-mass"}
''',
    "native product flags",
)

s = replace_once(
    s,
    "    function trueColorCadenceForSector(sector){\n",
    '''    function nativeSatelliteManifestUrl(platform,sector,product){
      const global=sector?.id==="global";
      const prefix=
        `${platform.toLowerCase()}${global?"-global":""}`;
      return `${NATIVE_SAT_BASE}/${prefix}/${product}/manifest.json`;
    }

    function trueColorCadenceForSector(sector){
''',
    "native manifest URL helper",
)

s = replace_once(
    s,
    '''      let preparedFrames=[];

      if(context.product.prepared){
''',
    '''      let preparedFrames=[];

      if(context.product.nativeProduct){
        try{
          const response=await fetch(
            `${nativeSatelliteManifestUrl(
              context.platform,
              context.sector,
              context.product.nativeProduct
            )}?_=${Date.now()}`,
            {cache:"no-store"}
          );

          if(!response.ok){
            throw new Error(`Native satellite manifest HTTP ${response.status}`);
          }

          const manifest=await response.json();
          const rawFrames=Array.isArray(manifest.frames)?manifest.frames:[];

          if(!rawFrames.length){
            throw new Error("Native satellite manifest contains no frames");
          }

          if(!bboxContains(manifest.bbox,context.sector.bbox)){
            throw new Error("selected sector exceeds native satellite coverage");
          }

          context.sourceBbox=manifest.bbox.map(Number);
          context.renderVersion=manifest.renderVersion||null;
          context.cadenceMinutes=Number(manifest.cadenceMinutes)||10;
          context.sourceProduct=String(manifest.sourceProduct||"");
          context.mode="native-product";
          context.displayLabel=context.product.label;

          const nativeFrames=rawFrames
            .slice(-SAT_FRAME_COUNT)
            .map(item=>({
              time:new Date(item.time),
              url:`${NATIVE_SAT_BASE}/${item.path}`,
              source:"prepared"
            }))
            .filter(frame=>Number.isFinite(frame.time.getTime())&&frame.url);

          if(!nativeFrames.length){
            throw new Error("Native satellite manifest contains no usable frames");
          }

          if(generation!==satWarmGeneration)return false;
          satFrames=nativeFrames;
          return finishSatelliteFrameSet();

        }catch(error){
          console.warn(
            "Native satellite product unavailable; using GIBS fallback.",
            error
          );
          context.fallbackReason=String(error?.message||error);
        }
      }

      if(context.product.prepared){
''',
    "native manifest loading branch",
)

s = replace_once(
    s,
    '''      const nativeDayNight=
        satContext.mode===
        "native-day-night";
''',
    '''      const nativeProduct=
        satContext.mode===
        "native-product";

      const nativeDayNight=
        satContext.mode===
        "native-day-night";
''',
    "native product display state",
)

s = replace_once(
    s,
    '''      const displayProduct=
        nativeDayNight
          ?"True Color / C13 Night IR"
''',
    '''      const displayProduct=
        nativeProduct
          ?product.label
          :nativeDayNight
          ?"True Color / C13 Night IR"
''',
    "native product display label",
)

s = replace_once(
    s,
    '''      viewerStatus.textContent=
        nativeDayNight
          ?`GOES-${satContext.platform} day/night live`
''',
    '''      viewerStatus.textContent=
        nativeProduct
          ?`GOES-${satContext.platform} ${product.label} live`
          :nativeDayNight
          ?`GOES-${satContext.platform} day/night live`
''',
    "native product status",
)

s = replace_once(
    s,
    '''      viewerNote.textContent=
        nativeDayNight
          ?`${label} • ${preparedCadence}-minute native ABI 24-hour playback`
''',
    '''      viewerNote.textContent=
        nativeProduct
          ?`${label} • ${preparedCadence}-minute native ABI playback`
          :nativeDayNight
          ?`${label} • ${preparedCadence}-minute native ABI 24-hour playback`
''',
    "native product note",
)

s = replace_once(
    s,
    '''      satelliteMeta.textContent=
        nativeDayNight
          ?`NOAA GOES ABI ${preparedSource} C01/C02/C03 True Color + C13 Night IR • ${frameTime.toISOString().replace(".000Z","Z")}`
''',
    '''      satelliteMeta.textContent=
        nativeProduct
          ?`NOAA GOES ABI ${preparedSource} ${satContext.sourceProduct.replace(/^ABI-L1b-Rad[CF]\\s*/i,"")} • ${frameTime.toISOString().replace(".000Z","Z")}`
          :nativeDayNight
          ?`NOAA GOES ABI ${preparedSource} C01/C02/C03 True Color + C13 Night IR • ${frameTime.toISOString().replace(".000Z","Z")}`
''',
    "native product metadata",
)

p.write_text(s, encoding="utf-8")


# -----------------------------------------------------------------------------
# Deployment output: show sidecar manifests after the seed invocations.
# -----------------------------------------------------------------------------
p = Path("aws/satellite-truecolor-publisher/deploy-cloudshell.sh")
s = p.read_text(encoding="utf-8")
marker = "printf '\\nSatellite stack deployment complete. Existing MRMS/GLM stack was not modified.\\n'\n"
addition = r'''for PLATFORM in east west east-global west-global; do
  for PRODUCT in clean-ir air-mass; do
    MANIFEST="s3://${TARGET_BUCKET}/satellite-native/${PLATFORM}/${PRODUCT}/manifest.json"
    printf '%s %s native manifest:\n' "$PLATFORM" "$PRODUCT"
    if aws s3 cp --region "$REGION" "$MANIFEST" - >/tmp/zwx-satellite-native-manifest.json 2>/dev/null; then
      python3 - <<'PY'
import json
with open('/tmp/zwx-satellite-native-manifest.json') as f:
    m=json.load(f)
print('  product:', m.get('product'))
print('  sourceProduct:', m.get('sourceProduct'))
print('  cadenceMinutes:', m.get('cadenceMinutes'))
print('  frameCount:', m.get('frameCount'))
frames=m.get('frames') or []
if frames:
    print('  newest:', frames[-1].get('time'))
    print('  newestPath:', frames[-1].get('path'))
PY
    else
      echo '  manifest not published yet'
    fi
  done
done

'''
if s.count(marker) != 1:
    raise SystemExit("Could not find deploy completion marker")
s = s.replace(marker, addition + marker, 1)
p.write_text(s, encoding="utf-8")

print("Applied native Clean IR + Air Mass upgrade and regional C13 night support.")
