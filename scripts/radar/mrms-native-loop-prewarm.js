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
  const CACHE_NAME = "zwx-mrala-rolling-archive-v3";
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
  const LOAD_CONCURRENCY = MOBILE ? 2 : 5;
  const LIVE_CONCURRENCY = MOBILE ? 1 : 3;

  let manifest = null;
  let memoryBytes = 0;
  let cachePromise = null;
  let persistentWritesAllowed = true;
  let lastPrune = 0;
  let pollTimer = 0;

  const memory = new Map();
  const pinnedUrls = new Set();
  const missingUrls = new Set();
  const inflight = new Map();
  const previousFetch = fetch.bind(window);

  const urlOf = input => String(typeof input === "string" ? input : input?.url || "");
  const frameMs = frame => Date.parse(frame?.valid_time || frame?.validTime || "");
  const textureKey = (frameId, chunkId) => `${frameId}:${chunkId}`;
  const signature = ids => [...new Set((ids || []).map(String))].sort().join("|");

  function recentFrames(source = manifest) {
    const frames = Array.isArray(source?.frames) ? source.frames : [];
    if (!frames.length) return [];
    const newest = frames.reduce((value, frame) => {
      const ms = frameMs(frame);
      return Number.isFinite(ms) ? Math.max(value, ms) : value;
    }, 0);
    const cutoff = (newest || Date.now()) - HISTORY_MS;
    return frames
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
    while (memoryBytes > MEM_BUDGET && memory.size > 1) {
      let candidate = null;
      for (const url of memory.keys()) {
        if (!pinnedUrls.has(url)) {
          candidate = url;
          break;
        }
      }
      if (!candidate) break;
      const bytes = memory.get(candidate);
      memory.delete(candidate);
      memoryBytes -= Number(bytes?.byteLength || 0);
    }
  }

  function putMemory(url, bytes) {
    if (!(bytes instanceof ArrayBuffer)) return;
    const old = memory.get(url);
    if (old) {
      memoryBytes -= old.byteLength;
      memory.delete(url);
    }
    memory.set(url, bytes);
    memoryBytes += bytes.byteLength;
    trimMemory();
  }

  function getMemory(url) {
    const bytes = memory.get(url);
    if (!bytes) return null;
    memory.delete(url);
    memory.set(url, bytes);
    return bytes;
  }

  function fallbackChunk(url) {
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

  function rememberMissing(url, status) {
    if (missingUrls.has(url)) return;
    missingUrls.add(url);
    if (missingUrls.size <= 5) console.warn("Native chunk unavailable; overview fallback", status, url);
    else if (missingUrls.size === 6) console.warn("Additional missing native-chunk warnings suppressed");
  }

  async function disk() {
    if (!("caches" in window)) return null;
    if (!cachePromise) cachePromise = caches.open(CACHE_NAME).catch(() => null);
    return cachePromise;
  }

  async function diskResponse(url) {
    try { return (await disk())?.match(url) || null; } catch { return null; }
  }

  async function canPersist() {
    if (!persistentWritesAllowed) return false;
    if (!navigator.storage?.estimate) return true;
    try {
      const estimate = await navigator.storage.estimate();
      const quota = Number(estimate.quota || 0);
      const usage = Number(estimate.usage || 0);
      if (quota && usage / quota >= 0.72) {
        persistentWritesAllowed = false;
        console.warn("MRALA persistent cache paused at", Math.round(usage / quota * 100) + "% browser storage use");
        return false;
      }
    } catch {}
    return true;
  }

  async function persist(url, response) {
    if (!ASSET_RE.test(url) || !(await canPersist())) return;
    try { await (await disk())?.put(url, response.clone()); } catch {}
  }

  async function prune(force = false) {
    if (!manifest) return;
    const now = Date.now();
    if (!force && now - lastPrune < 10 * 60 * 1000) return;
    lastPrune = now;
    const valid = new Set(recentFrames().map(frame => String(frame.id)));
    const cache = await disk();
    if (!cache || !valid.size) return;
    try {
      for (const request of await cache.keys()) {
        const url = String(request.url || "");
        if (!ASSET_RE.test(url)) continue;
        const frameId = assetFrameId(url);
        if (frameId && !valid.has(frameId)) {
          await cache.delete(request);
          const bytes = memory.get(url);
          if (bytes) {
            memory.delete(url);
            memoryBytes -= bytes.byteLength;
          }
        }
      }
    } catch {}
  }

  async function capture(nextManifest, source = "fetch") {
    const oldIds = new Set(recentFrames().map(frame => String(frame.id)));
    manifest = nextManifest;
    window.__ZWX_MRALA_RUNTIME_MANIFEST__ = manifest;
    prune().catch(() => {});

    const layer = window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__;
    const frames = recentFrames();
    const added = frames.filter(frame => !oldIds.has(String(frame.id)));

    if (layer) {
      layer.__zwxArchiveFrameIds = frames.map(frame => String(frame.id));
      if (added.length && layer.__zwxRequestedVisibleIds?.length) {
        stageNewFrames(layer, added).catch(() => {});
      }
      if (layer.enabled && layer.__zwxRequestedVisibleIds?.length && !layer.__zwxRegionWarming) {
        scheduleRegion(layer, layer.__zwxRequestedVisibleIds, 0);
      }
    }

    if (added.length && source === "poll") {
      console.info("MRALA live edge:", added.length, "new scan(s) appended; prior archive reused");
    }
  }

  window.fetch = async function (input, init) {
    const url = urlOf(input);

    if (ASSET_RE.test(url)) {
      if (CHUNK_RE.test(url)) {
        const ram = getMemory(url);
        if (ram) return responseFrom(ram, missingUrls.has(url) ? "missing-overview-fallback" : "archive-memory");
        if (missingUrls.has(url)) {
          const noData = fallbackChunk(url);
          if (noData) {
            putMemory(url, noData);
            return responseFrom(noData, "missing-overview-fallback");
          }
        }
      }

      const cached = await diskResponse(url);
      if (cached) {
        if (CHUNK_RE.test(url)) cached.clone().arrayBuffer().then(bytes => putMemory(url, bytes)).catch(() => {});
        return cached;
      }
    }

    const response = await previousFetch(input, init);

    if (response.ok && MANIFEST_RE.test(url)) {
      try { await capture(await response.clone().json()); } catch {}
    } else if (response.ok && ASSET_RE.test(url)) {
      persist(url, response).catch(() => {});
      if (CHUNK_RE.test(url)) response.clone().arrayBuffer().then(bytes => putMemory(url, bytes)).catch(() => {});
    } else if (CHUNK_RE.test(url) && (response.status === 403 || response.status === 404)) {
      const noData = fallbackChunk(url);
      if (noData) {
        rememberMissing(url, response.status);
        putMemory(url, noData);
        return responseFrom(noData, "missing-overview-fallback");
      }
    }

    return response;
  };

  async function bytes(url) {
    const ram = getMemory(url);
    if (ram) return ram;

    const cached = await diskResponse(url);
    if (cached) {
      const data = await cached.arrayBuffer();
      putMemory(url, data);
      return data;
    }

    if (inflight.has(url)) return inflight.get(url);
    const promise = (async () => {
      const response = await window.fetch(url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`Native archive HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      putMemory(url, data);
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

  async function gpuTarget(layer, target, gpuPins) {
    const key = textureKey(target.frame.id, target.chunk.id);
    gpuPins?.add(key);

    const packed = await bytes(target.url);
    if (!layer.textures.has(key)) {
      const expected = Number(target.chunk.width) * Number(target.chunk.height);
      const unpacked = await raw(packed, expected);
      if (unpacked.byteLength !== expected) {
        throw new Error(`Archive ${target.chunk.id} size ${unpacked.byteLength} != ${expected}`);
      }
      layer.addTexture(target.frame.id, target.chunk, unpacked);
    }
    return layer.textures.has(key);
  }

  async function repairGpuSet(layer, gpuTargets, gpuPins, generation) {
    for (let pass = 0; pass < 2; pass += 1) {
      if (generation !== layer.__zwxRegionWarmGeneration) return false;
      const missing = gpuTargets.filter(target => !layer.textures.has(textureKey(target.frame.id, target.chunk.id)));
      if (!missing.length) return true;

      console.info("MRALA native GPU validation: repairing", missing.length, "evicted/missing texture(s)");
      let cursor = 0;
      async function worker() {
        while (cursor < missing.length) {
          if (generation !== layer.__zwxRegionWarmGeneration) return;
          const target = missing[cursor++];
          try { await gpuTarget(layer, target, gpuPins); } catch {}
        }
      }
      await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, missing.length) }, () => worker()));
    }
    return gpuTargets.every(target => layer.textures.has(textureKey(target.frame.id, target.chunk.id)));
  }

  async function warmRegion(layer, ids, generation, progress) {
    if (!layer || !ids?.length || !manifest) return { ready: false };

    const byId = chunkMap();
    const chunksForView = ids.map(id => byId.get(String(id))).filter(Boolean);
    const frames = recentFrames();
    if (!chunksForView.length || !frames.length) return { ready: false };

    layer.__zwxArchiveSessionActive = true;
    layer.__zwxArchiveFrameIds = frames.map(frame => String(frame.id));
    layer.__zwxRegionWarming = true;
    layer.__zwxSetArchiveSuppressed?.(true);

    const ordered = orderedFrames(layer, frames);
    const plan = gpuPlan(frames, chunksForView);
    const gpuFrameIds = new Set(ordered.slice(0, plan.count).map(frame => String(frame.id)));
    const targets = [];
    const gpuTargets = [];

    for (const frame of ordered) {
      for (const chunk of chunksForView) {
        const target = { frame, chunk, url: chunkUrl(frame.id, chunk.id) };
        targets.push(target);
        if (gpuFrameIds.has(String(frame.id))) gpuTargets.push(target);
      }
    }

    pinnedUrls.clear();
    for (const target of targets) pinnedUrls.add(target.url);

    const gpuPins = new Set(gpuTargets.map(target => textureKey(target.frame.id, target.chunk.id)));
    layer.__zwxPinnedGpuKeys = gpuPins;

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
      Array.from({ length: Math.min(LOAD_CONCURRENCY, targets.length) }, () => worker())
    );

    if (generation !== layer.__zwxRegionWarmGeneration) {
      return { ready: false, superseded: true };
    }

    const gpuComplete = await repairGpuSet(layer, gpuTargets, gpuPins, generation);
    if (generation !== layer.__zwxRegionWarmGeneration) {
      return { ready: false, superseded: true };
    }

    if (failed || !gpuComplete) {
      layer.__zwxRegionWarming = false;
      layer.__zwxRegionReadySignature = "";
      layer.__zwxSetArchiveSuppressed?.(true);
      console.warn("MRALA native region withheld: archive/GPU set incomplete", { failed, gpuComplete });
      return { ready: false, failed, gpuComplete };
    }

    layer.__zwxRegionReadySignature = signature(ids);
    layer.__zwxFullGpuResident = plan.full;
    layer.__zwxGpuResidentFrames = plan.count;
    layer.__zwxRegionWarming = false;
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
      "MRALA native region READY (validated):",
      frames.length + " frames",
      chunksForView.length + " chunks/frame",
      plan.full ? "FULL LOOP GPU-resident" : plan.count + " GPU frames + full local archive",
      gpuTargets.length + " validated textures",
      Math.round(performance.now() - started) + " ms"
    );

    return { ready: true, fullGpuResident: plan.full, gpuFrames: plan.count };
  }

  function scheduleRegion(layer, ids, delay = 20, progress) {
    if (!layer || !ids?.length || !manifest) return Promise.resolve({ ready: false });
    const wanted = signature(ids);

    if (layer.__zwxRegionReadySignature === wanted && !layer.__zwxRegionWarming) {
      return Promise.resolve({ ready: true, cached: true, fullGpuResident: layer.__zwxFullGpuResident });
    }

    if (
      layer.__zwxRegionWarming &&
      layer.__zwxRegionWarmSignature === wanted &&
      layer.__zwxRegionWarmPromise
    ) {
      return layer.__zwxRegionWarmPromise;
    }

    const generation = ++layer.__zwxRegionWarmGeneration;
    clearTimeout(layer.__zwxRegionWarmTimer);
    layer.__zwxRegionWarmSignature = wanted;
    layer.__zwxRegionWarming = true;
    layer.__zwxSetArchiveSuppressed?.(true);

    const promise = new Promise(resolve => {
      layer.__zwxRegionWarmTimer = setTimeout(() => {
        warmRegion(layer, [...ids], generation, progress)
          .then(resolve)
          .catch(error => {
            if (generation === layer.__zwxRegionWarmGeneration) {
              layer.__zwxRegionWarming = false;
              layer.__zwxRegionReadySignature = "";
              layer.__zwxSetArchiveSuppressed?.(true);
            }
            console.warn("MRALA native archive region warm failed", error);
            resolve({ ready: false, error });
          });
      }, delay);
    });

    layer.__zwxRegionWarmPromise = promise;
    promise.finally(() => {
      if (layer.__zwxRegionWarmPromise === promise) layer.__zwxRegionWarmPromise = null;
    });
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
    scheduleRegion(layer, ids, 25);
  }

  async function stageNewFrames(layer, newFrames) {
    const ids = [...(layer.__zwxRequestedVisibleIds || [])];
    if (!ids.length) return;
    const byId = chunkMap();
    const chunksForView = ids.map(id => byId.get(String(id))).filter(Boolean);
    if (!chunksForView.length) return;

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
          if (layer.__zwxFullGpuResident && !layer.__zwxRegionWarming) {
            layer.__zwxPinnedGpuKeys.add(textureKey(target.frame.id, target.chunk.id));
            await gpuTarget(layer, target, layer.__zwxPinnedGpuKeys);
          } else {
            await bytes(target.url);
          }
        } catch {}
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(LIVE_CONCURRENCY, targets.length) }, () => worker())
    );
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
      __zwxRegionWarmSignature: "",
      __zwxArchiveSessionActive: false,
      __zwxArchiveFrameIds: [],
      __zwxPinnedGpuKeys: new Set(),
      __zwxFullGpuResident: false,
      __zwxGpuResidentFrames: 0,
      __zwxRegionWarmGeneration: 0,
      __zwxRegionWarmTimer: 0,
      __zwxRegionWarmPromise: null,
      __zwxRegionWarming: false,
      __zwxBypassPlayGate: false,
      __zwxDisplaySuppressed: true
    });

    const originalSetVisible = layer.setVisible;
    const originalSetEnabled = layer.setEnabled;
    const originalEvictExcept = layer.evictExcept;
    const originalRender = layer.render;
    const originalHasFrame = layer.hasFrame;
    const originalActivateFrame = layer.activateFrame;
    const originalSetBlendFrames = layer.setBlendFrames;

    function regionReady(instance) {
      return Boolean(
        !instance.__zwxRegionWarming &&
        instance.__zwxViewportSignature &&
        instance.__zwxRegionReadySignature === instance.__zwxViewportSignature
      );
    }

    function suppress(instance, value) {
      const next = Boolean(value);
      if (instance.__zwxDisplaySuppressed === next) return;
      instance.__zwxDisplaySuppressed = next;
      instance.map?.triggerRepaint();
    }

    layer.__zwxSetArchiveSuppressed = value => suppress(layer, value);

    layer.render = function (gl, matrix) {
      if (this.__zwxDisplaySuppressed || !regionReady(this)) return;
      return originalRender.call(this, gl, matrix);
    };

    layer.hasFrame = function (frameId, ids) {
      const ready = originalHasFrame.call(this, frameId, ids);
      if (!ready && this.enabled) {
        suppress(this, true);
        if (!this.__zwxRegionWarming) scheduleRegion(this, this.__zwxRequestedVisibleIds, 0);
      }
      return ready;
    };

    layer.activateFrame = function (...args) {
      const ready = originalActivateFrame.apply(this, args);
      suppress(this, !(ready && regionReady(this)));
      return ready;
    };

    layer.setBlendFrames = function (...args) {
      const ready = originalSetBlendFrames.apply(this, args);
      suppress(this, !(ready && regionReady(this)));
      return ready;
    };

    layer.setVisible = function (ids) {
      const nextIds = [...new Set((ids || []).map(String))];
      const nextSignature = signature(nextIds);
      const changed = nextSignature !== this.__zwxViewportSignature;
      this.__zwxRequestedVisibleIds = nextIds;
      this.__zwxViewportSignature = nextSignature;

      const output = originalSetVisible.call(this, nextIds);

      if (changed && nextIds.length) {
        this.__zwxRegionReadySignature = "";
        suppress(this, true);
        scheduleRegion(this, nextIds, 20);
      }
      return output;
    };

    layer.setEnabled = function (enabled) {
      const output = originalSetEnabled.call(this, enabled);
      if (!enabled) {
        suppress(this, true);
        return output;
      }
      const ids = this.__zwxRequestedVisibleIds?.length
        ? this.__zwxRequestedVisibleIds
        : visibleChunkIds(this.map);
      if (ids.length) scheduleRegion(this, ids, 0);
      return output;
    };

    layer.evictExcept = function (keep) {
      const combined = new Set(keep || []);
      for (const key of this.__zwxPinnedGpuKeys || []) combined.add(key);
      return originalEvictExcept.call(this, combined);
    };

    layer.__zwxPrepareArchiveForPlay = async function (progress) {
      const ids = this.__zwxRequestedVisibleIds?.length
        ? [...this.__zwxRequestedVisibleIds]
        : visibleChunkIds(this.map);
      if (!ids.length || !manifest) return { ready: false };
      const wanted = signature(ids);
      if (this.__zwxRegionReadySignature === wanted && !this.__zwxRegionWarming) {
        return { ready: true, cached: true, fullGpuResident: this.__zwxFullGpuResident };
      }
      return scheduleRegion(this, ids, 0, progress);
    };

    layer.__zwxPrepareHdForPlay = layer.__zwxPrepareArchiveForPlay;
    layer.__zwxScheduleArchiveRegionPrefetch = ids =>
      scheduleRegion(layer, ids || layer.__zwxRequestedVisibleIds, 0);

    window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__ = layer;
    window.__ZWX_MRALA_MISSING_NATIVE_URLS__ = missingUrls;

    const cameraWarm = () => prewarmForCamera(layer);
    layer.map?.on?.("zoom", cameraWarm);
    layer.map?.on?.("moveend", cameraWarm);
    setTimeout(cameraWarm, 0);

    console.info(
      "MRALA archive player v4: native archive pinned during warm • GPU set validated before one-way HD handoff"
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
      if (layer.__zwxRegionReadySignature === wanted && !layer.__zwxRegionWarming) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const oldText = button.textContent;
      button.disabled = true;

      try {
        const prepared = await layer.__zwxPrepareArchiveForPlay((done, total, full) => {
          const percent = total ? Math.round(done * 100 / total) : 0;
          button.textContent = full ? `Validating native ${percent}%` : `Caching native ${percent}%`;
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
