(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_NATIVE_REBUFFER_V18__) return;
  window.__ZWX_MRALA_NATIVE_REBUFFER_V18__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  const LOW_READY_BY_SPEED = new Map([
    ["0.5×", 1],
    ["1×", MOBILE ? 1 : 2],
    ["1.5×", MOBILE ? 1 : 2],
    ["2×", MOBILE ? 1 : 2]
  ]);

  const CHECK_MS = MOBILE ? 180 : 140;
  const LOW_SAMPLE_COUNT = 4;
  const PRIME_TIMEOUT_MS = MOBILE ? 7000 : 9000;
  const COOLDOWN_MS = 2200;

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxNativeRebufferV18Installed) return;
  mapPrototype.__zwxNativeRebufferV18Installed = true;

  let nativeLayer = null;
  let overviewLayer = null;
  let rebuffering = false;
  let lowSamples = 0;
  let lastRebufferAt = 0;
  let lastSpeed = "";

  function speedLabel() {
    return String(
      document.getElementById("speedSelect")?.selectedOptions?.[0]?.textContent ||
      "1×"
    ).trim();
  }

  function playButton() {
    return document.getElementById("playPause");
  }

  function isPlaying() {
    return /Pause/i.test(String(playButton()?.textContent || ""));
  }

  function nativeActive() {
    return Boolean(nativeLayer?.enabled);
  }

  function readyState() {
    try {
      return window.__ZWX_MRALA_READY_STATE__?.() || null;
    } catch (_) {
      return null;
    }
  }

  function pacingState() {
    try {
      return window.__ZWX_MRALA_NATIVE_PACING_STATE__?.() || null;
    } catch (_) {
      return null;
    }
  }

  function setRebuffering(value, reason = "") {
    rebuffering = Boolean(value);
    window.__ZWX_MRALA_NATIVE_REBUFFERING__ = rebuffering;
    const button = playButton();
    if (!button) return;

    if (rebuffering) {
      button.dataset.zwxV18OriginalText = button.textContent || "▶ Play";
      button.disabled = true;
      button.textContent = reason ? `Buffering ${reason}…` : "Buffering…";
    } else {
      button.disabled = false;
      const original = button.dataset.zwxV18OriginalText;
      if (original) button.textContent = original;
      delete button.dataset.zwxV18OriginalText;
    }
  }

  async function waitUntilReady() {
    const deadline = performance.now() + PRIME_TIMEOUT_MS;

    while (performance.now() < deadline) {
      const state = readyState();
      if (
        state &&
        state.targetFrames > 0 &&
        state.readyFrames >= state.targetFrames
      ) {
        return true;
      }
      await new Promise(resolve => window.setTimeout(resolve, 50));
    }

    const finalState = readyState();
    return Boolean(
      finalState &&
      finalState.targetFrames > 0 &&
      finalState.readyFrames >= finalState.targetFrames
    );
  }

  async function pausePrimeResume(reason) {
    if (rebuffering || !nativeActive()) return false;
    const button = playButton();
    if (!button) return false;

    const wasPlaying = isPlaying();
    if (!wasPlaying) return false;

    rebuffering = true;
    window.__ZWX_MRALA_NATIVE_REBUFFERING__ = true;
    lowSamples = 0;
    lastRebufferAt = performance.now();

    // Pause through the normal control path. v17 notices the pause and starts
    // its selected-speed idle warm immediately.
    button.click();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    setRebuffering(true, reason);

    const ready = await waitUntilReady();

    // Restore the actual paused button state before clicking it again.
    button.disabled = false;
    button.textContent = "▶ Play";
    delete button.dataset.zwxV18OriginalText;

    if (ready && nativeActive()) {
      button.click();
      console.info(
        "MRALA v18 native rebuffer:",
        reason,
        "• runway ready before resume",
        "• " + speedLabel()
      );
    } else {
      console.warn(
        "MRALA v18 native rebuffer timeout:",
        reason,
        readyState()
      );
    }

    rebuffering = false;
    window.__ZWX_MRALA_NATIVE_REBUFFERING__ = false;
    button.disabled = false;
    return ready;
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID && !layer.__zwxNativeRebufferV18OverviewPatched) {
      layer.__zwxNativeRebufferV18OverviewPatched = true;
      overviewLayer = layer;
      const originalRender = layer.render;
      if (typeof originalRender === "function") {
        layer.render = function(...renderArgs) {
          // During an intentional native rebuffer, keep overview hidden too.
          // The user should see a held native frame, never mixed quality.
          if (nativeLayer?.enabled && window.__ZWX_MRALA_NATIVE_REBUFFERING__) {
            return;
          }
          return originalRender.apply(this, renderArgs);
        };
      }
    }

    if (layer?.id === NATIVE_ID) {
      nativeLayer = layer;
    }

    return result;
  };

  window.addEventListener("DOMContentLoaded", () => {
    const speed = document.getElementById("speedSelect");
    lastSpeed = speedLabel();

    speed?.addEventListener("change", () => {
      const nextSpeed = speedLabel();
      const changed = nextSpeed !== lastSpeed;
      lastSpeed = nextSpeed;

      // v17 warms automatically while paused. If speed changes mid-play,
      // pause first so the larger selected-speed runway can actually be built.
      if (changed && nativeActive() && isPlaying()) {
        window.setTimeout(
          () => pausePrimeResume(`for ${nextSpeed}`),
          0
        );
      }
    });
  }, { once: true });

  window.setInterval(() => {
    if (rebuffering || !nativeActive() || !isPlaying()) {
      lowSamples = 0;
      return;
    }

    const state = pacingState();
    if (!state || !Number.isFinite(Number(state.readyAhead))) return;

    const floor = LOW_READY_BY_SPEED.get(speedLabel()) || 2;
    const ready = Number(state.readyAhead);

    if (ready < floor) {
      lowSamples += 1;
    } else {
      lowSamples = 0;
    }

    if (
      lowSamples >= LOW_SAMPLE_COUNT &&
      performance.now() - lastRebufferAt >= COOLDOWN_MS
    ) {
      lowSamples = 0;
      pausePrimeResume(`native ${ready}/${state.targetDepth || "?"}`);
    }
  }, CHECK_MS);

  console.info(
    "MRALA v18: speed changes rebuffer before resume • starvation guard holds native quality • overview stays hidden during internal buffering"
  );
})();