from pathlib import Path

replacements = {
    Path("mosaic-radar-canvas-test.html"): [
        ("mapbox-token.js?v=20260830b", "mapbox-token.js?v=20260830e"),
    ],
    Path("index.html"): [
        ("mosaic-radar-canvas-test.html?home=1&v=20260830d", "mosaic-radar-canvas-test.html?home=1&v=20260830e"),
    ],
}

changed = []
for path, pairs in replacements.items():
    text = path.read_text(encoding="utf-8")
    original = text
    for old, new in pairs:
        text = text.replace(old, new)
    if text != original:
        path.write_text(text, encoding="utf-8")
        changed.append(str(path))

print("Updated:", ", ".join(changed) if changed else "nothing")
