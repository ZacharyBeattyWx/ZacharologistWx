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
const CACHE_NAME = "zwx-mrala-rolling-archive-v4";
const CORE_VIEWPORT_PAD = 0.12;
const PREDICTIVE_ZOOM = 5.95;
const PREDICTIVE_START_ZOOM = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 4.35 : 3.20;
const MOBILE = matchMedia?.("(pointer: coarse)")?.matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const STARTUP_FRAMES = MOBILE ? 3 : 4;
const RUNWAY_TARGET = MOBILE ? 8 : 18;
const LOAD_CONCURRENCY = MOBILE ? 2 : 6;
const CACHE_CONCURRENCY = MOBILE ? 2 : 5;
const LIVE_CONCURRENCY = MOBILE ? 1 : 3;
const MEMORY_BUDGET = (MOBILE ? 72 : 192) * 1048576;
const GPU_RUNWAY_BUDGET = (MOBILE ? 160 : 320) * 1048576;

let manifest = null;
let memoryBytes = 0;
let cachePromise = null;
let persistentWritesAllowed = true;
let lastPrune = 0;
let pollTimer = 0;
let predictiveTimer = 0;
const memory = new Map();
const missingUrls = new Set();
const inflight = new Map();
const previousFetch = fetch.bind(window);

const urlOf = input => String(typeof input === "string" ? input : input?.url || "");
const frameMs = frame => Date.parse(frame?.valid_time || frame?.validTime || "");
const textureKey = (frameId, chunkId) => `${frameId}:${chunkId}`;
const normalizeIds = ids => [...new Set((ids || []).map(String))].sort();
const signature = ids => normalizeIds(ids).join("|");

function timelineFrames(source = manifest) {
  const frames = Array.isArray(source?.frames) ? source.frames : [];
  const valid = frames
    .filter(frame => frame?.id && frame?.dbz && Number.isFinite(frameMs(frame)))
    .sort((a, b) => frameMs(a) - frameMs(b));
  if (!valid.length) return [];
  const newest = frameMs(valid[valid.length - 1]) || Date.now();
  const cutoff = newest - HISTORY_MS;
  return valid.filter(frame => frameMs(frame) >= cutoff);
}

function nativeFrames(source = manifest) {
  return timelineFrames(source).filter(frame => frame?.nativeChunksReady);
}

function chunkMap() {
  return new Map((manifest?.nativeChunking?.layout || []).map(chunk => [String(chunk.id), chunk]));
}

function chunkUrl(frameId, chunkId) {
  const template = String(manifest?.nativeChunking?.template || "native-chunks/{frameId}/{chunkId}.dbz")
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
  while (memoryBytes > MEMORY_BUDGET && memory.size > 1) {
    const first = memory.keys().next().value;
    const value = memory.get(first);
    memory.delete(first);
    memoryBytes -= Number(value?.byteLength || 0);
  }
}

function putMemory(url, value) {
  if (!(value instanceof ArrayBuffer)) return;
  const old = memory.get(url);
  if (old) {
    memoryBytes -= old.byteLength;
    memory.delete(url);
  }
  memory.set(url, value);
  memoryBytes += value.byteLength;
  trimMemory();
}

