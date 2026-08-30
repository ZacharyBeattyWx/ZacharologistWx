from pathlib import Path

root = Path('.')

# Suppress the legacy MRMS live frame from the instant it is created on homepage mode.
p = root / 'mosaic-radar-canvas-test.html'
s = p.read_text(encoding='utf-8')
old = '      radarLayer.opacity = Number(opacityInput.value);\n      radarLayer.visible = radarVisible;'
new = '''      radarLayer.opacity = Number(opacityInput.value);\n      const suppressMrmsForLiveNexrad = new URLSearchParams(window.location.search).get("home") === "1";\n      radarLayer.visible = radarVisible && !suppressMrmsForLiveNexrad;'''
if old not in s:
    raise SystemExit('MRMS initial visibility anchor not found')
s = s.replace(old, new, 1)
s = s.replace('nexrad-main-live-overlay.js?v=20260830b', 'nexrad-main-live-overlay.js?v=20260830c')
p.write_text(s, encoding='utf-8')

# Keep MRMS hidden while the live NEXRAD tiles are warming on homepage mode,
# but restore it for history/playback or if the live manifest never becomes available.
p = root / 'scripts/radar/nexrad-main-live-overlay.js'
s = p.read_text(encoding='utf-8')
s = s.replace(
    '  const params = new URLSearchParams(window.location.search);\n',
    '  const params = new URLSearchParams(window.location.search);\n  const HOME_MODE = params.get("home") === "1";\n',
    1,
)
old = '''        const sharpReady = this.ready(this.wantedDesired) || this.ready(this.wantedBase);\n        radarLayer?.setVisible(!sharpReady && radarVisible);'''
new = '''        const sharpReady = this.ready(this.wantedDesired) || this.ready(this.wantedBase);\n        if (HOME_MODE) {\n          // Never flash the coarse MRMS live frame underneath the homepage radar.\n          // Keep the basemap visible until a complete static NEXRAD set is ready.\n          radarLayer?.setVisible(false);\n        } else {\n          radarLayer?.setVisible(!sharpReady && radarVisible);\n        }'''
if old not in s:
    raise SystemExit('overlay visibility anchor not found')
s = s.replace(old, new, 1)
old = '''    installed = true;\n    overlay = createOverlay(manifest);'''
new = '''    installed = true;\n    if (HOME_MODE) radarLayer?.setVisible(false);\n    overlay = createOverlay(manifest);'''
if old not in s:
    raise SystemExit('overlay install anchor not found')
s = s.replace(old, new, 1)
old = '''  async function tryInstall() {\n    if (installed) return;\n    if (!ready()) {\n      if (Date.now() - STARTED_AT < INSTALL_TIMEOUT_MS) window.setTimeout(tryInstall, 100);\n      return;\n    }\n    try {\n      const manifest = await fetchManifest();\n      if (manifest) {\n        await install(manifest);\n        return;\n      }\n    } catch (error) {\n      console.warn("Static NEXRAD live overlay unavailable", error);\n    }\n    if (Date.now() - STARTED_AT < INSTALL_TIMEOUT_MS) window.setTimeout(tryInstall, 1000);\n  }'''
new = '''  async function tryInstall() {\n    if (installed) return;\n    const elapsed = Date.now() - STARTED_AT;\n    if (!ready()) {\n      if (elapsed < INSTALL_TIMEOUT_MS) {\n        window.setTimeout(tryInstall, 100);\n      } else if (HOME_MODE && typeof radarLayer !== "undefined" && radarLayer) {\n        radarLayer.setVisible(radarVisible);\n        console.warn("Static NEXRAD startup timed out; restored MRMS fallback");\n      }\n      return;\n    }\n    try {\n      const manifest = await fetchManifest();\n      if (manifest) {\n        await install(manifest);\n        return;\n      }\n    } catch (error) {\n      console.warn("Static NEXRAD live overlay unavailable", error);\n    }\n    if (Date.now() - STARTED_AT < INSTALL_TIMEOUT_MS) {\n      window.setTimeout(tryInstall, 1000);\n    } else if (HOME_MODE) {\n      radarLayer?.setVisible(radarVisible);\n      console.warn("Static NEXRAD manifest unavailable; restored MRMS fallback");\n    }\n  }'''
if old not in s:
    raise SystemExit('tryInstall anchor not found')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')

# Force the homepage iframe to the no-flash revision.
p = root / 'index.html'
s = p.read_text(encoding='utf-8')
s = s.replace('mosaic-radar-canvas-test.html?home=1&v=20260830b', 'mosaic-radar-canvas-test.html?home=1&v=20260830c')
p.write_text(s, encoding='utf-8')

print('Homepage radar now starts basemap -> sharp NEXRAD with no MRMS live-frame flash')
