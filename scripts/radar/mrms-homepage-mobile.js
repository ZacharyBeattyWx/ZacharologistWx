(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  if (params.get("home") !== "1") return;

  const STYLE_ID = "mrms-homepage-mobile-readable-style";
  const startedAt = Date.now();
  const timeoutMs = 12000;

  function resizeHostFrame() {
    try {
      const frame = window.frameElement;
      if (!frame || !frame.classList?.contains("radar-frame")) return;

      const landscapePhone = window.matchMedia(
        "(max-height: 500px) and (pointer: coarse) and (orientation: landscape)"
      ).matches;
      const portraitPhone = window.matchMedia(
        "(max-width: 720px) and (orientation: portrait)"
      ).matches;

      if (landscapePhone) {
        frame.style.setProperty("height", "420px", "important");
        frame.style.setProperty("min-height", "420px", "important");
        frame.style.setProperty("max-height", "420px", "important");
      } else if (portraitPhone) {
        frame.style.setProperty("height", "620px", "important");
        frame.style.setProperty("min-height", "620px", "important");
        frame.style.setProperty("max-height", "620px", "important");
      } else {
        frame.style.removeProperty("height");
        frame.style.removeProperty("min-height");
        frame.style.removeProperty("max-height");
      }
    } catch (_) {}
  }

  function resizeMapSoon() {
    resizeHostFrame();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        try {
          if (typeof map !== "undefined" && map && typeof map.resize === "function") {
            map.resize();
          }
        } catch (_) {}
      });
    });
  }

  function install() {
    if (document.getElementById(STYLE_ID)) return true;
    if (!document.getElementById("mrms-native-home-style")) return false;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      @media (max-width: 720px) {
        .mrms-native-home #map {
          top: 0 !important;
          left: 0 !important;
          right: 0 !important;
          bottom: 174px !important;
          width: auto !important;
          height: auto !important;
        }

        .mrms-native-home .home-radar-badge {
          top: 10px !important;
          left: 10px !important;
          max-width: calc(100vw - 20px) !important;
          min-width: 0 !important;
          gap: 8px !important;
          padding: 8px 10px !important;
          border-radius: 11px !important;
        }

        .mrms-native-home .home-radar-live-dot {
          width: 9px !important;
          height: 9px !important;
        }

        .mrms-native-home .home-radar-badge strong {
          font-size: .74rem !important;
          line-height: 1.15 !important;
          letter-spacing: .045em !important;
        }

        .mrms-native-home .home-radar-badge-copy > span {
          margin-top: 2px !important;
          font-size: .64rem !important;
          line-height: 1.15 !important;
        }

        .mrms-native-home .legend {
          display: none !important;
        }

        .mrms-native-home .playback {
          left: 0 !important;
          right: 0 !important;
          bottom: 0 !important;
          width: auto !important;
          height: 174px !important;
          transform: none !important;
          grid-template-columns: 1fr !important;
          grid-template-areas:
            "history"
            "controls"
            "readout"
            "timeline" !important;
          align-content: center !important;
          gap: 6px !important;
          padding: 8px 10px 9px !important;
          border-left: 0 !important;
          border-right: 0 !important;
          border-bottom: 0 !important;
          border-radius: 0 !important;
          background: rgba(4,10,22,.97) !important;
          box-shadow: 0 -8px 24px rgba(0,0,0,.26) !important;
          backdrop-filter: blur(12px) !important;
          overflow: hidden !important;
        }

        .mrms-native-home .history-row {
          width: 100% !important;
        }

        .mrms-native-home .home-radar-history-select {
          width: 100% !important;
          min-height: 40px !important;
          height: 40px !important;
          padding: 7px 34px 7px 11px !important;
          border-radius: 9px !important;
          font-size: .80rem !important;
          line-height: 1.1 !important;
        }

        .mrms-native-home .playback-buttons {
          grid-template-columns: 44px minmax(0, 1fr) 44px 74px !important;
          gap: 7px !important;
        }

        .mrms-native-home .playback-buttons button,
        .mrms-native-home .playback-buttons select {
          min-height: 44px !important;
          height: 44px !important;
          padding: 7px 6px !important;
          border-radius: 9px !important;
          font-size: .80rem !important;
          line-height: 1.1 !important;
        }

        .mrms-native-home #playPause {
          font-weight: 900 !important;
        }

        .mrms-native-home .frame-readout {
          min-height: 17px !important;
          padding: 0 3px !important;
          font-size: .75rem !important;
          line-height: 1.15 !important;
        }

        .mrms-native-home .timeline {
          gap: 2px !important;
        }

        .mrms-native-home .timeline input[type="range"] {
          width: 100% !important;
          min-height: 18px !important;
          height: 18px !important;
          margin: 0 !important;
        }

        .mrms-native-home .timeline-labels {
          font-size: .61rem !important;
          line-height: 1 !important;
          letter-spacing: .035em !important;
        }
      }

      @media (max-width: 390px) {
        .mrms-native-home .playback {
          padding-left: 8px !important;
          padding-right: 8px !important;
        }

        .mrms-native-home .playback-buttons {
          grid-template-columns: 42px minmax(0, 1fr) 42px 68px !important;
          gap: 6px !important;
        }

        .mrms-native-home .playback-buttons button,
        .mrms-native-home .playback-buttons select {
          font-size: .76rem !important;
        }
      }

      @media (max-height: 500px) and (pointer: coarse) and (orientation: landscape) {
        .mrms-native-home #map {
          bottom: 112px !important;
        }

        .mrms-native-home .playback {
          left: 0 !important;
          right: 0 !important;
          bottom: 0 !important;
          width: auto !important;
          height: 112px !important;
          transform: none !important;
          grid-template-columns: 104px minmax(0, 1fr) !important;
          grid-template-areas:
            "history controls"
            "readout readout"
            "timeline timeline" !important;
          gap: 4px 7px !important;
          padding: 6px 8px !important;
          border-left: 0 !important;
          border-right: 0 !important;
          border-bottom: 0 !important;
          border-radius: 0 !important;
          background: rgba(4,10,22,.97) !important;
          overflow: hidden !important;
        }

        .mrms-native-home .home-radar-history-select,
        .mrms-native-home .playback-buttons button,
        .mrms-native-home .playback-buttons select {
          min-height: 38px !important;
          height: 38px !important;
          font-size: .72rem !important;
        }

        .mrms-native-home .playback-buttons {
          grid-template-columns: 38px minmax(0, 1fr) 38px 62px !important;
          gap: 5px !important;
        }

        .mrms-native-home .frame-readout {
          min-height: 15px !important;
          font-size: .68rem !important;
        }

        .mrms-native-home .timeline input[type="range"] {
          min-height: 14px !important;
          height: 14px !important;
        }

        .mrms-native-home .timeline-labels {
          font-size: .55rem !important;
        }
      }
    `;

    document.head.appendChild(style);
    resizeMapSoon();
    window.addEventListener("resize", resizeMapSoon, { passive: true });
    window.addEventListener("orientationchange", resizeMapSoon, { passive: true });
    console.info("MRMS homepage mobile controls: dedicated map + control footer enabled");
    return true;
  }

  function waitForHomeStyle() {
    if (install()) return;
    if (Date.now() - startedAt < timeoutMs) {
      window.setTimeout(waitForHomeStyle, 50);
    }
  }

  waitForHomeStyle();
})();
