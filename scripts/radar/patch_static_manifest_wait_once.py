from pathlib import Path

p = Path('scripts/radar/nexrad-static-pyramid-webgl.js')
s = p.read_text(encoding='utf-8')

old_fetch = '''  async function fetchManifest() {
    const response = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Static radar manifest HTTP ${response.status}`);
    const manifest = await response.json();
    manifest._url = new URL(MANIFEST_URL, window.location.href).href;
    return manifest;
  }'''
new_fetch = '''  async function fetchManifest() {
    const response = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Static radar manifest HTTP ${response.status}`);
    const manifest = await response.json();
    manifest._url = new URL(MANIFEST_URL, window.location.href).href;
    return manifest;
  }

  async function waitForFirstManifest() {
    while (true) {
      try {
        const manifest = await fetchManifest();
        if (manifest) return manifest;
        statusDot.classList.remove("bad", "live");
        statusText.textContent = "Building first pre-rendered radar snapshot…";
        modeTitle.textContent = "Static radar build in progress";
        modeDetail.textContent = "Waiting for the first complete pyramid; this page will load it automatically.";
        detailInfo.textContent = "pre-rendering…";
        nationalInfo.textContent = "waiting for first revision";
      } catch (error) {
        console.warn("Waiting for static radar manifest", error);
        statusDot.classList.remove("bad", "live");
        statusText.textContent = "Waiting for static radar builder…";
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }'''
if old_fetch not in s:
    raise SystemExit('fetchManifest anchor not found')
s = s.replace(old_fetch, new_fetch, 1)

old_initial = '''        const manifest = await fetchManifest();
        statusDot.classList.add("live");
        statusText.textContent = "Static Python-colored radar pyramid ready";'''
new_initial = '''        const manifest = await waitForFirstManifest();
        statusDot.classList.remove("bad");
        statusDot.classList.add("live");
        statusText.textContent = "Static Python-colored radar pyramid ready";'''
if old_initial not in s:
    raise SystemExit('initial manifest anchor not found')
s = s.replace(old_initial, new_initial, 1)

old_refresh = '''            const next = await fetchManifest();
            radarLayer.setManifest(next);'''
new_refresh = '''            const next = await fetchManifest();
            if (next) radarLayer.setManifest(next);'''
if old_refresh not in s:
    raise SystemExit('refresh manifest anchor not found')
s = s.replace(old_refresh, new_refresh, 1)

p.write_text(s, encoding='utf-8')
print('Static manifest startup now waits/polls instead of treating first-build 404 as fatal')
