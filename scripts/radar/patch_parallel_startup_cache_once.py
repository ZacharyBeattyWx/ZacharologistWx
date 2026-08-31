from pathlib import Path

updates = {
    Path("mosaic-radar-canvas-test.html"): [
        ("scripts/radar/nexrad-main-live-overlay.js?v=20260830c", "scripts/radar/nexrad-main-live-overlay.js?v=20260831a"),
    ],
    Path("index.html"): [
        ("mosaic-radar-canvas-test.html?home=1&v=20260830f", "mosaic-radar-canvas-test.html?home=1&v=20260831a"),
    ],
}

changed = []
for path, replacements in updates.items():
    text = path.read_text(encoding="utf-8")
    original = text
    for old, new in replacements:
        text = text.replace(old, new)
    if text != original:
        path.write_text(text, encoding="utf-8")
        changed.append(str(path))

print("Updated:", ", ".join(changed) if changed else "nothing")
