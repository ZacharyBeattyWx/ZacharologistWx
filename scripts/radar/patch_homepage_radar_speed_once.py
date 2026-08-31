from pathlib import Path

replacements = {
    Path("scripts/radar/mrms-timelapse-playback-v2.js"): [
        ("const TIMELAPSE_TRANSITION_MS = 55;", "const TIMELAPSE_TRANSITION_MS = 42;"),
        ("const TIMELAPSE_END_HOLD_MS = 250;", "const TIMELAPSE_END_HOLD_MS = 180;"),
        (
            "// Scale 2x stride with the selected history: 3h=1, 6h=2, 12h=4, 18h=6, 24h=8.",
            "// Keep 2x visibly faster while scaling stride with history: 1h=2, 3h=2, 6h=3, 12h=6, 18h+=8."
        ),
        (
            "const proportionalStride = Math.max(1, Math.round(selectedMinutes / 180));",
            "const proportionalStride = Math.max(2, Math.round(selectedMinutes / 120));"
        ),
    ],
    Path("scripts/radar/mrms-playback-performance.js"): [
        ("const FAST_LOOKAHEAD = 4;", "const FAST_LOOKAHEAD = 5;"),
        (
            "const proportionalStride = Math.max(1, Math.round(selectedMinutes / 180));",
            "const proportionalStride = Math.max(2, Math.round(selectedMinutes / 120));"
        ),
    ],
    Path("mapbox-token.js"): [
        (
            "scripts/radar/mrms-timelapse-playback-v2.js?v=20260830d",
            "scripts/radar/mrms-timelapse-playback-v2.js?v=20260830e"
        ),
        (
            "scripts/radar/mrms-playback-performance.js?v=20260830a",
            "scripts/radar/mrms-playback-performance.js?v=20260830b"
        ),
    ],
    Path("mosaic-radar-canvas-test.html"): [
        ("mapbox-token.js?v=20260830f", "mapbox-token.js?v=20260830g"),
    ],
    Path("index.html"): [
        (
            "mosaic-radar-canvas-test.html?home=1&v=20260830e",
            "mosaic-radar-canvas-test.html?home=1&v=20260830f"
        ),
    ],
}

changed = []
for path, pairs in replacements.items():
    text = path.read_text(encoding="utf-8")
    original = text
    for old, new in pairs:
        if old not in text:
            raise RuntimeError(f"Expected text not found in {path}: {old}")
        text = text.replace(old, new)
    if text != original:
        path.write_text(text, encoding="utf-8")
        changed.append(str(path))

print("Updated:", ", ".join(changed) if changed else "nothing")
