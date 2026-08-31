(() => {
  "use strict";

  const startedAt = Date.now();
  const PATCH_TIMEOUT_MS = 12000;
  const PATCH_RETRY_MS = 50;
  const FAST_LOOKAHEAD = 5;
  const START_AHEAD = 3;

  function ready() {
    try {
      return (
        window.__ZWX_MRMS_TIMELAPSE_V2_PATCHED__ === true &&
        typeof warmAround === "function" &&
        typeof primePlaybackBuffer === "function" &&
        typeof loadFrameSource === "function" &&
        typeof speedSelect !== "undefined" &&
        Array.isArray(frames)
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
    const selectedMinutes = Math.max(30, Number(historyMinutes) || 60);
    const proportionalStride = Math.max(2, Math.round(selectedMinutes / 120));
    return Math.max(1, Math.min(8, proportionalStride, frames.length - 1));
  }

  function install() {
    if (window.__ZWX_MRMS_PLAYBACK_PERFORMANCE__) return true;
    if (!ready()) return false;

    window.__ZWX_MRMS_PLAYBACK_PERFORMANCE__ = true;

    const originalWarmAround = warmAround;
    const originalPrimePlaybackBuffer = primePlaybackBuffer;

    warmAround = function (index) {
      if (speedValue() < 2) return originalWarmAround(index);
      if (!frames.length) return;

      const stride = playbackStride();
      const targets = new Set();

      for (let offset = 1; offset <= FAST_LOOKAHEAD; offset += 1) {
        const target = Math.min(frames.length - 1, index + (offset * stride));
        if (target !== index) targets.add(target);
      }

      // Forward playback does not need to keep re-decoding the previous keyframe.
      // Keep the active working set comfortably below the core decoded cache limit.
      targets.forEach(target => {
        loadFrameSource(frames[target]).catch(() => {});
      });
    };

    primePlaybackBuffer = async function (startIndex) {
      if (speedValue() < 2) return originalPrimePlaybackBuffer(startIndex);
      if (!frames.length) return;

      const stride = playbackStride();
      const targets = [];
      const seen = new Set();

      for (let offset = 1; offset <= START_AHEAD; offset += 1) {
        const target = Math.min(frames.length - 1, startIndex + (offset * stride));
        if (target === startIndex || seen.has(target)) continue;
        seen.add(target);
        targets.push(target);
      }

      // Get only the immediately-needed 2x keyframes ready before playback starts.
      // Remaining lookahead is warmed in the background instead of blocking Play.
      await Promise.all(targets.slice(0, 2).map(target => loadFrameSource(frames[target])));
      targets.slice(2).forEach(target => {
        loadFrameSource(frames[target]).catch(() => {});
      });
      warmAround(startIndex);
    };

    console.info(
      "MRMS 2x playback performance enabled:",
      `${FAST_LOOKAHEAD}-keyframe forward lookahead with reduced decode/cache churn`
    );
    return true;
  }

  function patchWhenReady() {
    if (install()) return;
    if (Date.now() - startedAt < PATCH_TIMEOUT_MS) {
      window.setTimeout(patchWhenReady, PATCH_RETRY_MS);
    }
  }

  patchWhenReady();
})();
