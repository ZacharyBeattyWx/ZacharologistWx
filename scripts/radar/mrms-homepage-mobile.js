(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  if (params.get("home") !== "1") return;

  const STYLE_ID = "mrms-homepage-mobile-readable-style";
  const startedAt = Date.now();
  const timeoutMs = 12000;

  function install() {
    if (document.getElementById(STYLE_ID)) return true;
    if (!document.getElementById("mrms-native-home-style")) return false;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      @media (max-width: 720px), (max-height: 500px) and (pointer: coarse) {
        .mrms-native-home .home-radar-badge {
          top: 10px !important;
          left: 10px !important;
          max-width: calc(100vw - 20px) !important;
          min-width: 0 !important;
          gap: 9px !important;
          padding: 9px 11px !important;
          border-radius: 12px !important;
        }

        .mrms-native-home .home-radar-live-dot {
          width: 9px !important;
          height: 9px !important;
        }

        .mrms-native-home .home-radar-badge strong {
          font-size: .76rem !important;
          line-height: 1.15 !important;
          letter-spacing: .045em !important;
        }

        .mrms-native-home .home-radar-badge-copy > span {
          margin-top: 3px !important;
          font-size: .66rem !important;
          line-height: 1.15 !important;
        }

        .mrms-native-home .legend {
          display: none !important;
        }

        .mrms-native-home .playback {
          left: 8px !important;
          right: 8px !important;
          bottom: max(8px, env(safe-area-inset-bottom)) !important;
          width: auto !important;
          transform: none !important;
          grid-template-columns: 1fr !important;
          grid-template-areas:
            "history"
            "controls"
            "readout"
            "timeline" !important;
          gap: 8px !important;
          padding: 10px !important;
          border-radius: 14px !important;
        }

        .mrms-native-home .history-row {
          width: 100% !important;
        }

        .mrms-native-home .home-radar-history-select {
          width: 100% !important;
          min-height: 42px !important;
          padding: 8px 34px 8px 12px !important;
          border-radius: 10px !important;
          font-size: .82rem !important;
          line-height: 1.15 !important;
        }

        .mrms-native-home .playback-buttons {
          grid-template-columns: 44px minmax(0, 1fr) 44px 74px !important;
          gap: 7px !important;
        }

        .mrms-native-home .playback-buttons button,
        .mrms-native-home .playback-buttons select {
          min-height: 44px !important;
          padding: 8px 6px !important;
          border-radius: 10px !important;
          font-size: .80rem !important;
          line-height: 1.1 !important;
        }

        .mrms-native-home #playPause {
          font-weight: 900 !important;
        }

        .mrms-native-home .frame-readout {
          min-height: 20px !important;
          padding: 0 3px !important;
          font-size: .78rem !important;
          line-height: 1.2 !important;
        }

        .mrms-native-home .timeline {
          gap: 4px !important;
        }

        .mrms-native-home .timeline input[type="range"] {
          width: 100% !important;
          min-height: 24px !important;
          margin: 0 !important;
        }

        .mrms-native-home .timeline-labels {
          font-size: .64rem !important;
          line-height: 1.1 !important;
          letter-spacing: .035em !important;
        }
      }

      @media (max-width: 390px) {
        .mrms-native-home .playback {
          left: 6px !important;
          right: 6px !important;
          padding: 9px !important;
          gap: 7px !important;
        }

        .mrms-native-home .playback-buttons {
          grid-template-columns: 42px minmax(0, 1fr) 42px 68px !important;
          gap: 6px !important;
        }

        .mrms-native-home .playback-buttons button,
        .mrms-native-home .playback-buttons select {
          min-height: 42px !important;
          font-size: .76rem !important;
        }

        .mrms-native-home .home-radar-history-select {
          min-height: 40px !important;
          font-size: .78rem !important;
        }

        .mrms-native-home .frame-readout {
          font-size: .74rem !important;
        }
      }
    `;

    document.head.appendChild(style);
    console.info("MRMS homepage mobile controls: readable phone layout enabled");
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