function getMemory(url) {
  const value = memory.get(url);
  if (!value) return null;
  memory.delete(url);
  memory.set(url, value);
  return value;
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

function responseFrom(value, source) {
  return new Response(value.slice(0), {
    status: 200,
    headers: {
      "content-length": String(value.byteLength),
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
  const valid = new Set(timelineFrames().map(frame => String(frame.id)));
  const cache = await disk();
  if (!cache || !valid.size) return;
  try {
    for (const request of await cache.keys()) {
      const url = String(request.url || "");
      if (!ASSET_RE.test(url)) continue;
      const frameId = assetFrameId(url);
      if (frameId && !valid.has(frameId)) {
        await cache.delete(request);
        const value = memory.get(url);
        if (value) {
          memory.delete(url);
          memoryBytes -= value.byteLength;
        }
      }
    }
  } catch {}
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
      if (CHUNK_RE.test(url)) cached.clone().arrayBuffer().then(value => putMemory(url, value)).catch(() => {});
      return cached;
    }
  }

  const response = await previousFetch(input, init);
  if (response.ok && MANIFEST_RE.test(url)) {
    try { await capture(await response.clone().json()); } catch {}
  } else if (response.ok && ASSET_RE.test(url)) {
    persist(url, response).catch(() => {});
    if (CHUNK_RE.test(url)) response.clone().arrayBuffer().then(value => putMemory(url, value)).catch(() => {});
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
    const value = await cached.arrayBuffer();
    putMemory(url, value);
    return value;
  }
  if (inflight.has(url)) return inflight.get(url);
  const promise = (async () => {
    const response = await window.fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`Native archive HTTP ${response.status}`);
    const value = await response.arrayBuffer();
    putMemory(url, value);
    return value;
  })();
  inflight.set(url, promise);
  try { return await promise; }
  finally { if (inflight.get(url) === promise) inflight.delete(url); }
}

async function raw(value, expected) {
  if (value.byteLength === expected) return new Uint8Array(value);
  const probe = new Uint8Array(value);
  if (probe[0] === 0x1f && probe[1] === 0x8b && typeof DecompressionStream !== "undefined") {
    const stream = new Blob([value]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return probe;
}

function currentFrameId(layer) {
  const frames = timelineFrames();
  if (!frames.length) return "";
  const from = String(layer?.fromFrame || "");
  if (from && frames.some(frame => String(frame.id) === from)) return from;
  const slider = document.getElementById("frameSlider");
  const index = Math.max(0, Math.min(frames.length - 1, Number(slider?.value || frames.length - 1)));
  return String(frames[index]?.id || "");
}

function orderedNativeFrames(layer) {
  const frames = nativeFrames();
  if (!frames.length) return [];
  const currentId = currentFrameId(layer);
  let index = frames.findIndex(frame => String(frame.id) === currentId);
  if (index < 0) {
    const currentMs = frameMs(timelineFrames().find(frame => String(frame.id) === currentId));
    if (Number.isFinite(currentMs)) {
      let best = 0;
      let distance = Infinity;
      for (let i = 0; i < frames.length; i += 1) {
        const nextDistance = Math.abs(frameMs(frames[i]) - currentMs);
        if (nextDistance < distance) { distance = nextDistance; best = i; }
      }
      index = best;
    } else index = 0;
  }
  return [...frames.slice(index), ...frames.slice(0, index)];
}

function runwayCount(ids) {
  const byId = chunkMap();
  const chunks = normalizeIds(ids).map(id => byId.get(id)).filter(Boolean);
  const bytesPerFrame = chunks.reduce((sum, chunk) => sum + Number(chunk.width || 0) * Number(chunk.height || 0), 0);
  if (!bytesPerFrame) return STARTUP_FRAMES;
  const budgetFrames = Math.max(STARTUP_FRAMES, Math.floor(GPU_RUNWAY_BUDGET / bytesPerFrame));
  return Math.max(STARTUP_FRAMES, Math.min(RUNWAY_TARGET, budgetFrames));
}

async function gpuTarget(layer, frame, chunk, pins) {
  const key = textureKey(frame.id, chunk.id);
  pins?.add(key);
  if (layer.textures.has(key)) return true;
  const packed = await bytes(chunkUrl(frame.id, chunk.id));
  const expected = Number(chunk.width || 0) * Number(chunk.height || 0);
  const unpacked = await raw(packed, expected);
  if (unpacked.byteLength !== expected) throw new Error(`Archive ${chunk.id} size ${unpacked.byteLength} != ${expected}`);
  layer.addTexture(frame.id, chunk, unpacked);
  return layer.textures.has(key);
}

function gpuHasFrames(layer, ids, count = STARTUP_FRAMES) {
  const ordered = orderedNativeFrames(layer);
  const wanted = normalizeIds(ids);
  if (!ordered.length || !wanted.length) return false;
  const check = ordered.slice(0, Math.min(count, ordered.length));
  return check.every(frame => wanted.every(id => layer.textures.has(textureKey(frame.id, id))));
}

function idsCovered(covered, ids) {
  const set = covered instanceof Set ? covered : new Set(covered || []);
  return normalizeIds(ids).every(id => set.has(id));
}

function suppress(layer, value) {
  const next = Boolean(value);
  if (layer.__zwxDisplaySuppressed === next) return;
  layer.__zwxDisplaySuppressed = next;
  layer.map?.triggerRepaint();
}

function mergeReadyIds(layer, ids) {
  const next = new Set(layer.__zwxDisplayReadyIds || []);
  for (const id of normalizeIds(ids)) next.add(id);
  layer.__zwxDisplayReadyIds = next;
}

function makeChunks(ids) {
  const byId = chunkMap();
  return normalizeIds(ids).map(id => byId.get(id)).filter(Boolean);
}

async function loadGpuFrames(layer, ids, frameCount, generation, reason) {
  const chunks = makeChunks(ids);
  const ordered = orderedNativeFrames(layer);
  if (!chunks.length || !ordered.length) return false;
  const frames = ordered.slice(0, Math.min(frameCount, ordered.length));
  const targets = [];
  for (const frame of frames) for (const chunk of chunks) targets.push({ frame, chunk });
  const pins = new Set(layer.__zwxPinnedGpuKeys || []);
  let cursor = 0;
  let failed = 0;
  async function worker() {
    while (cursor < targets.length) {
      if (generation !== layer.__zwxWarmGeneration && reason === "startup") return;
      const target = targets[cursor++];
      try { await gpuTarget(layer, target.frame, target.chunk, pins); }
      catch { failed += 1; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, targets.length) }, () => worker()));
  if (failed) return false;
  if (reason === "startup" && generation !== layer.__zwxWarmGeneration) return false;
  layer.__zwxPinnedGpuKeys = pins;
  return frames.every(frame => chunks.every(chunk => layer.textures.has(textureKey(frame.id, chunk.id))));
}

async function warmStartup(layer, ids, reason = "native") {
  const wanted = normalizeIds(ids);
  if (!wanted.length || !manifest) return { ready: false };
  const generation = ++layer.__zwxWarmGeneration;
  const started = performance.now();
  layer.__zwxStartupWarming = true;
  if (layer.enabled && !layer.__zwxHdLocked) suppress(layer, true);
  const ready = await loadGpuFrames(layer, wanted, STARTUP_FRAMES, generation, "startup");
  if (generation !== layer.__zwxWarmGeneration) return { ready: false, superseded: true };
  layer.__zwxStartupWarming = false;
  if (!ready) return { ready: false };
  mergeReadyIds(layer, wanted);
  if (layer.enabled && signature(wanted) === signature(layer.__zwxRequestedVisibleIds)) {
    layer.__zwxHdLocked = true;
    suppress(layer, false);
  }
  scheduleRunway(layer, wanted, 0);
  scheduleArchiveCache(layer, wanted, 80, reason);
  console.info(
    reason === "predictive" ? "MRALA predictive native startup READY:" : "MRALA native startup READY:",
    STARTUP_FRAMES + " frames",
    wanted.length + " chunks/frame",
    Math.round(performance.now() - started) + " ms",
    "• full archive continues to local cache"
  );
  return { ready: true };
}

async function fillRunway(layer, ids, generation) {
  if (!layer || !ids?.length || !manifest) return;
  const wanted = normalizeIds(ids);
  const count = runwayCount(wanted);
  const chunks = makeChunks(wanted);
  const ordered = orderedNativeFrames(layer).slice(0, count);
  if (!chunks.length || !ordered.length) return;
  const nextPins = new Set();
  const oldPins = new Set(layer.__zwxPinnedGpuKeys || []);
  for (const frame of ordered) for (const chunk of chunks) nextPins.add(textureKey(frame.id, chunk.id));
  const warmPins = new Set([...oldPins, ...nextPins]);
  layer.__zwxPinnedGpuKeys = warmPins;
  const targets = [];
  for (const frame of ordered) for (const chunk of chunks) {
    if (!layer.textures.has(textureKey(frame.id, chunk.id))) targets.push({ frame, chunk });
  }
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      if (generation !== layer.__zwxRunwayGeneration) return;
      const target = targets[cursor++];
      try { await gpuTarget(layer, target.frame, target.chunk, warmPins); } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, Math.max(1, targets.length)) }, () => worker()));
  if (generation !== layer.__zwxRunwayGeneration) return;
  layer.__zwxPinnedGpuKeys = nextPins;
  layer.__zwxRunwayFrames = count;
  layer.map?.triggerRepaint();
  if (!layer.__zwxRunwayLogged || targets.length) {
    layer.__zwxRunwayLogged = true;
    console.info("MRALA GPU runway READY:", count + " frames", wanted.length + " chunks/frame", "• archive source is browser cache/network as needed");
  }
}

