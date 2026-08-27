(() => {
  const TARGET_2X_DISPLAY_FRAMES = 180;
  const TIMELAPSE_INTERVAL_MS = 40;
  const PATCH_RETRY_MS = 50;
  const PATCH_TIMEOUT_MS = 10000;
  const startedAt = Date.now();

  function readyToPatch() {
    try {
      return (
        typeof playbackLoop === "function" &&
        typeof playbackIntervalMs === "function" &&
        typeof warmAround === "function" &&
        typeof primePlaybackBuffer === "function" &&
        typeof loadFrameSource === "function" &&
        typeof showFrame === "function" &&
        typeof speedSelect !== "undefined"
      );
    } catch (_) {
      return false;
    }
  }

  function speedValue() {
    return Math.max(0.25, Number(speedSelect?.value) || 1);
  }

  function playbackStride() {
    if (speedValue() < 2 || !Array.isArray(frames) || frames.length < 2) return 1;
    return Math.max(1, Math.ceil(frames.length / TARGET_2X_DISPLAY_FRAMES));
  }

  function nextPlaybackIndex() {
    if (!frames.length) return 0;
    if (currentFrameIndex >= frames.length - 1) return 0;
    return Math.min(frames.length - 1, currentFrameIndex + playbackStride());
  }

  function patch() {
    if (!readyToPatch()) {
      if (Date.now() - startedAt < PATCH_TIMEOUT_MS) {
        window.setTimeout(patch, PATCH_RETRY_MS);
      }
      return;
    }

    if (window.__ZWX_MRMS_TIMELAPSE_PATCHED__) return;
    window.__ZWX_MRMS_TIMELAPSE_PATCHED__ = true;

    const originalPlaybackIntervalMs = playbackIntervalMs;
    const originalWarmAround = warmAround;
    const originalPrimePlaybackBuffer = primePlaybackBuffer;

    playbackIntervalMs = function () {
      if (speedValue() >= 2) return TIMELAPSE_INTERVAL_MS;
      return originalPlaybackIntervalMs();
    };

    warmAround = function (index) {
      if (speedValue() < 2) {
        return originalWarmAround(index);
      }
      if (!frames.length) return;

      const stride = playbackStride();
      const ahead = Math.min(10, frames.length - 1);
      for (let offset = 1; offset <= ahead; offset += 1) {
        const target = (index + (offset * stride)) % frames.length;
        loadFrameSource(frames[target]).catch(() => {});
      }

      const previous = (index - stride + frames.length) % frames.length;
      loadFrameSource(frames[previous]).catch(() => {});
    };

    primePlaybackBuffer = async function (startIndex) {
      if (speedValue() < 2) {
        return originalPrimePlaybackBuffer(startIndex);
      }
      if (!frames.length) return;

      const stride = playbackStride();
      const count = Math.min(8, frames.length);
      const jobs = [];
      for (let offset = 0; offset < count; offset += 1) {
        const target = (startIndex + (offset * stride)) % frames.length;
        jobs.push(loadFrameSource(frames[target]));
      }
      await Promise.all(jobs);
      warmAround(startIndex);
    };

    playbackLoop = async function (generation) {
      if (!isPlaying || generation !== playbackGeneration || frames.length < 2) return;

      const cycleStarted = performance.now();
      const next = nextPlaybackIndex();
      await showFrame(next, { quiet: true });
      if (!isPlaying || generation !== playbackGeneration) return;

      const atNewest = currentFrameIndex === frames.length - 1;
      const workTime = performance.now() - cycleStarted;
      const cadenceDelay = Math.max(0, playbackIntervalMs() - workTime);
      const endHold = atNewest
        ? (speedValue() >= 2 ? 300 : END_FRAME_HOLD_MS)
        : 0;

      window.setTimeout(
        () => playbackLoop(generation),
        cadenceDelay + endHold
      );
    };

    speedSelect.addEventListener("change", () => {
      warmAround(currentFrameIndex);
    });

    console.info(
      "MRMS 2x timelapse enabled:",
      `${TIMELAPSE_INTERVAL_MS}ms cadence, target ~${TARGET_2X_DISPLAY_FRAMES} displayed scans per long loop`
    );
  }

  patch();
})();
