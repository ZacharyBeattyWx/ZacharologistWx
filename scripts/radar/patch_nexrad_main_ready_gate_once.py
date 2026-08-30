from pathlib import Path

p = Path('scripts/radar/nexrad-main-live-overlay.js')
s = p.read_text(encoding='utf-8')
old = '''        typeof opacityInput !== "undefined" &&
        map && typeof map.addLayer === "function"
      );'''
new = '''        typeof opacityInput !== "undefined" &&
        map && typeof map.addLayer === "function" &&
        typeof map.isStyleLoaded === "function" && map.isStyleLoaded() &&
        radarLayer &&
        Array.isArray(frames) && frames.length > 0
      );'''
if old not in s:
    raise SystemExit('ready gate anchor not found')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
print('NEXRAD main overlay now waits for loaded Mapbox style + MRMS layer + frames')