function scheduleRunway(layer, ids, delay = 35) {
  if (!layer || !ids?.length || !manifest) return;
  clearTimeout(layer.__zwxRunwayTimer);
  const wanted = normalizeIds(ids);
  const generation = ++layer.__zwxRunwayGeneration;
  layer.__zwxRunwayTimer = setTimeout(() => {
    fillRunway(layer, wanted, generation).catch(error => console.warn("MRALA GPU runway refill failed", error));
  }, delay);
}

async function cacheRegion(layer, ids, generation, reason) {
  const wanted = normalizeIds(ids);
  const chunks = makeChunks(wanted);
  const frames = nativeFrames();
  if (!chunks.length || !frames.length) return;
  const targets = [];
  for (const frame of frames) for (const chunk of chunks) targets.push(chunkUrl(frame.id, chunk.id));
  let cursor = 0;
  let failed = 0;
  const started = performance.now();
  async function worker() {
    while (cursor < targets.length) {
      if (generation !== layer.__zwxCacheGeneration) return;
      const url = targets[cursor++];
      try { await bytes(url); } catch { failed += 1; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CACHE_CONCURRENCY, targets.length) }, () => worker()));
  if (generation !== layer.__zwxCacheGeneration) return;
  if (!failed) {
    const covered = new Set(layer.__zwxArchiveCachedIds || []);
    for (const id of wanted) covered.add(id);
    layer.__zwxArchiveCachedIds = covered;
    console.info(
      reason === "predictive" ? "MRALA predictive local archive READY:" : "MRALA local archive READY:",
      frames.length + " frames",
      wanted.length + " chunks/frame",
      "persisted/reused locally",
      Math.round(performance.now() - started) + " ms"
    );
  }
  prune(true).catch(() => {});
}

