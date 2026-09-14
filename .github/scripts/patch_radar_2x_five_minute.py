from pathlib import Path

ROOT = Path('.')


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    s = text.find(start)
    if s < 0:
        raise SystemExit(f'{label}: start marker not found')
    e = text.find(end, s)
    if e < 0:
        raise SystemExit(f'{label}: end marker not found')
    return text[:s] + replacement + text[e:]


# ---------------------------------------------------------------------------
# Production page: at 2x show one observation per 5-minute time bucket.
# Overview/native rolling buffers follow the same display sequence.
# ---------------------------------------------------------------------------
path = 'mosaic-radar-home.html'
text = read(path)

text = replace_once(
    text,
    '<script src="mapbox-token.js?v=20260904c"></script>',
    '<script src="mapbox-token.js?v=20260914c"></script>',
    'production mapbox-token cache key',
)
text = replace_once(
    text,
    '<option value="50">2×</option>',
    '<option value="210">2×</option>',
    'production 2x fallback cadence',
)

interval_block = '''  function intervalMs(){
    return Math.max(
      40,
      Number(speedSelect.value)||100
    );
  }

  const X2_BUCKET_MS=
    5*60*1000;

  function fiveMinuteX2Enabled(){
    return String(
      speedSelect.selectedOptions?.[0]?.textContent
      ||""
    ).trim()==="2×";
  }

  function nextPlaybackIndex(
    index=currentIndex
  ){
    if(!frames.length){
      return 0;
    }

    const normalized=
      (
        Number(index)
        +frames.length
      )%frames.length;

    const sequential=
      (normalized+1)
      %frames.length;

    if(
      !fiveMinuteX2Enabled()
      ||normalized===frames.length-1
    ){
      return sequential;
    }

    const currentMs=
      frameMs(
        frames[normalized]
      );

    if(!Number.isFinite(currentMs)){
      return sequential;
    }

    const nextBucket=
      (
        Math.floor(
          currentMs/X2_BUCKET_MS
        )+1
      )*X2_BUCKET_MS;

    for(
      let candidate=normalized+1;
      candidate<frames.length;
      candidate++
    ){
      const candidateMs=
        frameMs(
          frames[candidate]
        );

      if(
        Number.isFinite(candidateMs)
        &&candidateMs>=nextBucket
      ){
        return candidate;
      }
    }

    // Always show the newest observation before the normal loop-end hold.
    return frames.length-1;
  }

  function playbackIndicesFrom(
    start=currentIndex,
    count=1
  ){
    const indices=[];

    if(!frames.length){
      return indices;
    }

    let index=
      (
        Number(start)
        +frames.length
      )%frames.length;

    const seen=
      new Set();

    while(
      indices.length<Math.min(count,frames.length)
      &&!seen.has(index)
    ){
      seen.add(index);
      indices.push(index);
      index=nextPlaybackIndex(index);
    }

    return indices;
  }

  console.info(
    "MRALA 2x playback: one displayed scan per 5-minute time bucket • 210ms presentation cadence"
  );

'''
text = replace_between(
    text,
    '  function intervalMs(){',
    '  function stopPlayback(){',
    interval_block,
    'production interval/stride helpers',
)

desired_block = '''  function desiredIndices(
    start=currentIndex,
    tier=BASE_TIER
  ){
    const set=
      new Set();

    if(!frames.length){
      return set;
    }

    const limit=
      Math.min(
        gpuDepth(tier),
        frames.length
      );

    for(
      const index
      of playbackIndicesFrom(
        start,
        limit
      )
    ){
      set.add(index);
    }

    return set;
  }

'''
text = replace_between(
    text,
    '  function desiredIndices(',
    '  function countReadyAhead(',
    desired_block,
    'production overview desired indices',
)

count_block = '''  function countReadyAhead(
    start=currentIndex,
    tier=BASE_TIER
  ){
    let count=0;

    const limit=
      Math.min(
        gpuDepth(tier),
        frames.length
      );

    for(
      const index
      of playbackIndicesFrom(
        start,
        limit
      )
    ){
      if(
        !layer.hasTexture(
          textureKey(
            index,
            tier
          )
        )
      ){
        break;
      }

      count++;
    }

    return count;
  }

'''
text = replace_between(
    text,
    '  function countReadyAhead(',
    '  async function fillBuffer(',
    count_block,
    'production overview ready count',
)

text = replace_between(
    text,
    '    const frameIndices=[];',
    '    const targets=[];',
    '''    const frameIndices=
      playbackIndicesFrom(
        currentIndex,
        Math.min(
          CHUNK_FRAME_DEPTH,
          frames.length
        )
      );

''',
    'production native rolling indices',
)

text = replace_once(
    text,
    '''    const nextIndex=
      (currentIndex+1)
      %frames.length;''',
    '''    const nextIndex=
      nextPlaybackIndex(
        currentIndex
      );''',
    'production playback next index',
)
write(path, text)


