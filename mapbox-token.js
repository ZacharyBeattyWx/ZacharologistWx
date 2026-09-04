window.MAPBOX_PUBLIC_TOKEN = "pk.eyJ1IjoiemFjaGFyeWJlYXR0eXd4IiwiYSI6ImNtcGRpOHFxOTBja2Iyc29nOXBtNDJkOTgifQ.A5PX2kdbDFzGYOoHmmnrKg";

(() => {
  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-canvas-test\.html$/i.test(path)) return;

  // X2 playback is owned by the core radar scheduler and native-detail buffer.
  // Do not load the legacy timelapse/stride overrides here; they created
  // competing playback clocks.

  const performanceScript = document.createElement("script");
  performanceScript.src = "scripts/radar/mrms-playback-performance.js?v=20260904a";
  performanceScript.async = false;
  document.head.appendChild(performanceScript);

  const SCRUB_RETRY_MS = 50;
  const SCRUB_INSTALL_TIMEOUT_MS = 20000;
  const scrubInstallStartedAt = Date.now();

  function scrubReady() {
    try {
      return (
        typeof frameSlider !== "undefined" &&
        frameSlider &&
        typeof frames !== "undefined" &&
        Array.isArray(frames) &&
        typeof isPlaying !== "undefined" &&
        typeof showFrame === "function" &&
        typeof stopPlayback === "function" &&
        typeof updateFrameUi === "function"
      );
    } catch (_) {
      return false;
    }
  }

  function installFrameScrubber() {
    if (window.__ZWX_MRMS_FRAME_SCRUBBER__) return true;
    if (!scrubReady()) return false;

    window.__ZWX_MRMS_FRAME_SCRUBBER__ = true;

    const slider = frameSlider;
    const originalUpdateFrameUi = updateFrameUi;
    let scrubbing = false;
    let pointerActive = false;
    let scrubTarget = Number(slider.value) || 0;
    let pumpRunning = false;
    let finishRunning = false;
    let idleCommitTimer = null;

    function clampIndex(value) {
      if (!Array.isArray(frames) || !frames.length) return 0;
      const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
      return Math.max(0, Math.min(frames.length - 1, Math.round(numeric)));
    }

    function delay(ms) {
      return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    function holdThumbAtTarget() {
      if (!scrubbing) return;
      slider.value = String(clampIndex(scrubTarget));
    }

    // Frame activation updates the normal time/readout UI, but while a user is
    // physically scrubbing the timeline it must not yank the thumb backward to
    // whichever async texture happened to finish first.
    updateFrameUi = function (...args) {
      const result = originalUpdateFrameUi(...args);
      holdThumbAtTarget();
      return result;
    };

    function beginScrub() {
      if (scrubbing) return;
      stopPlayback();
      scrubbing = true;
      scrubTarget = clampIndex(slider.value);
      holdThumbAtTarget();
    }

    async function fastRequest(index) {
      // Native detail normally waits for a paused/manual frame to become fully
      // resident. During a drag that wait is exactly what makes the thumb feel
      // stuck. Borrow playback semantics only for this one request so the LOD
      // queues the desired frame and returns immediately if it is not ready.
      const wasPlaying = Boolean(isPlaying);
      if (!wasPlaying) isPlaying = true;
      try {
        return await showFrame(index, {
          quiet: true,
          scrubPreview: true
        });
      } finally {
        if (!wasPlaying) isPlaying = false;
      }
    }

    async function pumpScrub() {
      if (pumpRunning || !scrubbing) return;
      pumpRunning = true;

      try {
        while (scrubbing) {
          const requested = clampIndex(scrubTarget);
          const shown = await fastRequest(requested);
          holdThumbAtTarget();

          if (!scrubbing) break;
          if (requested !== clampIndex(scrubTarget)) continue;

          // If the requested native frame is still arriving, poll lightly.
          // This coalesces hundreds of slider input events into one latest-frame
          // request instead of building a long async backlog.
          if (!shown) {
            await delay(36);
            continue;
          }

          break;
        }
      } catch (error) {
        console.warn("MRMS scrub preview failed", error);
      } finally {
        pumpRunning = false;
        if (scrubbing && clampIndex(scrubTarget) !== Number(currentFrameIndex)) {
          window.setTimeout(pumpScrub, 0);
        }
      }
    }

    async function finishScrub() {
      if ((!scrubbing && !pointerActive) || finishRunning) return;
      finishRunning = true;
      pointerActive = false;
      scrubbing = false;

      if (idleCommitTimer) {
        window.clearTimeout(idleCommitTimer);
        idleCommitTimer = null;
      }

      const finalIndex = clampIndex(scrubTarget);

      try {
        // Let the current fast preview request unwind before asking for the
        // exact full-quality native observation.
        for (let attempt = 0; pumpRunning && attempt < 30; attempt += 1) {
          await delay(12);
        }

        let shown = false;
        for (let attempt = 0; attempt < 3 && !shown; attempt += 1) {
          shown = await showFrame(finalIndex, {
            quiet: true,
            scrubCommit: true
          });
          if (!shown) await delay(45);
        }

        originalUpdateFrameUi();
      } catch (error) {
        console.warn("MRMS scrub commit failed", error);
      } finally {
        finishRunning = false;
      }
    }

    function scheduleKeyboardCommit() {
      if (pointerActive) return;
      if (idleCommitTimer) window.clearTimeout(idleCommitTimer);
      idleCommitTimer = window.setTimeout(() => {
        idleCommitTimer = null;
        finishScrub();
      }, 140);
    }

    slider.addEventListener(
      "pointerdown",
      () => {
        pointerActive = true;
        beginScrub();
      },
      true
    );

    // Capture-phase ownership intentionally runs before the original core
    // `input -> await showFrame()` handler. That older handler remains as the
    // no-JS-patch fallback, but it must not run during the optimized scrub path.
    slider.addEventListener(
      "input",
      event => {
        beginScrub();
        scrubTarget = clampIndex(slider.value);
        event.stopImmediatePropagation();
        holdThumbAtTarget();
        pumpScrub();
        scheduleKeyboardCommit();
      },
      true
    );

    slider.addEventListener(
      "change",
      event => {
        event.stopImmediatePropagation();
        scrubTarget = clampIndex(slider.value);
        finishScrub();
      },
      true
    );

    window.addEventListener("pointerup", finishScrub, true);
    window.addEventListener("pointercancel", finishScrub, true);
    slider.addEventListener("blur", finishScrub, true);

    console.info("MRMS frame scrubber: latest-frame coalescing enabled");
    return true;
  }

  function patchScrubberWhenReady() {
    if (installFrameScrubber()) return;
    if (Date.now() - scrubInstallStartedAt >= SCRUB_INSTALL_TIMEOUT_MS) {
      console.warn("MRMS frame scrubber did not find the radar controls");
      return;
    }
    window.setTimeout(patchScrubberWhenReady, SCRUB_RETRY_MS);
  }

  patchScrubberWhenReady();

  const params = new URLSearchParams(window.location.search);
  if (params.get("home") === "1") {
    const homeScript = document.createElement("script");
    homeScript.src = "scripts/radar/mrms-homepage-mode.js?v=20260902c";
    homeScript.async = true;
    document.head.appendChild(homeScript);

    const mobileScript = document.createElement("script");
    mobileScript.src = "scripts/radar/mrms-homepage-mobile.js?v=20260830d";
    mobileScript.async = true;
    document.head.appendChild(mobileScript);
  }
})();
