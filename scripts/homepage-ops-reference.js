(() => {
  const STYLE_ID = "homepage-mobile-radar-size-css";

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Homepage mobile radar: prioritize usable map area over compact card height. */
      @media (max-width: 768px) {
        .forecast-dashboard {
          padding-left: 4px !important;
          padding-right: 4px !important;
        }

        .forecast-dashboard .radar-card {
          padding: 14px 8px 10px !important;
        }

        .forecast-dashboard .radar-frame {
          width: 100% !important;
          height: clamp(440px, 62svh, 560px) !important;
          min-height: 440px !important;
          max-height: 560px !important;
          margin: 10px 0 0 !important;
        }
      }

      @media (max-width: 768px) and (orientation: landscape) {
        .forecast-dashboard .radar-frame {
          height: clamp(300px, 82svh, 440px) !important;
          min-height: 300px !important;
          max-height: 440px !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  if (window.__ZACH_HOMEPAGE_OPS_CORE_LOADING__) return;
  window.__ZACH_HOMEPAGE_OPS_CORE_LOADING__ = true;

  const core = document.createElement("script");
  core.src = "scripts/homepage-ops-reference-core.js?v=20260909a";
  core.async = false;
  core.onload = () => {
    window.__ZACH_HOMEPAGE_OPS_CORE_LOADED__ = true;
  };
  core.onerror = () => {
    console.error("Unable to load homepage operations core script.");
  };

  const current = document.currentScript;
  if (current?.parentNode) {
    current.parentNode.insertBefore(core, current.nextSibling);
  } else {
    document.head.appendChild(core);
  }
})();
