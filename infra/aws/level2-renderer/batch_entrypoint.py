from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def env_value(name: str, default: str | None = None, required: bool = False) -> str:
    value = os.environ.get(name, default)
    if required and not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return str(value or "").strip()


def run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    print("+ " + " ".join(command), flush=True)

    result = subprocess.run(
        command,
        check=False,
        env=env,
    )

    if result.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {result.returncode}: {' '.join(command)}")


def main() -> int:
    site = env_value("SITE", required=True).upper()
    source_count = env_value("SOURCE_COUNT", "75")
    frame_count = env_value("FRAME_COUNT", "25")

    r2_bucket = env_value("R2_BUCKET", required=True)
    r2_endpoint = env_value("R2_ENDPOINT")

    if not r2_endpoint:
        r2_account_id = env_value("R2_ACCOUNT_ID", required=True)
        r2_endpoint = f"https://{r2_account_id}.r2.cloudflarestorage.com"

    os.environ.setdefault("AWS_DEFAULT_REGION", "auto")
    os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")

    local_dir = Path(f"radar/tilesets/test/{site}/LEVEL2/REF0")
    remote_dir = f"s3://{r2_bucket}/radar/tilesets/test/{site}/LEVEL2/REF0"

    local_dir.mkdir(parents=True, exist_ok=True)

    print(f"Level II Batch renderer starting for {site}", flush=True)
    print(f"SOURCE_COUNT={source_count}", flush=True)
    print(f"FRAME_COUNT={frame_count}", flush=True)
    print(f"R2_ENDPOINT={r2_endpoint}", flush=True)
    print(f"REMOTE_DIR={remote_dir}", flush=True)

    # Restore prior output first so the renderer can retain loop history.
    restore_check = subprocess.run(
        ["aws", "s3", "ls", f"{remote_dir}/", "--endpoint-url", r2_endpoint],
        check=False,
    )

    if restore_check.returncode == 0:
        run(
            [
                "aws",
                "s3",
                "sync",
                remote_dir,
                str(local_dir),
                "--exclude",
                "*",
                "--include",
                "*.tif",
                "--include",
                "*.json",
                "--include",
                "mobile/*.webp",
                "--include",
                "tiles/*/*/*/*.png",
                "--endpoint-url",
                r2_endpoint,
            ]
        )
    else:
        print(f"No existing Level II R2 output for {site}; rendering fresh.", flush=True)

    run(
        [
            sys.executable,
            "scripts/radar/render_level2_reflectivity.py",
            "--site",
            site,
            "--fetch-latest",
            "--source-count",
            source_count,
            "--max-sources",
            frame_count,
        ]
    )

    # Upload heavy radar assets first. Keep manifests out until all assets exist.
    run(
        [
            "aws",
            "s3",
            "sync",
            str(local_dir),
            remote_dir,
            "--exclude",
            "*",
            "--include",
            "*.tif",
            "--include",
            "mobile/*.webp",
            "--include",
            "tiles/*/*/*/*.png",
            "--delete",
            "--endpoint-url",
            r2_endpoint,
        ]
    )

    # Publish manifests last. Browsers treat these as the source of truth.
    run(
        [
            "aws",
            "s3",
            "cp",
            str(local_dir / "frames.json"),
            f"{remote_dir}/frames.json",
            "--cache-control",
            "no-cache, no-store, must-revalidate",
            "--content-type",
            "application/json",
            "--endpoint-url",
            r2_endpoint,
        ]
    )

    run(
        [
            "aws",
            "s3",
            "cp",
            str(local_dir / "latest.json"),
            f"{remote_dir}/latest.json",
            "--cache-control",
            "no-cache, no-store, must-revalidate",
            "--content-type",
            "application/json",
            "--endpoint-url",
            r2_endpoint,
        ]
    )

    print(f"Level II Batch renderer finished for {site}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())