# ---------------------------------------------------------------------------
# mapbox-token: 36-ish 5-minute display steps at ~210 ms keeps the complete
# three-hour loop close to half the duration of 1x without 90 rapid transitions.
# ---------------------------------------------------------------------------
path = 'mapbox-token.js'
text = read(path)
text = replace_once(text, '["2×", "85"]', '["2×", "210"]', 'mapbox 2x cadence')
text = replace_once(
    text,
    '"MRALA playback cadence: 0.5x 340ms • 1x 170ms • 1.5x 115ms • 2x 85ms"',
    '"MRALA playback cadence: 0.5x 340ms • 1x 170ms • 1.5x 115ms • 2x 210ms with 5-minute scan steps"',
    'mapbox cadence log',
)
text = replace_once(
    text,
    'scripts/radar/mrms-native-loop-prewarm.js?v=20260914b',
    'scripts/radar/mrms-native-loop-prewarm.js?v=20260914c',
    'mapbox helper cache key',
)
write(path, text)


# ---------------------------------------------------------------------------
# v12 guard: check the actual next 2x display target rather than a scan that
# 2x intentionally skips.
# ---------------------------------------------------------------------------
path = 'scripts/radar/mrms-native-playback-stability-v12.js'
text = read(path)
replacement = '''  const X2_BUCKET_MS = 5 * 60 * 1000;

  function fiveMinuteX2Enabled() {
    return String(
      document.getElementById("speedSelect")?.selectedOptions?.[0]?.textContent || ""
    ).trim() === "2×";
  }

  function nextDisplayIndex(frames, current) {
    if (!frames.length) return -1;
    const index = Math.max(0, Math.min(frames.length - 1, Number(current) || 0));
    const sequential = (index + 1) % frames.length;
    if (!fiveMinuteX2Enabled() || index === frames.length - 1) return sequential;

    const currentMs = frameMs(frames[index]);
    if (!Number.isFinite(currentMs)) return sequential;
    const nextBucket = (Math.floor(currentMs / X2_BUCKET_MS) + 1) * X2_BUCKET_MS;

    for (let candidate = index + 1; candidate < frames.length; candidate += 1) {
      const candidateMs = frameMs(frames[candidate]);
      if (Number.isFinite(candidateMs) && candidateMs >= nextBucket) return candidate;
    }
    return frames.length - 1;
  }

  function nextTimelineFrame() {
    const frames = timelineFrames();
    if (!frames.length) return null;
    const slider = document.getElementById("frameSlider");
    const current = Math.max(0, Math.min(frames.length - 1, Math.round(Number(slider?.value || 0))));
    return frames[nextDisplayIndex(frames, current)] || null;
  }

'''
text = replace_between(
    text,
    '  function nextTimelineFrame() {',
    '  function nextNativeFrameState(',
    replacement,
    'v12 next displayed frame',
)
text = replace_once(
    text,
    'MRALA archive player v12.2: native-only after HD lock • emergency guard only blocks real GPU texture misses • native-unavailable scans no longer stall the loop',
    'MRALA archive player v12.3: native-only after HD lock • 2x guard follows 5-minute display targets • native-unavailable scans do not stall the loop',
    'v12 version log',
)
text = text.replace('MRALA v12.2 guard PASS:', 'MRALA v12.3 guard PASS:')
text = text.replace('MRALA v12.2 playback guard HOLD:', 'MRALA v12.3 playback guard HOLD:')
text = text.replace('v13.1 hot runway', 'v13.2 hot runway')
write(path, text)


# ---------------------------------------------------------------------------
# v13 runway: preload the exact display sequence, including 5-minute 2x targets.
# ---------------------------------------------------------------------------
path = 'scripts/radar/mrms-native-timeline-runway-v13.js'
text = read(path)
target_replacement = '''  const X2_BUCKET_MS = 5 * 60 * 1000;

  function fiveMinuteX2Enabled() {
    return String(
      document.getElementById("speedSelect")?.selectedOptions?.[0]?.textContent || ""
    ).trim() === "2×";
  }

  function nextDisplayIndex(frames, current) {
    if (!frames.length) return -1;
    const index = Math.max(0, Math.min(frames.length - 1, Number(current) || 0));
    const sequential = (index + 1) % frames.length;
    if (!fiveMinuteX2Enabled() || index === frames.length - 1) return sequential;

    const currentMs = frameMs(frames[index]);
    if (!Number.isFinite(currentMs)) return sequential;
    const nextBucket = (Math.floor(currentMs / X2_BUCKET_MS) + 1) * X2_BUCKET_MS;

    for (let candidate = index + 1; candidate < frames.length; candidate += 1) {
      const candidateMs = frameMs(frames[candidate]);
      if (Number.isFinite(candidateMs) && candidateMs >= nextBucket) return candidate;
    }
    return frames.length - 1;
  }

  function targetFramesFromTimeline(count) {
    const frames = timelineFrames();
    if (!frames.length) return [];
    let current = playbackIndex(frames);
    if (current < 0) return [];

    const targets = [];
    const seen = new Set([current]);
    while (targets.length < count) {
      current = nextDisplayIndex(frames, current);
      if (current < 0 || seen.has(current)) break;
      seen.add(current);
      const frame = frames[current];
      if (frame?.nativeChunksReady) targets.push(frame);
    }
    return targets;
  }

'''
text = replace_between(
    text,
    '  function targetFramesFromTimeline(count) {',
    '  async function unpack(',
    target_replacement,
    'v13 display target sequence',
)
text = replace_once(
    text,
    'MRALA archive player v13.1: 8-frame desktop hot lane + staged 18-frame target runway • small cache→GPU batches replace monolithic 30-frame uploads',
    'MRALA archive player v13.2: staged hot runway follows actual display sequence • 2x preloads only 5-minute targets',
    'v13 version log',
)
text = text.replace('MRALA v13.1 staged runway:', 'MRALA v13.2 staged runway:')
write(path, text)