function scheduleArchiveCache(layer, ids, delay = 100, reason = "native") {
  if (!layer || !ids?.length || !manifest) return;
  const wanted = normalizeIds(ids);
  if (idsCovered(layer.__zwxArchiveCachedIds, wanted)) return;
  clearTimeout(layer.__zwxCacheTimer);
  const generation = ++layer.__zwxCacheGeneration;
  layer.__zwxCacheTimer = setTimeout(() => {
    cacheRegion(layer, wanted, generation, reason).catch(error => console.warn("MRALA local archive cache failed", error));
  }, delay);
}

function idsForBounds(west, south, east, north) {
  if (!manifest?.nativeChunking?.layout?.length) return [];
  return manifest.nativeChunking.layout
    .filter(chunk => {
      const bounds = chunk?.bounds;
      if (!Array.isArray(bounds) || bounds.length < 4) return false;
      const [cw, cs, ce, cn] = bounds.map(Number);
      return ce >= west && cw <= east && cn >= south && cs <= north;
    })
    .map(chunk => String(chunk.id));
}

function visibleChunkIds(map) {
  if (!map || !manifest?.nativeChunking?.layout?.length) return [];
  const bounds = map.getBounds?.();
  if (!bounds) return [];
  let west = Number(bounds.getWest());
  let east = Number(bounds.getEast());
  let south = Number(bounds.getSouth());
  let north = Number(bounds.getNorth());
  const lonPad = Math.max(0.02, Math.abs(east - west) * CORE_VIEWPORT_PAD);
  const latPad = Math.max(0.02, Math.abs(north - south) * CORE_VIEWPORT_PAD);
  west -= lonPad; east += lonPad; south -= latPad; north += latPad;
  return normalizeIds(idsForBounds(west, south, east, north));
}

function lonToWorldX(lon, worldSize) { return (Number(lon) + 180) / 360 * worldSize; }
function latToWorldY(lat, worldSize) {
  const clamped = Math.max(-85.051129, Math.min(85.051129, Number(lat)));
  const rad = clamped * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * worldSize;
}
function worldXToLon(x, worldSize) { return x / worldSize * 360 - 180; }
function worldYToLat(y, worldSize) {
  const n = Math.PI - 2 * Math.PI * (y / worldSize);
  return 180 / Math.PI * Math.atan(Math.sinh(n));
}

function predictedNativeChunkIds(map) {
  if (!map || !manifest?.nativeChunking?.layout?.length) return [];
  const center = map.getCenter?.();
  const container = map.getContainer?.();
  if (!center || !container) return [];
  const width = Math.max(320, Number(container.clientWidth || 0)) * (1 + CORE_VIEWPORT_PAD * 2);
  const height = Math.max(240, Number(container.clientHeight || 0)) * (1 + CORE_VIEWPORT_PAD * 2);
  const worldSize = 512 * Math.pow(2, PREDICTIVE_ZOOM);
  const cx = lonToWorldX(center.lng, worldSize);
  const cy = latToWorldY(center.lat, worldSize);
  return normalizeIds(idsForBounds(
    worldXToLon(cx - width / 2, worldSize),
    worldYToLat(cy + height / 2, worldSize),
    worldXToLon(cx + width / 2, worldSize),
    worldYToLat(cy - height / 2, worldSize)
  ));
}

