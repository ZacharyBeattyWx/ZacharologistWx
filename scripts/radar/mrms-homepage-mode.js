(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("home") !== "1") return;

  const HISTORY_OPTIONS = [
    [30, "30 min"],
    [60, "1 hr"],
    [120, "2 hrs"],
    [180, "3 hrs"],
    [240, "4 hrs"],
    [360, "6 hrs"],
    [720, "12 hrs"],
    [1080, "18 hrs"],
    [1440, "24 hrs"]
  ];
  const startedAt = Date.now();
  const PATCH_TIMEOUT_MS = 12000;
  let startupHistoryApplied = false;
  let syncTimer = null;

  function ready() {
    try {
      return (
        typeof applyHistoryWindow === "function" &&
        typeof filterHistory === "function" &&
        typeof currentFrameKey === "function" &&
        typeof updateFrameUi === "function" &&
        typeof warmAround === "function" &&
        typeof speedSelect !== "undefined" &&
        typeof opacityInput !== "undefined" &&
        typeof opacityOutput !== "undefined" &&
        document.querySelector(".history-row")
      );
    } catch (_) {
      return false;
    }
  }

  function tickLabel(minutes) {
    if (minutes < 60) return `-${minutes}m`;
    const hours = minutes / 60;
    return `-${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }

  function relativeUpdateText(value) {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return "Updating automatically";
    const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
    if (minutes <= 1) return "Updated just now";
    if (minutes < 60) return `Updated ${minutes} min ago`;
    return `Updated at ${new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  function injectStyle() {
    if (document.getElementById("mrms-native-home-style")) return;
    const style = document.createElement("style");
    style.id = "mrms-native-home-style";
    style.textContent = `
      .mrms-native-home .panel { display: contents !important; }
      .mrms-native-home .controls { display: contents !important; }
      .mrms-native-home .panel > .eyebrow,
      .mrms-native-home .panel > h1,
      .mrms-native-home .panel > .subtitle,
      .mrms-native-home .panel > .status-row,
      .mrms-native-home .button-row,
      .mrms-native-home .range-row,
      .mrms-native-home .meta { display: none !important; }

      .mrms-native-home .home-radar-badge {
        position: fixed;
        top: 14px;
        left: 14px;
        z-index: 30;
        display: flex;
        align-items: center;
        gap: 9px;
        min-width: 186px;
        padding: 9px 12px;
        border: 1px solid rgba(148,163,184,.28);
        border-radius: 11px;
        background: rgba(4,10,22,.88);
        box-shadow: 0 10px 26px rgba(0,0,0,.28);
        backdrop-filter: blur(10px);
        pointer-events: none;
      }
      .mrms-native-home .home-radar-live-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: #4ade80;
        box-shadow: 0 0 10px rgba(74,222,128,.7);
      }
      .mrms-native-home .home-radar-badge strong {
        display: block;
        color: #f8fafc;
        font-size: .72rem;
        font-weight: 900;
        letter-spacing: .055em;
        text-transform: uppercase;
        line-height: 1.1;
      }
      .mrms-native-home .home-radar-badge-copy > span {
        display: block;
        margin-top: 3px;
        color: #94a3b8;
        font-size: .62rem;
        font-weight: 700;
        line-height: 1.1;
      }

      .mrms-native-home .home-radar-expand {
        position: fixed;
        top: 14px;
        right: 250px;
        z-index: 32;
        width: 38px;
        height: 38px;
        display: grid;
        place-items: center;
        padding: 0;
        border: 1px solid rgba(148,163,184,.30);
        border-radius: 10px;
        background: rgba(4,10,22,.88);
        color: #e2e8f0;
        box-shadow: 0 10px 24px rgba(0,0,0,.24);
        backdrop-filter: blur(10px);
        cursor: pointer;
        transition: background .16s ease, border-color .16s ease, transform .16s ease;
      }
      .mrms-native-home .home-radar-expand:hover {
        background: rgba(15,23,42,.96);
        border-color: rgba(56,189,248,.62);
        color: #f8fafc;
        transform: translateY(-1px);
      }
      .mrms-native-home .home-radar-expand:focus-visible {
        outline: 2px solid rgba(56,189,248,.9);
        outline-offset: 2px;
      }
      .mrms-native-home .home-radar-expand-icon {
        font-size: 1.2rem;
        line-height: 1;
        transform: translateY(-1px);
      }

      .mrms-native-home .playback {
        position: fixed !important;
        left: 50% !important;
        bottom: 14px !important;
        z-index: 30 !important;
        width: min(520px, calc(100vw - 28px)) !important;
        transform: translateX(-50%) !important;
        display: grid !important;
        grid-template-columns: 112px 1fr !important;
        grid-template-areas:
          "history controls"
          "readout readout"
          "timeline timeline" !important;
        gap: 7px 9px !important;
        padding: 9px 10px 8px !important;
        border: 1px solid rgba(148,163,184,.28) !important;
        border-radius: 13px !important;
        background: rgba(4,10,22,.90) !important;
        box-shadow: 0 14px 34px rgba(0,0,0,.34) !important;
        backdrop-filter: blur(12px) !important;
      }
      .mrms-native-home .history-row {
        grid-area: history !important;
        display: block !important;
      }
      .mrms-native-home .history-label,
      .mrms-native-home .history-buttons { display: none !important; }
      .mrms-native-home .home-radar-history-select {
        width: 100% !important;
        min-height: 31px !important;
        padding: 5px 28px 5px 9px !important;
        border: 1px solid rgba(56,189,248,.55) !important;
        border-radius: 8px !important;
        background: rgba(14,116,144,.22) !important;
        color: #e0f2fe !important;
        font-size: .68rem !important;
        font-weight: 900 !important;
        cursor: pointer !important;
      }
      .mrms-native-home .home-radar-history-select option {
        background: #e5eef5;
        color: #0f172a;
      }
      .mrms-native-home .playback-buttons {
        grid-area: controls !important;
        display: grid !important;
        grid-template-columns: 36px 1fr 36px 68px !important;
        gap: 5px !important;
      }
      .mrms-native-home .playback-buttons button,
      .mrms-native-home .playback-buttons select {
        min-height: 31px !important;
        padding: 5px !important;
        border-radius: 8px !important;
        font-size: .68rem !important;
      }
      .mrms-native-home .frame-readout {
        grid-area: readout !important;
        display: flex !important;
        justify-content: space-between !important;
        padding-inline: 2px !important;
        color: #dbeafe !important;
        font-size: .67rem !important;
      }
      .mrms-native-home .timeline {
        grid-area: timeline !important;
        gap: 2px !important;
      }
      .mrms-native-home .timeline input[type="range"] { margin: 0 !important; }
      .mrms-native-home .timeline-labels { font-size: .52rem !important; }

      .mrms-native-home .legend {
        position: fixed !important;
        top: 14px !important;
        right: 14px !important;
        z-index: 30 !important;
        width: 224px !important;
        margin: 0 !important;
        padding: 8px 10px !important;
        border: 1px solid rgba(148,163,184,.24) !important;
        border-radius: 10px !important;
        background: rgba(4,10,22,.82) !important;
        box-shadow: 0 10px 24px rgba(0,0,0,.24) !important;
        backdrop-filter: blur(10px) !important;
      }
      .mrms-native-home .legend-title {
        margin-bottom: 5px !important;
        color: #cbd5e1 !important;
        font-size: .60rem !important;
        text-transform: uppercase !important;
        letter-spacing: .06em !important;
      }
      .mrms-native-home .legend-bar { height: 7px !important; }
      .mrms-native-home .legend-labels {
        margin-top: 3px !important;
        font-size: .50rem !important;
      }

      @media (max-width: 720px), (max-height: 440px) {
        .mrms-native-home .home-radar-badge {
          top: 9px !important;
          left: 9px !important;
          min-width: 0 !important;
          padding: 7px 9px !important;
        }
        .mrms-native-home .home-radar-badge strong { font-size: .65rem !important; }
        .mrms-native-home .home-radar-badge-copy > span { font-size: .56rem !important; }
        .mrms-native-home .legend { display: none !important; }
        .mrms-native-home .home-radar-expand {
          top: 9px;
          right: 9px;
          width: 36px;
          height: 36px;
        }
        .mrms-native-home .playback {
          bottom: 9px !important;
          width: calc(100vw - 18px) !important;
          grid-template-columns: 100px 1fr !important;
          padding: 7px 8px !important;
          gap: 5px 7px !important;
        }
        .mrms-native-home .playback-buttons {
          grid-template-columns: 32px 1fr 32px 60px !important;
        }
      }
      @media (max-width: 380px) {
        .mrms-native-home .playback {
          grid-template-columns: 1fr !important;
          grid-template-areas:
            "history"
            "controls"
            "readout"
            "timeline" !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function install() {
    if (window.__ZWX_MRMS_NATIVE_HOME__) return true;
    if (!ready()) return false;
    window.__ZWX_MRMS_NATIVE_HOME__ = true;

    document.body.classList.add("mrms-native-home");
    injectStyle();

    const originalPrefetchFrameBlobs = prefetchFrameBlobs;

    updateHistoryButtons = function () {
      historyButtons.forEach(button => {
        button.classList.toggle("is-active", Number(button.dataset.historyMinutes) === historyMinutes);
      });
      historyStartLabel.textContent = tickLabel(historyMinutes);
    };

    applyHistoryWindow = function (minutes, preserveKey = currentFrameKey()) {
      const requested = Number(minutes);
      const available = Math.max(30, Number(manifest?.historyWindowMinutes || 60));
      const choices = HISTORY_OPTIONS.map(([value]) => value).filter(value => value <= available);
      const fallback = choices[choices.length - 1] || 60;
      historyMinutes = choices.includes(requested) ? requested : fallback;

      frames = filterHistory(allFrames, historyMinutes);
      let nextIndex = frames.findIndex(frame => frameKey(frame) === preserveKey);
      if (nextIndex < 0) nextIndex = frames.length - 1;
      currentFrameIndex = Math.max(0, nextIndex);
      updateHistoryButtons();
      updateFrameUi();
      warmAround(currentFrameIndex);
    };

    // Homepage playback should stream only what it needs instead of bulk-downloading
    // an entire 3-24 hour history window on initial load.
    prefetchFrameBlobs = async function (frameList = frames, manifestLike = manifest) {
      if (frameList === frames && frameList.length > 16) return;
      return originalPrefetchFrameBlobs(frameList, manifestLike);
    };

    const row = document.querySelector(".history-row");
    const select = document.createElement("select");
    select.id = "homeRadarHistorySelect";
    select.className = "home-radar-history-select";
    select.setAttribute("aria-label", "Radar history length");
    select.innerHTML = HISTORY_OPTIONS
      .map(([minutes, label]) => `<option value="${minutes}"${minutes === 720 ? " selected" : ""}>${label}</option>`)
      .join("");
    row.appendChild(select);

    const badge = document.createElement("div");
    badge.id = "homeRadarBadge";
    badge.className = "home-radar-badge";
    badge.innerHTML = `
      <span class="home-radar-live-dot" aria-hidden="true"></span>
      <span class="home-radar-badge-copy">
        <strong>Live National Radar</strong>
        <span id="homeRadarFreshness">Updating automatically</span>
      </span>
    `;
    document.body.appendChild(badge);

    const expandButton = document.createElement("button");
    expandButton.id = "homeRadarExpand";
    expandButton.className = "home-radar-expand";
    expandButton.type = "button";
    expandButton.setAttribute("aria-label", "Open radar full screen");
    expandButton.setAttribute("title", "Open radar full screen");
    expandButton.innerHTML = `<span class="home-radar-expand-icon" aria-hidden="true">⛶</span>`;
    document.body.appendChild(expandButton);
    const expandIcon = expandButton.querySelector(".home-radar-expand-icon");

    const parentDoc = (() => {
      try {
        return window.parent && window.parent !== window ? window.parent.document : document;
      } catch (_) {
        return document;
      }
    })();

    function fullscreenTarget() {
      try {
        return window.frameElement || document.documentElement;
      } catch (_) {
        return document.documentElement;
      }
    }

    function isRadarFullscreen() {
      try {
        return parentDoc.fullscreenElement === fullscreenTarget() || document.fullscreenElement === document.documentElement;
      } catch (_) {
        return Boolean(document.fullscreenElement);
      }
    }

    function isStandaloneRadar() {
      try {
        return window.parent === window;
      } catch (_) {
        return true;
      }
    }

    function syncFullscreenButton() {
      const fullscreen = isRadarFullscreen();
      const standalone = isStandaloneRadar();
      const active = fullscreen || standalone;
      const label = fullscreen
        ? "Exit radar full screen"
        : standalone
          ? "Back to home"
          : "Open radar full screen";

      expandButton.setAttribute("aria-label", label);
      expandButton.setAttribute("title", label);
      expandButton.classList.toggle("is-fullscreen", active);
      if (expandIcon) expandIcon.textContent = active ? "⤡" : "⛶";
    }

    function returnToHomepage() {
      window.location.assign(new URL("./index.html", window.location.href).href);
    }

    function openStandaloneRadar() {
      try {
        if (window.top && window.top !== window) {
          window.top.location.assign(window.location.href);
          return;
        }
      } catch (_) {
        // Fall through and use the current browsing context.
      }
      window.location.assign(window.location.href);
    }

    async function toggleFullscreen() {
      const target = fullscreenTarget();
      try {
        if (isRadarFullscreen()) {
          const exitDoc = parentDoc.fullscreenElement ? parentDoc : document;
          if (typeof exitDoc.exitFullscreen === "function") {
            await exitDoc.exitFullscreen();
          }
        } else if (isStandaloneRadar()) {
          returnToHomepage();
        } else if (target && typeof target.requestFullscreen === "function") {
          await target.requestFullscreen({ navigationUI: "hide" });
        } else if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen({ navigationUI: "hide" });
        } else {
          openStandaloneRadar();
        }
      } catch (error) {
        console.warn("Radar fullscreen request failed; switching to standalone view instead.", error);
        openStandaloneRadar();
      } finally {
        window.setTimeout(syncFullscreenButton, 0);
      }
    }

    expandButton.addEventListener("click", toggleFullscreen);
    parentDoc.addEventListener("fullscreenchange", syncFullscreenButton);
    if (parentDoc !== document) document.addEventListener("fullscreenchange", syncFullscreenButton);
    syncFullscreenButton();

    const freshness = document.getElementById("homeRadarFreshness");
    const legendTitle = document.querySelector(".legend-title");
    if (legendTitle) legendTitle.textContent = "Radar Intensity (dBZ)";

    // Homepage defaults: 12 hr, 2x, 100% opacity.
    historyMinutes = 720;
    speedSelect.value = "2";
    opacityInput.value = "1";
    opacityOutput.value = "100%";
    opacityInput.dispatchEvent(new Event("input", { bubbles: true }));
    speedSelect.dispatchEvent(new Event("change", { bubbles: true }));
    updateHistoryButtons();

    function sync() {
      const available = Math.max(30, Number(manifest?.historyWindowMinutes || 60));
      [...select.options].forEach(option => {
        option.disabled = Number(option.value) > available;
      });

      if (!startupHistoryApplied && manifest && allFrames.length && available >= 720) {
        startupHistoryApplied = true;
        const preserveKey = currentFrameKey();
        applyHistoryWindow(720, preserveKey);
        select.value = "720";
        if (!frames.some(frame => frameKey(frame) === preserveKey)) {
          showFrame(frames.length - 1, { quiet: true }).catch(() => {});
        }
      } else if ([...select.options].some(option => Number(option.value) === historyMinutes)) {
        select.value = String(historyMinutes);
      }

      const newest = allFrames[allFrames.length - 1];
      if (freshness) freshness.textContent = newest?.valid_time
        ? relativeUpdateText(newest.valid_time)
        : "Updating automatically";
    }

    select.addEventListener("change", async () => {
      const preserveKey = currentFrameKey();
      const requested = Number(select.value);
      applyHistoryWindow(requested, preserveKey);
      if (!frames.some(frame => frameKey(frame) === preserveKey)) {
        await showFrame(frames.length - 1, { quiet: true });
      }
      select.value = String(historyMinutes);
    });

    sync();
    syncTimer = window.setInterval(sync, 1000);
    window.addEventListener("beforeunload", () => {
      if (syncTimer) window.clearInterval(syncTimer);
    }, { once: true });

    console.info("MRMS native homepage mode: 12 hr / 2x / 100% opacity");
    return true;
  }

  function patchWhenReady() {
    if (install()) return;
    if (Date.now() - startedAt < PATCH_TIMEOUT_MS) {
      window.setTimeout(patchWhenReady, 50);
    }
  }

  patchWhenReady();
})();
