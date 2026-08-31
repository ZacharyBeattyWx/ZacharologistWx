from pathlib import Path

path = Path("mosaic-radar-canvas-test.html")
text = path.read_text(encoding="utf-8")
updated = text.replace("mapbox-token.js?v=20260830d", "mapbox-token.js?v=20260830f")
if updated != text:
    path.write_text(updated, encoding="utf-8")
    print("Updated mosaic radar token cache version")
else:
    print("No token cache version change needed")