function prepareRegion(layer, ids, reason = "native") {
  const wanted = normalizeIds(ids);
  if (!wanted.length) return;
  if (gpuHasFrames(layer, wanted, STARTUP_FRAMES)) {
    mergeReadyIds(layer, wanted);
    if (layer.enabled && signature(wanted) === signature(layer.__zwxRequestedVisibleIds)) {
      layer.__zwxHdLocked = true;
      suppress(layer, false);
    }
    scheduleRunway(layer, wanted, 0);
    scheduleArchiveCache(layer, wanted, 50, reason);
    return;
  }
  if (!layer.__zwxStartupWarming) warmStartup(layer, wanted, reason).catch(error => console.warn("MRALA native startup warm failed", error));
}

function schedulePredictive(layer, delay = 180) {
  clearTimeout(predictiveTimer);
  predictiveTimer = setTimeout(() => {
    if (!layer?.map || !manifest || layer.enabled) return;
    const zoom = Number(layer.map.getZoom?.() || 0);
    if (zoom < PREDICTIVE_START_ZOOM) return;
    const ids = predictedNativeChunkIds(layer.map);
    if (!ids.length) return;
    prepareRegion(layer, ids, "predictive");
    console.info("MRALA predictive archive warm:", ids.length + " chunk(s)", "target z" + PREDICTIVE_ZOOM.toFixed(2), "• startup GPU first, full 3h bytes to local cache behind it");
  }, delay);
}

async function stageNewFrames(layer, newFrames) {
  const ids = normalizeIds([...(layer.__zwxArchiveCachedIds || []), ...(layer.__zwxRequestedVisibleIds || [])]);
  if (!ids.length || !newFrames.length) return;
  const chunks = makeChunks(ids);
  const targets = [];
  for (const frame of newFrames.filter(frame => frame?.nativeChunksReady)) for (const chunk of chunks) targets.push(chunkUrl(frame.id, chunk.id));
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const url = targets[cursor++];
      try { await bytes(url); } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIVE_CONCURRENCY, Math.max(1, targets.length)) }, () => worker()));
  if (layer.enabled) scheduleRunway(layer, layer.__zwxRequestedVisibleIds, 0);
}

