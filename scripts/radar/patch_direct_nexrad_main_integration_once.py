from pathlib import Path

root = Path('.')

# 1) Load the live NEXRAD overlay directly from the main radar document.
p = root / 'mosaic-radar-canvas-test.html'
s = p.read_text(encoding='utf-8')
s = s.replace('mapbox-token.js?v=20260829b', 'mapbox-token.js?v=20260830b')
needle = '  </script>\n</body>\n</html>'
replacement = '  </script>\n  <script src="scripts/radar/nexrad-main-live-overlay.js?v=20260830b"></script>\n</body>\n</html>'
if 'nexrad-main-live-overlay.js' not in s:
    if needle not in s:
        raise SystemExit('main radar closing-script anchor not found')
    s = s.replace(needle, replacement, 1)
p.write_text(s, encoding='utf-8')

# 2) Remove the async overlay injection from mapbox-token.js. The radar document
# now owns this integration directly, so there is no loader race or duplicate layer.
p = root / 'mapbox-token.js'
s = p.read_text(encoding='utf-8')
block = '''\n  const liveOverlay = document.createElement("script");\n  liveOverlay.src = "scripts/radar/nexrad-main-live-overlay.js?v=20260830a";\n  liveOverlay.async = true;\n  document.head.appendChild(liveOverlay);\n'''
if block in s:
    s = s.replace(block, '\n', 1)
s = s.replace('mrms-timelapse-playback-v2.js?v=20260829b', 'mrms-timelapse-playback-v2.js?v=20260830b')
s = s.replace('mrms-homepage-mode.js?v=20260829b', 'mrms-homepage-mode.js?v=20260830b')
p.write_text(s, encoding='utf-8')

# 3) Force the homepage iframe itself onto the newly integrated radar document.
p = root / 'index.html'
s = p.read_text(encoding='utf-8')
s = s.replace('mosaic-radar-canvas-test.html?home=1&v=20260829b', 'mosaic-radar-canvas-test.html?home=1&v=20260830b')
p.write_text(s, encoding='utf-8')

print('Direct NEXRAD main-radar integration applied; cache versions bumped to 20260830b')
