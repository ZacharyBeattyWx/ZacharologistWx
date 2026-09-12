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
const NATIVE_TARGET_ZOOM = 5.65;
const PREDICTIVE_MAX_ZOOM = 6.05;
const CORE_VIEWPORT_PAD = 0.12;
const PREDICTIVE_PADDING = 1 + CORE_VIEWPORT_PAD * 2;
const PREDICTIVE_START_ZOOM = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 4.4 : 3.25;
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
const LOAD_CONCURRENCY = MOBILE ? 2 : 6;
const LIVE_CONCURRENCY = MOBILE ? 1 : 3;
let manifest = null;
let memoryBytes = 0;
let cachePromise = null;
let persistentWritesAllowed = true;
let lastPrune = 0;
let pollTimer = 0;
let predictiveTimer = 0;
let lastPredictiveZoom = NATIVE_TARGET_ZOOM;
const memory = new Map();
const pinnedUrls = new Set();
const missingUrls = new Set();
const inflight = new Map();
const previousFetch = fetch.bind(window);
const urlOf = input => String(typeof input === "string" ? input : input?.url || "");
const frameMs = frame => Date.parse(frame?.valid_time || frame?.validTime || "");
const textureKey = (frameId, chunkId) => `${frameId}:${chunkId}`;
const normalizeIds = ids => [...new Set((ids || []).map(String))].sort();
const signature = ids => normalizeIds(ids).join("|");
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
const value = memory.get(candidate);
memory.delete(candidate);
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
function readyCovers(layer, ids) {
const wanted = normalizeIds(ids);
if (!wanted.length || !layer?.__zwxReadyChunkIds?.size) return false;
for (const id of wanted) if (!layer.__zwxReadyChunkIds.has(id)) return false;
const frames = recentFrames();
const byId = chunkMap();
const chunksForView = wanted.map(id => byId.get(id)).filter(Boolean);
if (!frames.length || chunksForView.length !== wanted.length) return false;
const needed = gpuPlan(frames, chunksForView);
if (needed.full && !layer.__zwxFullGpuResident) return false;
if (!needed.full && Number(layer.__zwxGpuResidentFrames || 0) < needed.count) return false;
return true;
}
function chooseWarmIds(layer, requestedIds) {
const requested = normalizeIds(requestedIds);
if (!requested.length) return [];
const existing = normalizeIds([
...(layer?.__zwxReadyChunkIds || []),
...(layer?.__zwxRegionWarmIds || [])
]);
if (!existing.length) return requested;
const union = normalizeIds([...existing, ...requested]);
const frames = recentFrames();
const byId = chunkMap();
const unionChunks = union.map(id => byId.get(id)).filter(Boolean);
if (!frames.length || unionChunks.length !== union.length) return requested;
return gpuPlan(frames, unionChunks).full ? union : requested;
}
async function repairGpuSet(layer, gpuTargets, gpuPins, generation) {
for (let pass = 0; pass < 3; pass += 1) {
if (generation !== layer.__zwxRegionWarmGeneration) return false;
const missing = gpuTargets.filter(target => !layer.textures.has(textureKey(target.frame.id, target.chunk.id)));
if (!missing.length) return true;
console.info("MRALA native GPU validation: repairing", missing.length, "texture(s)");
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
async function warmRegion(layer, ids, generation, reason = "native", progress) {
if (!layer || !ids?.length || !manifest) return { ready: false };
const normalizedIds = normalizeIds(ids);
const byId = chunkMap();
const chunksForView = normalizedIds.map(id => byId.get(id)).filter(Boolean);
const frames = recentFrames();
if (!chunksForView.length || chunksForView.length !== normalizedIds.length || !frames.length) {
return { ready: false };
}
const hadVisibleCoverage = readyCovers(layer, layer.__zwxRequestedVisibleIds);
const previousPins = new Set(layer.__zwxPinnedGpuKeys || []);
layer.__zwxArchiveSessionActive = true;
layer.__zwxArchiveFrameIds = frames.map(frame => String(frame.id));
layer.__zwxRegionWarming = true;
layer.__zwxRegionWarmIds = [...normalizedIds];
if (layer.enabled && !hadVisibleCoverage) {
layer.__zwxSetArchiveSuppressed?.(true);
}
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
const warmPins = new Set(previousPins);
for (const target of gpuTargets) warmPins.add(textureKey(target.frame.id, target.chunk.id));
layer.__zwxPinnedGpuKeys = warmPins;
let cursor = 0;
let completed = 0;
let failed = 0;
const started = performance.now();
async function worker() {
while (cursor < targets.length) {
if (generation !== layer.__zwxRegionWarmGeneration) return;
const target = targets[cursor++];
try {
if (gpuFrameIds.has(String(target.frame.id))) await gpuTarget(layer, target, warmPins);
else await bytes(target.url);
} catch (error) {
failed += 1;
console.warn("MRALA native archive warm failed", target.frame?.id, target.chunk?.id, error);
} finally {
completed += 1;
progress?.(completed, targets.length, plan.full);
}
}
}
await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, targets.length) }, () => worker()));
if (generation !== layer.__zwxRegionWarmGeneration) return { ready: false, superseded: true };
const gpuComplete = await repairGpuSet(layer, gpuTargets, warmPins, generation);
if (generation !== layer.__zwxRegionWarmGeneration) return { ready: false, superseded: true };
if (failed || !gpuComplete) {
layer.__zwxRegionWarming = false;
layer.__zwxRegionWarmIds = [];
layer.__zwxPinnedGpuKeys = previousPins;
if (layer.enabled && !readyCovers(layer, layer.__zwxRequestedVisibleIds)) {
layer.__zwxSetArchiveSuppressed?.(true);
}
console.warn("MRALA native region withheld: archive/GPU set incomplete", { failed, gpuComplete });
return { ready: false, failed, gpuComplete };
}
const finalPins = new Set(gpuTargets.map(target => textureKey(target.frame.id, target.chunk.id)));
layer.__zwxReadyChunkIds = new Set(normalizedIds);
layer.__zwxRegionReadySignature = signature(normalizedIds);
layer.__zwxFullGpuResident = plan.full;
layer.__zwxGpuResidentFrames = plan.count;
layer.__zwxPinnedGpuKeys = finalPins;
layer.__zwxRegionWarming = false;
layer.__zwxRegionWarmIds = [];
pinnedUrls.clear();
trimMemory();
prune(true).catch(() => {});
window.__ZWX_MRALA_ARCHIVE_SESSION__ = {
revision: String(manifest?.revision || ""),
frameIds: [...layer.__zwxArchiveFrameIds],
readyChunkIds: [...layer.__zwxReadyChunkIds],
fullGpuResident: plan.full,
gpuFrames: plan.count,
persistentCache: CACHE_NAME,
reason,
startedAt: new Date().toISOString()
};
if (!pollTimer) pollTimer = setInterval(poll, 60 * 1000);
if (layer.enabled && readyCovers(layer, layer.__zwxRequestedVisibleIds)) {
layer.__zwxSetArchiveSuppressed?.(false);
}
layer.map?.triggerRepaint();
console.info(
reason === "predictive" ? "MRALA predicted native region READY:" : "MRALA native region READY:",
frames.length + " frames",
chunksForView.length + " chunks/frame",
plan.full ? "FULL LOOP GPU-resident" : plan.count + " GPU frames + full local archive",
gpuTargets.length + " validated textures",
Math.round(performance.now() - started) + " ms"
);
return { ready: true, fullGpuResident: plan.full, gpuFrames: plan.count };
}
function scheduleRegion(layer, ids, delay = 20, reason = "native", progress) {
if (!layer || !ids?.length || !manifest) return Promise.resolve({ ready: false });
const requestedIds = normalizeIds(ids);
if (readyCovers(layer, requestedIds)) {
return Promise.resolve({ ready: true, cached: true, fullGpuResident: layer.__zwxFullGpuResident });
}
const targetIds = chooseWarmIds(layer, requestedIds);
const wanted = signature(targetIds);
if (layer.__zwxRegionWarming && layer.__zwxRegionWarmSignature === wanted && layer.__zwxRegionWarmPromise) {
return layer.__zwxRegionWarmPromise;
}
const generation = ++layer.__zwxRegionWarmGeneration;
clearTimeout(layer.__zwxRegionWarmTimer);
layer.__zwxRegionWarmSignature = wanted;
layer.__zwxRegionWarmIds = [...targetIds];
layer.__zwxRegionWarming = true;
const promise = new Promise(resolve => {
layer.__zwxRegionWarmTimer = setTimeout(() => {
warmRegion(layer, targetIds, generation, reason, progress)
.then(resolve)
.catch(error => {
if (generation === layer.__zwxRegionWarmGeneration) {
layer.__zwxRegionWarming = false;
layer.__zwxRegionWarmIds = [];
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
west -= lonPad;
east += lonPad;
south -= latPad;
north += latPad;
return idsForBounds(west, south, east, north);
}
function lonToWorldX(lon, worldSize) {
return (Number(lon) + 180) / 360 * worldSize;
}
function latToWorldY(lat, worldSize) {
const clamped = Math.max(-85.051129, Math.min(85.051129, Number(lat)));
const rad = clamped * Math.PI / 180;
const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
return y * worldSize;
}
function worldXToLon(x, worldSize) {
return x / worldSize * 360 - 180;
}
function worldYToLat(y, worldSize) {
const n = Math.PI - 2 * Math.PI * (y / worldSize);
return 180 / Math.PI * Math.atan(Math.sinh(n));
}
function predictedNativeChunkIds(map) {
if (!map || !manifest?.nativeChunking?.layout?.length) return [];
const center = map.getCenter?.();
const container = map.getContainer?.();
if (!center || !container) return [];
const width = Math.max(320, Number(container.clientWidth || 0)) * PREDICTIVE_PADDING;
const height = Math.max(240, Number(container.clientHeight || 0)) * PREDICTIVE_PADDING;
const frames = recentFrames();
const byId = chunkMap();
let fallback = [];
for (let targetZoom = NATIVE_TARGET_ZOOM; targetZoom <= PREDICTIVE_MAX_ZOOM + 0.001; targetZoom += 0.10) {
const worldSize = 512 * Math.pow(2, targetZoom);
const cx = lonToWorldX(center.lng, worldSize);
const cy = latToWorldY(center.lat, worldSize);
const west = worldXToLon(cx - width / 2, worldSize);
const east = worldXToLon(cx + width / 2, worldSize);
const north = worldYToLat(cy - height / 2, worldSize);
const south = worldYToLat(cy + height / 2, worldSize);
const ids = normalizeIds(idsForBounds(west, south, east, north));
if (!ids.length) continue;
fallback = ids;
const chunksForView = ids.map(id => byId.get(id)).filter(Boolean);
if (frames.length && chunksForView.length === ids.length && gpuPlan(frames, chunksForView).full) {
lastPredictiveZoom = targetZoom;
return ids;
}
}
lastPredictiveZoom = PREDICTIVE_MAX_ZOOM;
return fallback;
}
function schedulePredictive(layer, delay = 200) {
clearTimeout(predictiveTimer);
predictiveTimer = setTimeout(() => {
if (!layer?.map || !manifest) return;
const zoom = Number(layer.map.getZoom?.() || 0);
if (zoom < PREDICTIVE_START_ZOOM) return;
if (layer.enabled) {
const actualIds = visibleChunkIds(layer.map);
if (actualIds.length && !readyCovers(layer, actualIds)) {
scheduleRegion(layer, actualIds, 0, "native");
}
return;
}
const predictedIds = predictedNativeChunkIds(layer.map);
if (!predictedIds.length || readyCovers(layer, predictedIds)) return;
scheduleRegion(layer, predictedIds, 0, "predictive");
console.info(
"MRALA predictive HD warm:",
predictedIds.length + " future native chunk(s)",
"for z" + lastPredictiveZoom.toFixed(2),
"full-loop GPU-budgeted with production 12% viewport pad"
);
}, delay);
}
async function stageNewFrames(layer, newFrames) {
const readyIds = [...(layer.__zwxReadyChunkIds || [])];
if (!readyIds.length) return;
const byId = chunkMap();
const chunksForView = readyIds.map(id => byId.get(String(id))).filter(Boolean);
if (!chunksForView.length) return;
const validFrameIds = new Set(recentFrames().map(frame => String(frame.id)));
layer.__zwxPinnedGpuKeys = new Set(
[...(layer.__zwxPinnedGpuKeys || [])].filter(key => validFrameIds.has(String(key).split(":")[0]))
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
if (layer.__zwxFullGpuResident && !layer.__zwxRegionWarming) {
layer.__zwxPinnedGpuKeys.add(textureKey(target.frame.id, target.chunk.id));
await gpuTarget(layer, target, layer.__zwxPinnedGpuKeys);
} else {
await bytes(target.url);
}
} catch {}
}
}
await Promise.all(Array.from({ length: Math.min(LIVE_CONCURRENCY, targets.length) }, () => worker()));
layer.map?.triggerRepaint();
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
if (added.length) stageNewFrames(layer, added).catch(() => {});
schedulePredictive(layer, 40);
}
if (added.length && source === "poll") {
console.info("MRALA live edge:", added.length, "new scan(s) appended; prior archive reused");
}
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
__zwxRegionWarmIds: [],
__zwxArchiveSessionActive: false,
__zwxArchiveFrameIds: [],
__zwxReadyChunkIds: new Set(),
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
function suppress(value) {
const next = Boolean(value);
if (layer.__zwxDisplaySuppressed === next) return;
layer.__zwxDisplaySuppressed = next;
layer.map?.triggerRepaint();
}
layer.__zwxSetArchiveSuppressed = suppress;
layer.render = function (gl, matrix) {
if (this.__zwxDisplaySuppressed || !readyCovers(this, this.__zwxRequestedVisibleIds)) return;
return originalRender.call(this, gl, matrix);
};
layer.hasFrame = function (frameId, ids) {
const ready = originalHasFrame.call(this, frameId, ids);
if (!ready && this.enabled) {
suppress(true);
if (!this.__zwxRegionWarming) {
scheduleRegion(this, ids?.length ? ids : this.__zwxRequestedVisibleIds, 0, "native");
}
}
return ready;
};
layer.activateFrame = function (...args) {
const ready = originalActivateFrame.apply(this, args);
suppress(!(ready && readyCovers(this, this.__zwxRequestedVisibleIds)));
return ready;
};
layer.setBlendFrames = function (...args) {
const ready = originalSetBlendFrames.apply(this, args);
suppress(!(ready && readyCovers(this, this.__zwxRequestedVisibleIds)));
return ready;
};
layer.setVisible = function (ids) {
const nextIds = normalizeIds(ids);
this.__zwxRequestedVisibleIds = nextIds;
this.__zwxViewportSignature = signature(nextIds);
const output = originalSetVisible.call(this, nextIds);
if (!this.enabled) return output;
if (readyCovers(this, nextIds)) {
suppress(false);
} else if (nextIds.length) {
suppress(true);
scheduleRegion(this, nextIds, 0, "native");
}
return output;
};
layer.setEnabled = function (enabled) {
const output = originalSetEnabled.call(this, enabled);
if (!enabled) {
suppress(true);
schedulePredictive(this, 60);
return output;
}
const actualIds = visibleChunkIds(this.map);
if (actualIds.length) {
this.__zwxRequestedVisibleIds = actualIds;
this.__zwxViewportSignature = signature(actualIds);
}
if (actualIds.length && readyCovers(this, actualIds)) {
suppress(false);
console.info("MRALA native handoff: GPU-budgeted predicted archive already ready; switching immediately");
} else if (actualIds.length) {
suppress(true);
scheduleRegion(this, actualIds, 0, "native");
}
return output;
};
layer.evictExcept = function (keep) {
const combined = new Set(keep || []);
for (const key of this.__zwxPinnedGpuKeys || []) combined.add(key);
return originalEvictExcept.call(this, combined);
};
layer.__zwxPrepareArchiveForPlay = async function (progress) {
if (!this.enabled) return { ready: true, overview: true };
const ids = this.__zwxRequestedVisibleIds?.length
? [...this.__zwxRequestedVisibleIds]
: visibleChunkIds(this.map);
if (!ids.length || !manifest) return { ready: false };
if (readyCovers(this, ids)) {
return { ready: true, cached: true, fullGpuResident: this.__zwxFullGpuResident };
}
return scheduleRegion(this, ids, 0, "native", progress);
};
layer.__zwxPrepareHdForPlay = layer.__zwxPrepareArchiveForPlay;
layer.__zwxScheduleArchiveRegionPrefetch = ids =>
scheduleRegion(layer, ids || layer.__zwxRequestedVisibleIds, 0, "native");
window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__ = layer;
window.__ZWX_MRALA_MISSING_NATIVE_URLS__ = missingUrls;
const cameraSettled = () => schedulePredictive(layer, 120);
layer.map?.on?.("moveend", cameraSettled);
layer.map?.on?.("zoomend", cameraSettled);
setTimeout(() => schedulePredictive(layer, 0), 0);
console.info(
"MRALA archive player v7: predictive footprint is full-loop GPU-budgeted • production 12% pad retained • oversized preloads auto-tighten before native handoff"
);
return result;
};
addEventListener("DOMContentLoaded", () => {
const button = document.getElementById("playPause");
if (!button) return;
button.addEventListener("click", async event => {
const layer = window.__ZWX_MRALA_NATIVE_CHUNK_LAYER__;
if (!layer?.enabled || /Pause/i.test(String(button.textContent || ""))) return;
if (layer.__zwxBypassPlayGate) {
layer.__zwxBypassPlayGate = false;
return;
}
const ids = layer.__zwxRequestedVisibleIds?.length
? layer.__zwxRequestedVisibleIds
: visibleChunkIds(layer.map);
if (ids.length && readyCovers(layer, ids)) return;
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