async function capture(nextManifest, source = "fetch") {
  const oldIds = new Set(timelineFrames().map(frame => String(frame.id)));
  manifest = nextManifest;
  window.__ZWX_MRALA_RUNTIME_MANIFEST__ = manifest;
  prune().catch(() => {});
  const layer = window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__;
  const frames = timelineFrames();
  const added = frames.filter(frame => !oldIds.has(String(frame.id)));
  if (layer) {
    if (added.length) stageNewFrames(layer, added).catch(() => {});
    schedulePredictive(layer, 40);
  }
  if (added.length && source === "poll") console.info("MRALA live edge:", added.length, "new scan(s) staged; previous archive reused");
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
    __zwxDisplayReadyIds: new Set(),
    __zwxArchiveCachedIds: new Set(),
    __zwxPinnedGpuKeys: new Set(),
    __zwxHdLocked: false,
    __zwxDisplaySuppressed: true,
    __zwxStartupWarming: false,
    __zwxWarmGeneration: 0,
    __zwxRunwayGeneration: 0,
    __zwxRunwayTimer: 0,
    __zwxRunwayFrames: 0,
    __zwxRunwayLogged: false,
    __zwxCacheGeneration: 0,
    __zwxCacheTimer: 0
  });

  const originalSetVisible = layer.setVisible;
  const originalSetEnabled = layer.setEnabled;
  const originalEvictExcept = layer.evictExcept;
  const originalRender = layer.render;
  const originalHasFrame = layer.hasFrame;
  const originalActivateFrame = layer.activateFrame;
  const originalSetBlendFrames = layer.setBlendFrames;

  layer.render = function (gl, matrix) {
    if (this.__zwxDisplaySuppressed) return;
    return originalRender.call(this, gl, matrix);
  };

  layer.hasFrame = function (frameId, ids) {
    const ready = originalHasFrame.call(this, frameId, ids);
    if (!ready && this.enabled) {
      if (!this.__zwxHdLocked) suppress(this, true);
      const wanted = normalizeIds(ids?.length ? ids : this.__zwxRequestedVisibleIds);
      if (wanted.length) {
        scheduleRunway(this, wanted, 0);
        scheduleArchiveCache(this, wanted, 120, "native");
      }
    }
    return ready;
  };

  layer.activateFrame = function (...activateArgs) {
    const ready = originalActivateFrame.apply(this, activateArgs);
    if (ready) {
      if (this.enabled && this.__zwxRequestedVisibleIds.length) {
        this.__zwxHdLocked = true;
        suppress(this, false);
        scheduleRunway(this, this.__zwxRequestedVisibleIds, 0);
      }
    } else if (!this.__zwxHdLocked) {
      suppress(this, true);
    }
    return ready;
  };

  layer.setBlendFrames = function (...blendArgs) {
    const ready = originalSetBlendFrames.apply(this, blendArgs);
    if (ready) {
      if (this.enabled) {
        this.__zwxHdLocked = true;
        suppress(this, false);
      }
      scheduleRunway(this, this.__zwxRequestedVisibleIds, 30);
    } else if (!this.__zwxHdLocked) {
      suppress(this, true);
    }
    return ready;
  };

  layer.setVisible = function (ids) {
    const nextIds = normalizeIds(ids);
    const changed = signature(nextIds) !== signature(this.__zwxRequestedVisibleIds);
    this.__zwxRequestedVisibleIds = nextIds;
    const output = originalSetVisible.call(this, nextIds);
    if (!this.enabled || !nextIds.length) return output;

    if (gpuHasFrames(this, nextIds, STARTUP_FRAMES)) {
      mergeReadyIds(this, nextIds);
      this.__zwxHdLocked = true;
      suppress(this, false);
      scheduleRunway(this, nextIds, 0);
      scheduleArchiveCache(this, nextIds, 100, "native");
    } else if (changed) {
      this.__zwxHdLocked = false;
      suppress(this, true);
      prepareRegion(this, nextIds, "native");
    } else {
      if (!this.__zwxHdLocked) suppress(this, true);
      prepareRegion(this, nextIds, "native");
    }
    return output;
  };

  layer.setEnabled = function (enabled) {
    const output = originalSetEnabled.call(this, enabled);
    if (!enabled) {
      this.__zwxHdLocked = false;
      suppress(this, true);
      schedulePredictive(this, 50);
      return output;
    }
    const actualIds = visibleChunkIds(this.map);
    if (actualIds.length) this.__zwxRequestedVisibleIds = actualIds;
    if (actualIds.length && gpuHasFrames(this, actualIds, STARTUP_FRAMES)) {
      mergeReadyIds(this, actualIds);
      this.__zwxHdLocked = true;
      suppress(this, false);
      scheduleRunway(this, actualIds, 0);
      scheduleArchiveCache(this, actualIds, 80, "native");
      console.info("MRALA native handoff: startup frames already GPU-ready; switching without full-loop VRAM gate");
    } else if (actualIds.length) {
      this.__zwxHdLocked = false;
      suppress(this, true);
      prepareRegion(this, actualIds, "native");
    }
    return output;
  };

  layer.evictExcept = function (keep) {
    const combined = new Set(keep || []);
    for (const key of this.__zwxPinnedGpuKeys || []) combined.add(key);
    return originalEvictExcept.call(this, combined);
  };

  window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__ = layer;
  window.__ZWX_MRALA_MISSING_NATIVE_URLS__ = missingUrls;

  const cameraSettled = () => {
    if (layer.enabled) {
      const ids = visibleChunkIds(layer.map);
      if (ids.length) prepareRegion(layer, ids, "native");
    } else schedulePredictive(layer, 100);
  };
  layer.map?.on?.("moveend", cameraSettled);
  layer.map?.on?.("zoomend", cameraSettled);
  setTimeout(() => schedulePredictive(layer, 0), 0);
  if (!pollTimer) pollTimer = setInterval(poll, 60 * 1000);

  console.info(
    "MRALA archive player v8: full 3h history persists in browser cache • " +
    STARTUP_FRAMES + "-frame native startup • " + RUNWAY_TARGET +
    "-frame rolling GPU runway • same-viewport HD never drops back to overview"
  );
  return result;
};
})();
