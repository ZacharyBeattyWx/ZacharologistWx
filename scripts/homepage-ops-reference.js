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

        .forecast-dashboard .homepage-radar-live-link {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 32px;
          padding: 0 10px;
          border: 1px solid rgba(56, 189, 248, 0.34);
          border-radius: 999px;
          background: rgba(56, 189, 248, 0.08);
        }
      }

      @media (max-width: 768px) and (orientation: landscape) {
        .forecast-dashboard .radar-frame {
          height: clamp(300px, 82svh, 440px) !important;
          min-height: 300px !important;
          max-height: 440px !important;
        }
      }

      .forecast-dashboard .homepage-radar-live-link {
        color: inherit;
        text-decoration: none;
        cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  const renameHomepageRadarLabels = () => {
    document.querySelectorAll("h3, .radar-mode-btn").forEach((element) => {
      if (element.textContent.trim() === "Regional Radar") {
        element.textContent = "National Radar";
      }
    });
  };

  const routeHomepageRadarLinks = () => {
    document.querySelectorAll("a.active-alert-radar-link").forEach((link) => {
      link.setAttribute("href", "weather-viewer.html");
    });
  };

  const routeHomepageRadarLiveView = () => {
    document.querySelectorAll(".forecast-dashboard .radar-card .card-time").forEach((badge) => {
      if (badge.textContent.trim().toLowerCase() !== "live view") return;

      if (badge.tagName === "A") {
        badge.setAttribute("href", "weather-viewer.html");
        badge.classList.add("homepage-radar-live-link");
        badge.setAttribute("aria-label", "Open radar, satellite, and lightning viewer");
        return;
      }

      const link = document.createElement("a");
      link.className = `${badge.className} homepage-radar-live-link`;
      link.textContent = badge.textContent;
      link.href = "weather-viewer.html";
      link.setAttribute("aria-label", "Open radar, satellite, and lightning viewer");
      badge.replaceWith(link);
    });
  };

  const prepareHomepageRadarUi = () => {
    renameHomepageRadarLabels();
    routeHomepageRadarLinks();
    routeHomepageRadarLiveView();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", prepareHomepageRadarUi, { once: true });
  } else {
    prepareHomepageRadarUi();
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
