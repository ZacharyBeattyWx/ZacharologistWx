(() => {
  "use strict";

  const API_URL = "https://mesonet.agron.iastate.edu/json/radar.py";
  const TILE_ROOT = "https://mesonet.agron.iastate.edu/c/tile.py/1.0.0";
  const PRODUCT = "N0B";
  const SOURCE_ID = "nexrad-site-detail-source";
  const LAYER_ID = "nexrad-site-detail-layer";
  const NATIVE_DETAIL_LAYER_ID = "mrms-native-detail-overlay";

  const MOBILE_DEVICE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Keep the public IEM service confined to genuinely deep zoom. MRMS remains
  // the scalable nationwide/regional renderer and instant fallback.
  const ENTER_SITE_ZOOM = MOBILE_DEVICE ? 7.0 : 6.6;
  const EXIT_SITE_ZOOM = MOBILE_DEVICE ? 6.6 : 6.2;
  const MAX_SCAN_AGE_MS = 12 * 60 * 1000;
  const FUTURE_SCAN_TOLERANCE_MS = 2 * 60 * 1000;
  const API_REFRESH_MS = 60 * 1000;
  const FRAME_POLL_MS = MOBILE_DEVICE ? 120 : 75;
  const MOVE_REFRESH_MS = MOBILE_DEVICE ? 650 : 450;
  const INSTALL_RETRY_MS = 100;
  const INSTALL_TIMEOUT_MS = 20000;

  let installed = false;
  let siteMode = false;
  let siteOwnsVisual = false;
  let currentSite = null;
  let scans = [];
  let scansStartMs = 0;
  let scansEndMs = 0;
  let currentScanStamp = "";
  let lastFrameIndex = -1;
  let lastFramesSignature = "";
  let selectionGeneration = 0;
  let frameTimer = null;
  let scanRefreshTimer = null;
  let moveTimer = null;
  let installTimer = null;
  let installStartedAt = Date.now();

  function ready() {
    try {
      return (
        typeof map !== "undefined" &&
        map &&
        typeof map.addSource === "function" &&
        typeof map.addLayer === "function" &&
        typeof map.getZoom === "function" &&
        typeof map.isStyleLoaded === "function" &&
        map.isStyleLoaded() &&
        typeof frames !== "undefined" &&
        Array.isArray(frames) &&
        frames.length > 0 &&
        typeof currentFrameIndex !== "undefined" &&
        typeof radarVisible !== "undefined" &&
        typeof radarLayer !== "undefined" &&
        radarLayer
      );
    } catch (_) {
      return false;
    }
  }

  function firstSymbolLayerId() {
    try {
      return map
        .getStyle()
        ?.layers
        ?.find(layer => layer.type === "symbol")
        ?.id || null;
    } catch (_) {
      return null;
    }
  }

  function frameTimeMs(frame) {
    if (!frame) return NaN;

    const direct =
      frame.valid_time ||
      frame.validTime ||
      frame.time ||
      frame.timestamp;

    if (direct) {
      const parsed = Date.parse(String(direct));
      if (Number.isFinite(parsed)) return parsed;
    }

    const id = String(frame.id || frame.revision || "");
    const match = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
    if (!match) return NaN;

    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6])
    );
  }

  function timelineRange() {
    const values = frames
      .map(frameTimeMs)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    if (!values.length) return null;

    return {
      startMs: values[0],
      endMs: values[values.length - 1]
    };
  }

  function framesSignature() {
    const range = timelineRange();
    if (!range) return "";
    return [frames.length, range.startMs, range.endMs].join(":");
  }

  function isoMinute(ms) {
    return new Date(ms).toISOString().slice(0, 16) + "Z";
  }

  function tileStamp(ms) {
    const d = new Date(ms);
    const pad = value => String(value).padStart(2, "0");
    return (
      d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes())
    );
  }

  function tileUrl(siteId, stamp) {
    return (
      TILE_ROOT +
      "/ridge::" +
      encodeURIComponent(siteId) +
      "-" +
      PRODUCT +
      "-" +
      stamp +
      "/{z}/{x}/{y}.png"
    );
  }

  async function fetchJson(params) {
    const url = new URL(API_URL);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });

    const response = await fetch(url.toString(), {
      cache: "no-store",
      mode: "cors"
    });

    if (!response.ok) {
      throw new Error("IEM radar API HTTP " + response.status);
    }

    return await response.json();
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = value => (Number(value) * Math.PI) / 180;
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const dLat = toRad(Number(lat2) - Number(lat1));
    const dLon = toRad(Number(lon2) - Number(lon1));
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function normalizeRadarCandidates(payload, center) {
    const raw = Array.isArray(payload?.radars) ? payload.radars : [];

    return raw
      .filter(item => {
        const id = String(item?.id || "").trim().toUpperCase();
        const type = String(item?.type || "").trim().toUpperCase();
        return (
          id &&
          id !== "USCOMP" &&
          type === "NEXRAD" &&
          Number.isFinite(Number(item?.lat)) &&
          Number.isFinite(Number(item?.lon))
        );
      })
      .map(item => ({
        id: String(item.id).trim().toUpperCase().replace(/^K(?=[A-Z0-9]{3}$)/, ""),
        name: String(item.name || item.id || "NEXRAD"),
        lat: Number(item.lat),
        lon: Number(item.lon),
        type: "NEXRAD",
        distanceKm: haversineKm(center.lat, center.lng, item.lat, item.lon)
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  async function nearestRadar(center, atMs) {
    const query = {
      operation: "available",
      lat: center.lat.toFixed(4),
      lon: center.lng.toFixed(4),
      start: isoMinute(atMs)
    };

    let payload = await fetchJson(query);
    let candidates = normalizeRadarCandidates(payload, center);

    // IEM's location query intentionally considers a finite nearby radius.
    // Sparse western coverage can therefore return no WSR-88D even though a
    // farther site is still useful. Fall back to the day's full available list.
    if (!candidates.length) {
      payload = await fetchJson({
        operation: "available",
        start: isoMinute(atMs)
      });
      candidates = normalizeRadarCandidates(payload, center);
    }

    return candidates[0] || null;
  }

  async function loadScans(site, range) {
    if (!site || !range) return [];

    const startMs = range.startMs - MAX_SCAN_AGE_MS;
    const endMs = range.endMs + FUTURE_SCAN_TOLERANCE_MS + 60 * 1000;

    const payload = await fetchJson({
      operation: "list",
      radar: site.id,
      product: PRODUCT,
      start: isoMinute(startMs),
      end: isoMinute(endMs)
    });

    const found = (Array.isArray(payload?.scans) ? payload.scans : [])
      .map(item => Date.parse(String(item?.ts || item?.time || item || "")))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    const unique = [...new Set(found)];
    scansStartMs = startMs;
    scansEndMs = endMs;
    return unique;
  }

  function scanForFrame(ms) {
    if (!Number.isFinite(ms) || !scans.length) return null;

    let low = 0;
    let high = scans.length - 1;
    let preceding = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (scans[mid] <= ms) {
        preceding = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (preceding >= 0) {
      const candidate = scans[preceding];
      if (ms - candidate <= MAX_SCAN_AGE_MS) return candidate;
    }

    const nextIndex = preceding + 1;
    if (nextIndex >= 0 && nextIndex < scans.length) {
      const candidate = scans[nextIndex];
      if (candidate - ms <= FUTURE_SCAN_TOLERANCE_MS) return candidate;
    }

    return null;
  }

  function opacityValue() {
    try {
      if (typeof opacityInput !== "undefined" && opacityInput) {
        return Math.max(0, Math.min(1, Number(opacityInput.value) || 0));
      }
    } catch (_) {}
    return 1;
  }

  function ensureSourceAndLayer(initialUrl) {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: "raster",
        tiles: [initialUrl],
        tileSize: 256,
        scheme: "xyz",
        attribution: "NEXRAD Level III imagery: Iowa Environmental Mesonet"
      });
    }

    if (!map.getLayer(LAYER_ID)) {
      const layer = {
        id: LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        minzoom: EXIT_SITE_ZOOM,
        layout: {
          visibility: "none"
        },
        paint: {
          "raster-opacity": opacityValue(),
          "raster-fade-duration": 0,
          "raster-resampling": "nearest"
        }
      };

      const beforeId = firstSymbolLayerId();
      if (beforeId) {
        map.addLayer(layer, beforeId);
      } else {
        map.addLayer(layer);
      }
    }
  }

  function setNativeLayerVisible(visible) {
    try {
      if (map.getLayer(NATIVE_DETAIL_LAYER_ID)) {
        map.setLayoutProperty(
          NATIVE_DETAIL_LAYER_ID,
          "visibility",
          visible ? "visible" : "none"
        );
        return true;
      }
    } catch (_) {}
    return false;
  }

  function releaseVisualOwnership() {
    if (map.getLayer(LAYER_ID)) {
      map.setLayoutProperty(LAYER_ID, "visibility", "none");
    }

    siteOwnsVisual = false;

    const nativeExists = setNativeLayerVisible(true);
    if (nativeExists) {
      map.triggerRepaint();
    } else {
      try {
        radarLayer?.setVisible(Boolean(radarVisible));
      } catch (_) {}
    }
  }

  function claimVisualOwnership() {
    if (!siteMode || !radarVisible || !map.getLayer(LAYER_ID)) {
      releaseVisualOwnership();
      return false;
    }

    setNativeLayerVisible(false);
    try {
      radarLayer?.setVisible(false);
    } catch (_) {}

    map.setLayoutProperty(LAYER_ID, "visibility", "visible");
    map.setPaintProperty(LAYER_ID, "raster-opacity", opacityValue());
    siteOwnsVisual = true;
    return true;
  }

  function updateTileScan(scanMs) {
    if (!currentSite || !Number.isFinite(scanMs)) {
      releaseVisualOwnership();
      return false;
    }

    const stamp = tileStamp(scanMs);
    const url = tileUrl(currentSite.id, stamp);

    ensureSourceAndLayer(url);

    if (stamp !== currentScanStamp) {
      const source = map.getSource(SOURCE_ID);
      if (source && typeof source.setTiles === "function") {
        source.setTiles([url]);
      }
      currentScanStamp = stamp;
    }

    return claimVisualOwnership();
  }

  function syncFrame(force = false) {
    if (!siteMode || !currentSite || !scans.length) {
      releaseVisualOwnership();
      return;
    }

    const index = Math.max(
      0,
      Math.min(frames.length - 1, Number(currentFrameIndex) || 0)
    );

    if (!force && index === lastFrameIndex) return;
    lastFrameIndex = index;

    const ms = frameTimeMs(frames[index]);
    const scanMs = scanForFrame(ms);

    if (!Number.isFinite(scanMs)) {
      releaseVisualOwnership();
      return;
    }

    updateTileScan(scanMs);
  }

  function zoomWantsSite() {
    const zoom = Number(map?.getZoom?.());
    if (!Number.isFinite(zoom)) return false;
    return siteMode ? zoom >= EXIT_SITE_ZOOM : zoom >= ENTER_SITE_ZOOM;
  }

  async function refreshScans(force = false) {
    if (!siteMode || !currentSite) return false;

    const range = timelineRange();
    if (!range) return false;

    const covered =
      scans.length &&
      range.startMs >= scansStartMs + MAX_SCAN_AGE_MS &&
      range.endMs <= scansEndMs - FUTURE_SCAN_TOLERANCE_MS;

    if (!force && covered) return true;

    const next = await loadScans(currentSite, range);
    if (!next.length) {
      scans = [];
      releaseVisualOwnership();
      return false;
    }

    scans = next;
    lastFrameIndex = -1;
    syncFrame(true);
    return true;
  }

  async function chooseSite(force = false) {
    if (!zoomWantsSite()) {
      siteMode = false;
      currentSite = null;
      scans = [];
      currentScanStamp = "";
      releaseVisualOwnership();
      return false;
    }

    siteMode = true;

    const range = timelineRange();
    if (!range) {
      releaseVisualOwnership();
      return false;
    }

    const center = map.getCenter();
    const generation = ++selectionGeneration;

    try {
      const candidate = await nearestRadar(center, range.endMs);
      if (generation !== selectionGeneration || !siteMode) return false;
      if (!candidate) {
        currentSite = null;
        scans = [];
        releaseVisualOwnership();
        return false;
      }

      const changed = !currentSite || currentSite.id !== candidate.id;
      currentSite = candidate;

      if (changed) {
        scans = [];
        scansStartMs = 0;
        scansEndMs = 0;
        currentScanStamp = "";
        lastFrameIndex = -1;
      }

      await refreshScans(force || changed);
      if (generation !== selectionGeneration || !siteMode) return false;

      console.info(
        "NEXRAD site detail: " +
          currentSite.id +
          " " +
          currentSite.name +
          " (" +
          Math.round(currentSite.distanceKm) +
          " km from map center, " +
          scans.length +
          " N0B scans)"
      );

      return scans.length > 0;
    } catch (error) {
      if (generation === selectionGeneration) {
        console.warn("NEXRAD site detail unavailable; retaining MRMS detail", error);
        releaseVisualOwnership();
      }
      return false;
    }
  }

  function refreshMode() {
    const wantsSite = zoomWantsSite();

    if (wantsSite && !siteMode) {
      chooseSite(true);
      return;
    }

    if (!wantsSite && siteMode) {
      siteMode = false;
      ++selectionGeneration;
      currentSite = null;
      scans = [];
      currentScanStamp = "";
      releaseVisualOwnership();
      return;
    }

    if (siteMode) {
      syncFrame(true);
    }
  }

  function scheduleMoveRefresh() {
    if (moveTimer) window.clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => {
      moveTimer = null;
      if (!zoomWantsSite()) {
        refreshMode();
        return;
      }
      chooseSite(false);
    }, MOVE_REFRESH_MS);
  }

  function frameTick() {
    if (!installed) return;

    const signature = framesSignature();
    if (signature && signature !== lastFramesSignature) {
      lastFramesSignature = signature;
      if (siteMode && currentSite) {
        refreshScans(false).catch(error => {
          console.warn("NEXRAD site scan refresh failed", error);
        });
      }
    }

    const index = Number(currentFrameIndex);
    if (index !== lastFrameIndex) {
      syncFrame();
    } else if (siteOwnsVisual && !radarVisible) {
      releaseVisualOwnership();
    } else if (siteMode && radarVisible && !siteOwnsVisual && currentSite && scans.length) {
      syncFrame(true);
    }
  }

  function install() {
    if (installed || !ready()) return false;
    installed = true;
    lastFramesSignature = framesSignature();

    map.on("zoomend", refreshMode);
    map.on("moveend", scheduleMoveRefresh);

    if (typeof opacityInput !== "undefined" && opacityInput) {
      opacityInput.addEventListener("input", () => {
        if (map.getLayer(LAYER_ID)) {
          map.setPaintProperty(LAYER_ID, "raster-opacity", opacityValue());
        }
      });
    }

    frameTimer = window.setInterval(frameTick, FRAME_POLL_MS);
    scanRefreshTimer = window.setInterval(() => {
      if (siteMode && currentSite) {
        refreshScans(false).catch(error => {
          console.warn("NEXRAD site periodic scan refresh failed", error);
        });
      }
    }, API_REFRESH_MS);

    window.addEventListener(
      "beforeunload",
      () => {
        if (frameTimer) window.clearInterval(frameTimer);
        if (scanRefreshTimer) window.clearInterval(scanRefreshTimer);
        if (moveTimer) window.clearTimeout(moveTimer);
        if (installTimer) window.clearTimeout(installTimer);
      },
      { once: true }
    );

    if (map.getZoom() >= ENTER_SITE_ZOOM) {
      chooseSite(true);
    }

    console.info(
      "NEXRAD site detail v1: deep-zoom IEM N0B tier armed at z" +
        ENTER_SITE_ZOOM.toFixed(1)
    );
    return true;
  }

  function tryInstall() {
    if (install()) return;

    if (Date.now() - installStartedAt >= INSTALL_TIMEOUT_MS) {
      console.warn("NEXRAD site detail did not find the radar map globals");
      return;
    }

    installTimer = window.setTimeout(tryInstall, INSTALL_RETRY_MS);
  }

  tryInstall();
})();
