from pathlib import Path

# 1) Start MRMS network/decode work while Mapbox is still loading.
radar_path = Path("mosaic-radar-canvas-test.html")
text = radar_path.read_text(encoding="utf-8")
original = text

text = text.replace(
    "    let manifestRefreshBusy = false;\n    let defaultFrameIntervalMs = 650;",
    "    let manifestRefreshBusy = false;\n    let defaultFrameIntervalMs = 650;\n    let initialRadarStartupPromise = null;"
)

text = text.replace(
    "    async function installInitialManifest(nextManifest) {\n      clearFrameCaches();",
    "    async function installInitialManifest(nextManifest) {\n      // Preserve the frame decoded during parallel startup. Reloads still clear stale caches.\n      if (manifest) clearFrameCaches();"
)

old_load = '''    async function loadRadarLoop() {\n      stopPlayback();\n      try {\n        setStatus(\"Loading MRMS loop manifest…\");\n        const nextManifest = await fetchManifest();\n        await installInitialManifest(nextManifest);\n      } catch (error) {\n        console.error(error);\n        setStatus(`Loop load failed: ${error.message}`,\"error\");\n      }\n    }'''

new_load = '''    async function prepareInitialRadarStartup() {\n      const nextManifest = await fetchManifest();\n      const sorted = sortedManifestFrames(nextManifest);\n      const newest = sorted[sorted.length - 1];\n      if (newest) await loadFrameSource(newest, nextManifest);\n      return nextManifest;\n    }\n\n    async function loadRadarLoop() {\n      stopPlayback();\n      try {\n        setStatus(\"Loading MRMS loop manifest…\");\n        let nextManifest = null;\n        if (initialRadarStartupPromise) {\n          nextManifest = await initialRadarStartupPromise;\n          initialRadarStartupPromise = null;\n        }\n        if (!nextManifest) nextManifest = await fetchManifest();\n        await installInitialManifest(nextManifest);\n      } catch (error) {\n        console.error(error);\n        initialRadarStartupPromise = null;\n        setStatus(`Loop load failed: ${error.message}`,\"error\");\n      }\n    }'''
text = text.replace(old_load, new_load)

text = text.replace(
    '''    mapboxgl.accessToken = window.MAPBOX_PUBLIC_TOKEN;\n    const map = new mapboxgl.Map({''',
    '''    // Start radar I/O immediately so Mapbox and the first radar frame load in parallel.\n    initialRadarStartupPromise = prepareInitialRadarStartup().catch(error => {\n      console.warn(\"Parallel MRMS startup preload failed\", error);\n      return null;\n    });\n\n    mapboxgl.accessToken = window.MAPBOX_PUBLIC_TOKEN;\n    const map = new mapboxgl.Map({'''
)

if text == original:
    raise SystemExit("No mosaic radar startup replacements matched")
radar_path.write_text(text, encoding="utf-8")

# 2) On the public site, don't hide MRMS for 20 seconds while retrying a local-only NEXRAD pyramid.
overlay_path = Path("scripts/radar/nexrad-main-live-overlay.js")
overlay = overlay_path.read_text(encoding="utf-8")
overlay_original = overlay

overlay = overlay.replace(
    '  const INSTALL_TIMEOUT_MS = 20000;',
    '  const INSTALL_TIMEOUT_MS = 20000;\n  const LOCAL_STATIC_PYRAMID = ["localhost", "127.0.0.1"].includes(window.location.hostname);'
)

overlay = overlay.replace(
    '''      const manifest = await fetchManifest();\n      if (manifest) {\n        await install(manifest);\n        return;\n      }''',
    '''      const manifest = await fetchManifest();\n      if (manifest) {\n        await install(manifest);\n        return;\n      }\n      if (!LOCAL_STATIC_PYRAMID) {\n        // The generated static NEXRAD pyramid is currently a local/test artifact.\n        // On production, reveal the already-preloaded MRMS layer immediately instead\n        // of hiding radar while retrying a file that is not published.\n        if (HOME_MODE) radarLayer?.setVisible(radarVisible);\n        console.info(\"Static NEXRAD pyramid not published here; using immediate MRMS fallback\");\n        return;\n      }'''
)

if overlay == overlay_original:
    raise SystemExit("No NEXRAD fallback replacement matched")
overlay_path.write_text(overlay, encoding="utf-8")

print("Parallel radar startup + immediate production fallback patched")
