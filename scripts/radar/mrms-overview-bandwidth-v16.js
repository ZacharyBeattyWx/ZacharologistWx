(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_OVERVIEW_BANDWIDTH_V16__) return;
  window.__ZWX_MRALA_OVERVIEW_BANDWIDTH_V16__ = true;

  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const OVERVIEW_RE = /\/mrms-native-numeric\/overview\//i;
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // The core page still asks for an 18-frame overview runway on desktop.
  // v16 virtualizes only the far-away hasTexture() checks so the core keeps
  // its existing playback clock while network/GPU work is limited to this
  // much smaller speed-aware rolling window.
  const FETCH_CONCURRENCY = MOBILE ? 2 : 3;
  const BACKFILL = 1;

  const DEPTH_BY_SPEED = new Map([
    ["0.5×", MOBILE ? 2 : 3],
    ["1×", MOBILE ? 3 : 5],
    ["1.5×", MOBILE ? 4 : 6],
    ["2×", MOBILE ? 5 : 8]
  ]);

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxOverviewBandwidthV16Installed) return;
  mapPrototype.__zwxOverviewBandwidthV16Installed = true;

  let overviewLayer = null;
  let activeFetches = 0;
  const fetchWaiters = [];
  const previousFetch = window.fetch.bind(window);

  function isOverviewUrl(input) {
    const url = String(typeof input === "string" ? input : input?.url || "");
    return OVERVIEW_RE.test(url);
  }

  function speedLabel() {
    return String(
      document.getElementById("speedSelect")?.selectedOptions?.[0]?.textContent ||
      "1×"
    ).trim();
  }

  function desiredDepth() {
    return DEPTH_BY_SPEED.get(speedLabel()) || (MOBILE ? 3 : 5);
  }

  function frameMs(frame) {
    return Date.parse(frame?.valid_time || frame?.validTime || "");
  }

  function unavailableIds() {
    return window.__ZWX_MRALA_UNAVAILABLE_FRAME_IDS__ || new Set();
  }

  function recentManifestFrames() {
    const manifest = window.__ZWX_MRALA_RUNTIME_MANIFEST__;
    const frames = Array.isArray(manifest?.frames) ? manifest.frames : [];
    const valid = frames
      .filter(frame => frame?.id && Number.isFinite(frameMs(frame)))
      .sort((a, b) => frameMs(a) - frameMs(b));

    if (!valid.length) return [];
    const newest = frameMs(valid[valid.length - 1]);
    const cutoff = newest - 3 * 60 * 60 * 1000;
    return valid.filter(frame => frameMs(frame) >= cutoff);
  }

  function playbackFrames() {
    const all = recentManifestFrames();
    if (!all.length) return all;

    const filtered = all.filter(
      frame => !unavailableIds().has(String(frame.id))
    );

    const slider = document.getElementById("frameSlider");
    const domCount = Number(slider?.max) + 1;

    // During the short interval before the core manifest refresh removes a
    // retired frame, its slider can still represent the unfiltered array.
    if (Number.isFinite(domCount) && domCount === all.length) return all;
    if (Number.isFinite(domCount) && domCount === filtered.length) return filtered;
    return filtered.length ? filtered : all;
  }

  function frameIdFromKey(key) {
    const text = String(key || "");
    return text.startsWith("overview:") ? text.slice("overview:".length) : "";
  }

  function isPlaying() {
    return /Pause/i.test(
      String(document.getElementById("playPause")?.textContent || "")
    );
  }

  function anchorIndex(frames) {
    if (!frames.length) return -1;

    // While playing, the active GPU key is authoritative and does not lag a
    // fast presentation tick. While paused, prefer the slider so scrubbing to
    // a distant observation immediately makes that observation real/fetchable.
    if (isPlaying()) {
      const activeId = frameIdFromKey(overviewLayer?.activeKey);
      const activeIndex = frames.findIndex(
        frame => String(frame.id) === activeId
      );
      if (activeIndex >= 0) return activeIndex;
    }

    const sliderIndex = Math.round(
      Number(document.getElementById("frameSlider")?.value)
    );
    if (Number.isFinite(sliderIndex)) {
      return Math.max(0, Math.min(frames.length - 1, sliderIndex));
    }

    const activeId = frameIdFromKey(overviewLayer?.activeKey);
    const activeIndex = frames.findIndex(
      frame => String(frame.id) === activeId
    );
    return activeIndex >= 0 ? activeIndex : frames.length - 1;
  }

  function realOverviewKeys() {
    const frames = playbackFrames();
    const keys = new Set();
    if (!frames.length) return keys;

    const anchor = anchorIndex(frames);
    if (anchor < 0) return keys;

    const unavailable = unavailableIds();
    const wanted = desiredDepth();

    // One frame behind keeps manual Previous and interpolation recovery cheap.
    let back = anchor;
    for (let attempt = 0; attempt < frames.length; attempt += 1) {
      back = (back - 1 + frames.length) % frames.length;
      const frame = frames[back];
      if (!unavailable.has(String(frame.id))) {
        keys.add("overview:" + String(frame.id));
        break;
      }
    }

    let cursor = anchor;
    let added = 0;
    const seen = new Set();
    while (added < Math.min(wanted, frames.length) && !seen.has(cursor)) {
      seen.add(cursor);
      const frame = frames[cursor];
      if (!unavailable.has(String(frame.id))) {
        keys.add("overview:" + String(frame.id));
        added += 1;
      }
      cursor = (cursor + 1) % frames.length;
    }

    return keys;
  }

  function acquireFetchSlot() {
    return new Promise(resolve => {
      if (activeFetches < FETCH_CONCURRENCY) {
        activeFetches += 1;
        resolve();
        return;
      }
      fetchWaiters.push(resolve);
    });
  }

  function releaseFetchSlot() {
    const next = fetchWaiters.shift();
    if (next) {
      // Hand this exact occupied slot to the next waiter. Do not decrement and
      // re-increment around the handoff or a new fetch can slip through.
      next();
      return;
    }
    activeFetches = Math.max(0, activeFetches - 1);
  }

  // Hold the slot until the response body has actually arrived. Limiting only
  // fetch() promise creation would release at headers and still allow many
  // large overview bodies to transfer in parallel.
  window.fetch = async function(input, init) {
    if (!isOverviewUrl(input)) {
      return previousFetch(input, init);
    }

    await acquireFetchSlot();
    try {
      const response = await previousFetch(input, init);
      if (!response.ok) return response;

      const body = await response.arrayBuffer();
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.set("content-length", String(body.byteLength));

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } finally {
      releaseFetchSlot();
    }
  };

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (layer?.id !== OVERVIEW_ID || layer.__zwxOverviewBandwidthV16Patched) {
      return result;
    }

    layer.__zwxOverviewBandwidthV16Patched = true;
    overviewLayer = layer;

    const originalHasTexture = layer.hasTexture;
    const originalEvictExcept = layer.evictExcept;
    const originalTrimTo = layer.trimTo;

    if (typeof originalHasTexture === "function") {
      layer.hasTexture = function(key) {
        const text = String(key || "");
        const actual = originalHasTexture.call(this, text);
        if (actual || !text.startsWith("overview:")) return actual;

        const frames = playbackFrames();
        if (!frames.length) return actual;

        const frameId = frameIdFromKey(text);
        if (!frames.some(frame => String(frame.id) === frameId)) return actual;

        // Only near-playhead frames are allowed to trigger real downloads.
        // Far frames report a virtual hit to the legacy 18-frame core buffer;
        // they become real automatically as the rolling window reaches them.
        return !realOverviewKeys().has(text);
      };
    }

    if (typeof originalEvictExcept === "function") {
      layer.evictExcept = function() {
        const keep = realOverviewKeys();
        if (this.activeKey) keep.add(String(this.activeKey));
        if (this.nextKey) keep.add(String(this.nextKey));
        return originalEvictExcept.call(this, keep);
      };
    }

    if (typeof originalTrimTo === "function") {
      layer.trimTo = function(_limit, _keep) {
        const keep = realOverviewKeys();
        if (this.activeKey) keep.add(String(this.activeKey));
        if (this.nextKey) keep.add(String(this.nextKey));
        const cap = Math.max(3, keep.size + BACKFILL);
        return originalTrimTo.call(this, cap, keep);
      };
    }

    window.__ZWX_MRALA_OVERVIEW_BANDWIDTH_STATE__ = () => ({
      speed: speedLabel(),
      depth: desiredDepth(),
      fetchConcurrency: FETCH_CONCURRENCY,
      realKeys: [...realOverviewKeys()],
      residentTextures: Number(this.textures?.size || 0)
    });

    console.info(
      "MRALA overview bandwidth v16:",
      "speed-aware rolling runway",
      "• " + desiredDepth() + " active frames at " + speedLabel(),
      "• " + FETCH_CONCURRENCY + " max overview transfers",
      "• legacy 18-frame far prefetch virtualized"
    );

    return result;
  };

  window.addEventListener("DOMContentLoaded", () => {
    const speed = document.getElementById("speedSelect");
    speed?.addEventListener("change", () => {
      if (!overviewLayer) return;
      overviewLayer.evictExcept?.(realOverviewKeys());
      console.info(
        "MRALA overview bandwidth v16:",
        desiredDepth() + "-frame runway for " + speedLabel()
      );
    });
  }, { once: true });
})();