# ---------------------------------------------------------------------------
# v9 foundational runway: at 2x keep only the same five-minute display targets.
# ---------------------------------------------------------------------------
path = 'scripts/radar/mrms-native-loop-prewarm-v9-core.js'
text = read(path)
ordered_replacement = '''function fiveMinuteX2Enabled() {
  return String(
    document.getElementById("speedSelect")?.selectedOptions?.[0]?.textContent || ""
  ).trim() === "2×";
}

function nextDisplayIndex(frames, current) {
  if (!frames.length) return -1;
  const index = Math.max(0, Math.min(frames.length - 1, Number(current) || 0));
  const sequential = (index + 1) % frames.length;
  if (!fiveMinuteX2Enabled() || index === frames.length - 1) return sequential;

  const bucketMs = 5 * 60 * 1000;
  const currentMs = frameMs(frames[index]);
  if (!Number.isFinite(currentMs)) return sequential;
  const nextBucket = (Math.floor(currentMs / bucketMs) + 1) * bucketMs;
  for (let candidate = index + 1; candidate < frames.length; candidate += 1) {
    const candidateMs = frameMs(frames[candidate]);
    if (Number.isFinite(candidateMs) && candidateMs >= nextBucket) return candidate;
  }
  return frames.length - 1;
}

function orderedNativeFrames(layer) {
  const timeline = timelineFrames();
  if (!timeline.length) return [];

  const currentId = currentFrameId(layer);
  let index = timeline.findIndex(frame => String(frame.id) === currentId);
  if (index < 0) {
    index = Math.max(0, Math.min(timeline.length - 1, Number(document.getElementById("frameSlider")?.value || 0)));
  }

  if (!fiveMinuteX2Enabled()) {
    const frames = nativeFrames();
    let nativeIndex = frames.findIndex(frame => String(frame.id) === String(timeline[index]?.id || ""));
    if (nativeIndex < 0) {
      const currentMs = frameMs(timeline[index]);
      let best = 0;
      let distance = Infinity;
      for (let i = 0; i < frames.length; i += 1) {
        const nextDistance = Math.abs(frameMs(frames[i]) - currentMs);
        if (nextDistance < distance) { distance = nextDistance; best = i; }
      }
      nativeIndex = best;
    }
    return [...frames.slice(nativeIndex), ...frames.slice(0, nativeIndex)];
  }

  const ordered = [];
  const seen = new Set();
  let cursor = index;
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const frame = timeline[cursor];
    if (frame?.nativeChunksReady) ordered.push(frame);
    cursor = nextDisplayIndex(timeline, cursor);
    if (cursor < 0) break;
  }
  return ordered;
}

'''
text = replace_between(
    text,
    'function orderedNativeFrames(layer) {',
    'function runwayCount(ids) {',
    ordered_replacement,
    'v9 ordered native display sequence',
)
text = replace_once(text, 'MRALA archive player v9:', 'MRALA archive player v9.1:', 'v9 version log prefix')
write(path, text)


# ---------------------------------------------------------------------------
# Cache-bust patched helper layers.
# ---------------------------------------------------------------------------
path = 'scripts/radar/mrms-native-loop-prewarm.js'
text = read(path)
text = replace_once(text, 'mrms-native-loop-prewarm-v9-core.js?v=20260913a', 'mrms-native-loop-prewarm-v9-core.js?v=20260914c', 'wrapper v9 key')
text = replace_once(text, 'mrms-native-playback-stability-v12.js?v=20260914a', 'mrms-native-playback-stability-v12.js?v=20260914c', 'wrapper v12 key')
text = replace_once(text, 'mrms-native-timeline-runway-v13.js?v=20260913d', 'mrms-native-timeline-runway-v13.js?v=20260914c', 'wrapper v13 key')
write(path, text)

print('2x five-minute playback patch applied successfully')
