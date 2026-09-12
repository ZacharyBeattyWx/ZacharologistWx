(() => {
  "use strict";

  const path = String(location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path) || window.__ZWX_MRALA_ARCHIVE_PLAYBACK__) return;
  window.__ZWX_MRALA_ARCHIVE_PLAYBACK__ = true;

  const BASE = "https://dt0cd6bl1yqh2.cloudfront.net/mrms-native-numeric/";
  const MANIFEST_URL = BASE + "manifest.json";
  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const CHUNK_RE = /\/mrms-native-numeric\/native-chunks\//i;
  const ASSET_RE = /\/mrms-native-numeric\/(?:native-chunks|overview)\//i;
  const CHUNK_URL_RE = /\/native-chunks\/([^/]+)\/([^/?#]+)\.dbz(?:[?#]|$)/i;
  const OVERVIEW_URL_RE = /\/overview\/([^/?#]+)\.dbz(?:[?#]|$)/i;
  const LAYER_ID = "mrms-native-numeric-viewport-chunks";
  const HISTORY_MS = 3 * 60 * 60 * 1000;
  const CACHE_NAME = "zwx-mrala-rolling-archive-v2";
  const NATIVE_PREWARM_ZOOM = 5.15;

  const MOBILE = matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const MEM_GB = Math.max(2, Number(navigator.deviceMemory || 8));
  const GPU_BUDGET = Math.round(
    (MOBILE
      ? Math.min(256, Math.max(128, MEM_GB * 32))
      : Math.min(704, Math.max(384, MEM_GB * 88))) * 1048576
  );
  const MEM_BUDGET = GPU_BUDGET;
  const MIN_GPU_RUNWAY = MOBILE ? 6 : 12;
  const INITIAL_CONC = MOBILE ? 2 : 5;
  const REGION_CONC = MOBILE ? 2 : 5;
  const LIVE_CONC = MOBILE ? 1 : 3;

  let manifest = null;
  let memBytes = 0;
  let cachePromise = null;
  let writesAllowed = true;
  let lastPrune = 0;
  let pollTimer = 0;

  const mem = new Map();
  const pinnedUrls = new Set();
  const missing = new Set();
  const inflight = new Map();
  const previousFetch = fetch.bind(window);

  const urlOf = input => String(typeof input === "string" ? input : input?.url || "");
  const frameMs = frame => Date.parse(frame?.valid_time || frame?.validTime || "");
  const key = (frameId, chunkId) => String(frameId) + ":" + String(chunkId);
  const signature = ids => [...new Set((ids || []).map(String))].sort().join("|");

  function recent(source = manifest) {
    const all = Array.isArray(source?.frames) ? source.frames : [];
    if (!all.length) return [];
    const newest = all.reduce((value, frame) => {
      const ms = frameMs(frame);
      return Number.isFinite(ms) ? Math.max(value, ms) : value;
    }, 0);
    const cutoff = (newest || Date.now()) - HISTORY_MS;
    return all
      .filter(frame => frame?.id && frame?.nativeChunksReady && Number.isFinite(frameMs(frame)) && frameMs(frame) >= cutoff)
      .sort((a, b) => frameMs(a) - frameMs(b));
  }

  function chunkMap() {
    return new Map((manifest?.nativeChunking?.layout || []).map(chunk => [String(chunk.id), chunk]));
  }

  function chunkUrl(frameId, chunkId) {
    const template = String(
      manifest?.nativeChunking?.template || "native-chunks/{frameId}/{chunkId}.dbz"
    )
      .replace("{frameId}", encodeURIComponent(String(frameId)))
      .replace("{chunkId}", encodeURIComponent(String(chunkId)));
    return new URL(template, BASE).toString();
  }

  function assetFrameId(url) {
    const match = CHUNK_URL_RE.exec(String(url || "")) || OVERVIEW_URL_RE.exec(String(url || ""));
    if (!match) return "";
    try { return decodeURIComponent(match[1]); } catch { return String(match[1]); }
  }

  function trimMemory() {
    while (memBytes > MEM_BUDGET && mem.size > 1) {
      let evictUrl = null;
      for (const candidate of mem.keys()) {
        if (!pinnedUrls.has(candidate)) {
          evictUrl = candidate;
          break;
        }
      }
      if (!evictUrl) break;
      const bytes = mem.get(evictUrl);
      mem.delete(evictUrl);
      memBytes -= Number(bytes?.byteLength || 0);
    }
  }

  function putMem(url, bytes) {
    if (!(bytes instanceof ArrayBuffer)) return;
    const old = mem.get(url);
    if (old) {
      memBytes -= old.byteLength;
      mem.delete(url);
    }
    mem.set(url, bytes);
    memBytes += bytes.byteLength;
    trimMemory();
  }

  function getMem(url) {
    const bytes = mem.get(url);
    if (!bytes) return null;
    mem.delete(url);
    mem.set(url, bytes);
    return bytes;
  }

  function fallback(url) {
    const match = CHUNK_URL_RE.exec(String(url || ""));
    if (!match) return null;
    let chunkId = match[2];
    try { chunkId = decodeURIComponent(chunkId); } catch {}
    const chunk = chunkMap().get(String(chunkId));
    const expected = Number(chunk?.width || 0) * Number(chunk?.height || 0);
    return expected > 0 ? new Uint8Array(expected).buffer : null;
  }

  function responseFrom(bytes, source) {
    return new Response(bytes.slice(0), {
      status: 200,
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": "application/octet-stream",
        "x-zwx-native-cache": source
      }
    });
  }

  function markMissing(url, status) {
    if (missing.has(url)) return;
    missing.add(url);
    if (missing.size <= 5) console.warn("Native chunk unavailable; overview fallback", status, url);
    else if (missing.size === 6) console.warn("Additional missing native-chunk warnings suppressed");
  }

  async function disk() {
    if (!("caches" in window)) return null;
    if (!cachePromise) cachePromise = caches.open(CACHE_NAME).catch(() => null);
    return cachePromise;
  }

  async function diskResponse(url) {
    try { return (await disk())?.match(url) || null; } catch { return null; }
  }

  async function canWrite() {
    if (!writesAllowed) return false;
    if (!navigator.storage?.estimate) return true;
    try {
      const estimate = await navigator.storage.estimate();
      const quota = Number(estimate.quota || 0);
      const usage = Number(estimate.usage || 0);
      if (quota && usage / quota >= 0.72) {
        writesAllowed = false;
        console.warn("MRALA persistent cache paused at", Math.round(usage / quota * 100) + "% browser storage use");
        return false;
      }
    } catch {}
    return true;
  }

  async function persist(url, response) {
    if (!ASSET_RE.test(url) || !(await canWrite())) return;
    try { await (await disk())?.put(url, response.clone()); } catch {}
  }

  async function prune(force = false) {
    if (!manifest) return;
    const now = Date.now();
    if (!force && now - lastPrune < 10 * 60 * 1000) return;
    lastPrune = now;
    const valid = new Set(recent().map(frame => String(frame.id)));
    const cache = await disk();
    if (!cache || !valid.size) return;
    try {
      for (const request of await cache.keys()) {
        const url = String(request.url || "");
        if (!ASSET_RE.test(url)) continue;
        const frameId = assetFrameId(url);
        if (frameId && !valid.has(frameId)) {
          await cache.delete(request);
          const bytes = mem.get(url);
          if (bytes) {
            mem.delete(url);
            memBytes -= bytes.byteLength;
          }
        }
      }
    } catch {}
  }

  async function capture(nextManifest, source = "fetch") {
    const oldIds = new Set(recent().map(frame => String(frame.id)));
    manifest = nextManifest;
    window.__ZWX_MRALA_RUNTIME_MANIFEST__ = manifest;
    prune().catch(() => {});

    const layer = window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__;
    const nowFrames = recent();
    const added = nowFrames.filter(frame => !oldIds.has(String(frame.id)));

    if (layer) {
      layer.__zwxArchiveFrameIds = nowFrames.map(frame => String(frame.id));
      if (added.length && layer.__zwxRequestedVisibleIds?.length) {
        stageNew(layer, added).catch(() => {});
      }
      if (layer.enabled && layer.__zwxRequestedVisibleIds?.length) {
        scheduleRegion(layer, layer.__zwxRequestedVisibleIds, 0);
      }
    }

    if (added.length && source === "poll") {
      console.info("MRALA live edge:", added.length, "new scan(s) appended; previous history reused");
    }
  }

  window.fetch = async function (input, init) {
    const url = urlOf(input);

    if (ASSET_RE.test(url)) {
      if (CHUNK_RE.test(url)) {
        const memory = getMem(url);
        if (memory) return responseFrom(memory, missing.has(url) ? "missing-overview-fallback" : "archive-memory");
        if (missing.has(url)) {
          const noData = fallback(url);
          if (noData) {
            putMem(url, noData);
            return responseFrom(noData, "missing-overview-fallback");
          }
        }
      }

      const cached = await diskResponse(url);
      if (cached) {
        if (CHUNK_RE.test(url)) cached.clone().arrayBuffer().then(bytes => putMem(url, bytes)).catch(() => {});
        return cached;
      }
    }

    const response = await previousFetch(input, init);

    if (response.ok && MANIFEST_RE.test(url)) {
      try { await capture(await response.clone().json()); } catch {}
    } else if (response.ok && ASSET_RE.test(url)) {
      persist(url, response).catch(() => {});
      if (CHUNK_RE.test(url)) response.clone().arrayBuffer().then(bytes => putMem(url, bytes)).catch(() => {});
    } else if (CHUNK_RE.test(url) && (response.status === 403 || response.status === 404)) {
      const noData = fallback(url);
      if (noData) {
        markMissing(url, response.status);
        putMem(url, noData);
        return responseFrom(noData, "missing-overview-fallback");
      }
    }

    return response;
  };

  async function bytes(url) {
    const memory = getMem(url);
    if (memory) return memory;

    const cached = await diskResponse(url);
    if (cached) {
      const data = await cached.arrayBuffer();
      putMem(url, data);
      return data;
    }

    if (inflight.has(url)) return inflight.get(url);

    const promise = (async () => {
      const response = await window.fetch(url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`Native archive HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      putMem(url, data);
      return data;
    })();

    inflight.set(url, promise);
    try { return await promise; }
    finally { if (inflight.get(url) === promise) inflight.delete(url); }
  }

  async function raw(bytesValue, expected) {
    if (bytesValue.byteLength === expected) return new Uint8Array(bytesValue);
    const probe = new Uint8Array(bytesValue);
    if (probe[0] === 0x1f && probe[1] === 0x8b && typeof DecompressionStream !== "undefined") {
      const stream = new Blob([bytesValue]).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return probe;
  }

  function orderedFrames(layer, frames) {
    if (!frames.length) return [];
    let index = frames.findIndex(frame => String(frame.id) === String(layer?.fromFrame || ""));
    if (index < 0 || index === frames.length - 1) index = 0;
    const rotated = [...frames.slice(index), ...frames.slice(0, index)];
    const priority = new Set([layer?.fromFrame, layer?.toFrame].filter(Boolean).map(String));
    return [
      ...rotated.filter(frame => priority.has(String(frame.id))),
      ...rotated.filter(frame => !priority.has(String(frame.id)))
    ];
  }

  async function gpuTarget(layer, target, gpuPins) {
    const packed = await bytes(target.url);
    const textureKey = key(target.frame.id, target.chunk.id);
    if (!layer.textures.has(textureKey)) {
      const expected = Number(target.chunk.width) * Number(target.chunk.height);
      const unpacked = await raw(packed, expected);
      if (unpacked.byteLength !== expected) {
        throw new Error(`Archive ${target.chunk.id} size ${unpacked.byteLength} != ${expected}`);
      }
      layer.addTexture(target.frame.id, target.chunk, unpacked);
    }
    if (layer.textures.has(textureKey)) gpuPins?.add(textureKey);
  }

  function gpuPlan(frames, chunksForView) {
    const bytesPerFrame = chunksForView.reduce(
      (sum, chunk) => sum + Number(chunk.width || 0) * Number(chunk.height || 0),
      0
    );
    const frameLimit = Math.max(
      1,
      Math.min(frames.length, Math.floor(GPU_BUDGET / Math.max(1, bytesPerFrame)))
    );
    const full = frameLimit >= frames.length;
    const count = full
      ? frames.length
      : Math.max(1, Math.min(frameLimit, Math.max(MIN_GPU_RUNWAY, Math.floor(frameLimit * 0.85))));
    return { bytesPerFrame, frameLimit, full, count };
  }

  async function warmRegion(layer, ids, generation, progress) {
    if (!layer || !ids?.length || !manifest) return { ready: false };

    const byId = chunkMap();
    const chunksForView = ids.map(id => byId.get(String(id))).filter(Boolean);
    const frames = recent();
    if (!chunksForView.length || !frames.length) return { ready: false };

    layer.__zwxArchiveSessionActive = true;
    layer.__zwxArchiveFrameIds = frames.map(frame => String(frame.id));

    const ordered = orderedFrames(layer, frames);
    const plan = gpuPlan(frames, chunksForView);
    const gpuFrameIds = new Set(ordered.slice(0, plan.count).map(frame => String(frame.id)));
    const targets = [];
    for (const frame of ordered) {
      for (const chunk of chunksForView) {
        targets.push({ frame, chunk, url: chunkUrl(frame.id, chunk.id) });
      }
    }

    pinnedUrls.clear();
    for (const target of targets) pinnedUrls.add(target.url);

    const gpuPins = new Set();
    let cursor = 0;
    let completed = 0;
    let failed = 0;
    const started = performance.now();

    async function worker() {
      while (cursor < targets.length) {
        if (generation !== layer.__zwxRegionWarmGeneration) return;
        const target = targets[cursor++];
        try {
          if (gpuFrameIds.has(String(target.frame.id))) {
            await gpuTarget(layer, target, gpuPins);
          } else {
            await bytes(target.url);
          }
        } catch (error) {
          failed += 1;
          console.warn("MRALA native archive warm failed", target.frame?.id, target.chunk?.id, error);
        } finally {
          completed += 1;
          progress?.(completed, targets.length, plan.full);
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(REGION_CONC, targets.length) }, () => worker())
    );

    if (generation !== layer.__zwxRegionWarmGeneration) return { ready: false, superseded: true };
    if (failed) return { ready: false, failed };

    layer.__zwxPinnedGpuKeys = gpuPins;
    layer.__zwxRegionReadySignature = signature(ids);
    layer.__zwxFullGpuResident = plan.full;
    layer.__zwxGpuResidentFrames = plan.count;
    layer.map?.triggerRepaint();
    layer.__zwxSetArchiveSuppressed?.(false);

    pinnedUrls.clear();
    trimMemory();
    prune(true).catch(() => {});

    window.__ZWX_MRALA_ARCHIVE_SESSION__ = {
      revision: String(manifest?.revision || ""),
      frameIds: [...layer.__zwxArchiveFrameIds],
      regionSignature: layer.__zwxRegionReadySignature,
      fullGpuResident: plan.full,
      gpuFrames: plan.count,
      persistentCache: CACHE_NAME,
      startedAt: new Date().toISOString()
    };

    if (!pollTimer) pollTimer = setInterval(poll, 60 * 1000);

    console.info(
      "MRALA native region ready before playback:",
      frames.length + " frames",
      chunksForView.length + " chunks/frame",
      plan.full ? "FULL LOOP GPU-resident" : plan.count + " GPU frames + full local archive",
      Math.round(performance.now() - started) + " ms"
    );

    return { ready: true, fullGpuResident: plan.full, gpuFrames: plan.count };
  }

  function scheduleRegion(layer, ids, delay = 20, progress) {
    if (!layer || !ids?.length || !manifest) return Promise.resolve({ ready: false });
    const nextSignature = signature(ids);
    if (layer.__zwxRegionReadySignature === nextSignature) {
      return Promise.resolve({ ready: true, cached: true, fullGpuResident: layer.__zwxFullGpuResident });
    }

    const generation = ++layer.__zwxRegionWarmGeneration;
    clearTimeout(layer.__zwxRegionWarmTimer);

    const promise = new Promise(resolve => {
      layer.__zwxRegionWarmTimer = setTimeout(() => {
        warmRegion(layer, [...ids], generation, progress)
          .then(resolve)
          .catch(error => {
            console.warn("MRALA native archive region warm failed", error);
            resolve({ ready: false, error });
          });
      }, delay);
    });

    layer.__zwxRegionWarmPromise = promise;
    return promise;
  }

  function visibleChunkIds(map) {
    if (!map || !manifest?.nativeChunking?.layout?.length) return [];
    const bounds = map.getBounds?.();
    if (!bounds) return [];
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    return manifest.nativeChunking.layout
      .filter(chunk => {
        const b = chunk?.bounds;
        if (!Array.isArray(b) || b.length < 4) return false;
        const [cw, cs, ce, cn] = b.map(Number);
        return ce >= west && cw <= east && cn >= south && cs <= north;
      })
      .map(chunk => String(chunk.id));
  }

  function prewarmForCamera(layer) {
    if (!layer?.map || !manifest) return;
    if (Number(layer.map.getZoom?.() || 0) < NATIVE_PREWARM_ZOOM) return;
    const ids = visibleChunkIds(layer.map);
    if (!ids.length) return;
    scheduleRegion(layer, ids, 35);
  }

  async function stageNew(layer, newFrames) {
    const ids = [...(layer.__zwxRequestedVisibleIds || [])];
    if (!ids.length) return;
    const byId = chunkMap();
    const chunksForView = ids.map(id => byId.get(String(id))).filter(Boolean);
    if (!chunksForView.length) return;

    const validFrames = new Set(recent().map(frame => String(frame.id)));
    layer.__zwxArchiveFrameIds = [...validFrames];
    layer.__zwxPinnedGpuKeys = new Set(
      [...(layer.__zwxPinnedGpuKeys || [])].filter(textureKey => validFrames.has(String(textureKey).split(":")[0]))
    );

    const targets = [];
    for (const frame of newFrames) {
      for (const chunk of chunksForView) {
        targets.push({ frame, chunk, url: chunkUrl(frame.id, chunk.id) });
      }
    }

    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        try {
          if (layer.__zwxFullGpuResident) await gpuTarget(layer, target, layer.__zwxPinnedGpuKeys);
          else await bytes(target.url);
        } catch {}
      }
    }

    await Promise.all(Array.from({ length: Math.min(LIVE_CONC, targets.length) }, () => worker()));
    layer.map?.triggerRepaint();
  }

  async function poll() {
    try {
      const response = await previousFetch(`${MANIFEST_URL}?archivePoll=${Date.now()}`, { cache: "no-store" });
      if (response.ok) await capture(await response.json(), "poll");
    } catch (error) {
      console.warn("MRALA live-edge poll failed", error);
    }
  }

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer) return;
  const previousAddLayer = mapPrototype.addLayer;

  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (layer?.id !== LAYER_ID || layer.__zwxArchivePlaybackPatched) return result;

    layer.__zwxArchivePlaybackPatched = true;
    Object.assign(layer, {
      __zwxRequestedVisibleIds: [],
      __zwxViewportSignature: "",
      __zwxRegionReadySignature: "",
      __zwxArchiveSessionActive: false,
      __zwxArchiveFrameIds: [],
      __zwxPinnedGpuKeys: new Set(),
      __zwxFullGpuResident: false,
      __zwxGpuResidentFrames: 0,
      __zwxRegionWarmGeneration: 0,
      __zwxRegionWarmTimer: 0,
      __zwxRegionWarmPromise: null,
      __zwxBypassPlayGate: false
    });

    const originalSetVisible = layer.setVisible;
    const originalSetEnabled = layer.setEnabled;
    const originalEvictExcept = layer.evictExcept;

    layer.setVisible = function (ids) {
      const nextIds = [...new Set((ids || []).map(String))];
      const nextSignature = signature(nextIds);
      const changed = nextSignature !== this.__zwxViewportSignature;
      this.__zwxRequestedVisibleIds = nextIds;
      this.__zwxViewportSignature = nextSignature;

      const output = originalSetVisible.call(this, nextIds);

      if (changed && nextIds.length) {
        this.__zwxRegionReadySignature = "";
        this.__zwxPinnedGpuKeys = new Set();
        this.__zwxSetArchiveSuppressed?.(true);
        scheduleRegion(this, nextIds, 20);
      }
      return output;
    };

    layer.setEnabled = function (enabled) {
      const output = originalSetEnabled.call(this, enabled);
      if (enabled) {
        const ids = this.__zwxRequestedVisibleIds?.length
          ? this.__zwxRequestedVisibleIds
          : visibleChunkIds(this.map);
        if (ids.length) scheduleRegion(this, ids, 0);
      }
      return output;
    };

    layer.evictExcept = function (keep) {
      if (!this.__zwxPinnedGpuKeys.size) return originalEvictExcept.call(this, keep);
      const combined = new Set(keep || []);
      for (const textureKey of this.__zwxPinnedGpuKeys) combined.add(textureKey);
      return originalEvictExcept.call(this, combined);
    };

    layer.__zwxPrepareArchiveForPlay = async function (progress) {
      const ids = this.__zwxRequestedVisibleIds?.length
        ? [...this.__zwxRequestedVisibleIds]
        : visibleChunkIds(this.map);
      if (!ids.length || !manifest) return { ready: false };

      const wanted = signature(ids);
      if (this.__zwxRegionReadySignature === wanted) {
        return { ready: true, cached: true, fullGpuResident: this.__zwxFullGpuResident };
      }

      return scheduleRegion(this, ids, 0, progress);
    };

    layer.__zwxPrepareHdForPlay = layer.__zwxPrepareArchiveForPlay;
    layer.__zwxScheduleArchiveRegionPrefetch = ids => scheduleRegion(layer, ids || layer.__zwxRequestedVisibleIds, 0);
    layer.__zwxPrewarmForCamera = () => prewarmForCamera(layer);

    window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__ = layer;
    window.__ZWX_MRALA_MISSING_NATIVE_URLS__ = missing;

    const cameraWarm = () => prewarmForCamera(layer);
    layer.map?.on?.("zoom", cameraWarm);
    layer.map?.on?.("moveend", cameraWarm);
    setTimeout(cameraWarm, 0);

    console.info(
      "MRALA archive player v3: native quality warms on zoom, independent of playback • full loop GPU-resident when budget allows"
    );
    return result;
  };

  addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("playPause");
    if (!button) return;

    button.addEventListener("click", async event => {
      const layer = window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__;
      if (!layer?.enabled || !layer.__zwxRequestedVisibleIds?.length || /Pause/i.test(String(button.textContent || ""))) return;
      if (layer.__zwxBypassPlayGate) {
        layer.__zwxBypassPlayGate = false;
        return;
      }

      const wanted = signature(layer.__zwxRequestedVisibleIds);
      if (layer.__zwxRegionReadySignature === wanted) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const oldText = button.textContent;
      button.disabled = true;

      try {
        const prepared = await layer.__zwxPrepareArchiveForPlay((done, total, full) => {
          const percent = total ? Math.round(done * 100 / total) : 0;
          button.textContent = full ? `Finishing native ${percent}%` : `Caching native ${percent}%`;
        });
        if (!prepared?.ready) {
          button.textContent = oldText || "▶ Play";
          return;
        }
        button.disabled = false;
        button.textContent = "▶ Play";
        layer.__zwxBypassPlayGate = true;
        button.click();
      } catch (error) {
        console.warn("MRALA native archive Play gate failed", error);
        button.textContent = oldText || "▶ Play";
      } finally {
        button.disabled = false;
      }
    }, true);
  }, { once: true });
})();

(() => {
  "use strict";

  const path = String(location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path) || window.__ZWX_MRALA_ARCHIVE_SYNC_GUARD__) return;
  window.__ZWX_MRALA_ARCHIVE_SYNC_GUARD__ = true;

  const ID = "mrms-native-numeric-viewport-chunks";
  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer) return;
  const previousAddLayer = mapPrototype.addLayer;

  mapPrototype.addLayer = function (layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);
    if (layer?.id !== ID || layer.__zwxArchiveSyncGuardPatched) return result;

    layer.__zwxArchiveSyncGuardPatched = true;
    layer.__zwxDisplaySuppressed = false;

    const originalRender = layer.render;
    const originalHasFrame = layer.hasFrame;
    const originalActivateFrame = layer.activateFrame;
    const originalSetBlendFrames = layer.setBlendFrames;
    const originalSetVisible = layer.setVisible;

    function suppress(instance, value) {
      const next = Boolean(value);
      if (instance.__zwxDisplaySuppressed === next) return;
      instance.__zwxDisplaySuppressed = next;
      instance.map?.triggerRepaint();
    }

    function regionReady(instance) {
      return Boolean(
        instance.__zwxViewportSignature &&
        instance.__zwxRegionReadySignature === instance.__zwxViewportSignature
      );
    }

    function warm(instance) {
      if (instance?.enabled && typeof instance.__zwxScheduleArchiveRegionPrefetch === "function") {
        instance.__zwxScheduleArchiveRegionPrefetch(instance.__zwxRequestedVisibleIds);
      }
    }

    layer.__zwxSetArchiveSuppressed = value => suppress(layer, value);

    layer.render = function (gl, matrix) {
      if (this.__zwxDisplaySuppressed) return;
      return originalRender.call(this, gl, matrix);
    };

    layer.hasFrame = function (frameId, ids) {
      const ready = originalHasFrame.call(this, frameId, ids);
      if (!ready && this.enabled) {
        suppress(this, true);
        warm(this);
      }
      return ready;
    };

    layer.activateFrame = function (...args) {
      const ready = originalActivateFrame.apply(this, args);
      if (ready && regionReady(this)) suppress(this, false);
      else if (!regionReady(this)) suppress(this, true);
      return ready;
    };

    layer.setBlendFrames = function (...args) {
      const ready = originalSetBlendFrames.apply(this, args);
      if (ready && regionReady(this)) suppress(this, false);
      else if (!regionReady(this)) suppress(this, true);
      return ready;
    };

    layer.setVisible = function (ids) {
      const before = String(this.__zwxViewportSignature || "");
      const output = originalSetVisible.call(this, ids);
      const after = String(this.__zwxViewportSignature || "");
      if (this.enabled && before !== after) suppress(this, true);
      return output;
    };

    console.info(
      "MRALA archive sync v3: HD remains hidden until the zoomed region archive is ready; no first-pass quality toggling"
    );
    return result;
  };
})();
