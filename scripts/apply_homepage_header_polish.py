from pathlib import Path

PATH = Path("index.html")
STYLE_MARKER = '<style id="homepage-nav-responsive-polish-v1">'

STYLE = r'''
<style id="homepage-nav-responsive-polish-v1">
/* Homepage navigation: keep the compact DevTools-width balance at normal desktop widths. */
.site-header {
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: none !important;
  min-height: 62px !important;
  margin: 0 !important;
  padding: 9px clamp(12px, 1.5vw, 22px) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: clamp(10px, 1.2vw, 18px) !important;
  position: sticky !important;
  top: 0 !important;
  z-index: 5000 !important;
  overflow: visible !important;
  background: rgba(3, 9, 18, 0.96) !important;
  border: 0 !important;
  border-bottom: 1px solid rgba(100, 199, 255, 0.18) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  backdrop-filter: blur(14px) !important;
  -webkit-backdrop-filter: blur(14px) !important;
}

.site-header .site-brand {
  flex: 0 0 auto !important;
  min-width: clamp(165px, 12vw, 205px) !important;
}

.site-header .brand-main {
  font-size: clamp(0.94rem, 0.92vw, 1.06rem) !important;
  line-height: 1 !important;
}

.site-header .brand-sub {
  margin-top: 4px !important;
  font-size: clamp(0.50rem, 0.46vw, 0.58rem) !important;
  line-height: 1 !important;
}

.site-header .site-nav {
  position: static !important;
  flex: 1 1 auto !important;
  min-width: 0 !important;
  width: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  display: flex !important;
  flex-direction: row !important;
  align-items: stretch !important;
  justify-content: space-between !important;
  gap: clamp(3px, 0.45vw, 7px) !important;
  overflow: visible !important;
  background: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
}

.site-header .site-nav a {
  flex: 1 1 0 !important;
  min-width: 0 !important;
  width: auto !important;
  margin: 0 !important;
  padding: 8px clamp(5px, 0.55vw, 10px) !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  text-align: center !important;
  border-radius: 4px !important;
  font-size: clamp(0.56rem, 0.52vw, 0.64rem) !important;
  line-height: 1.05 !important;
  letter-spacing: 0.075em !important;
  white-space: nowrap !important;
}

.site-header .site-nav a span {
  margin-top: 4px !important;
  font-size: clamp(0.42rem, 0.40vw, 0.49rem) !important;
  line-height: 1.05 !important;
  letter-spacing: 0.10em !important;
}

.site-header .mobile-nav-toggle {
  display: none !important;
}

@media (min-width: 861px) and (max-width: 1180px) {
  .site-header {
    min-height: 58px !important;
    padding: 8px 10px !important;
    gap: 8px !important;
  }

  .site-header .site-brand {
    min-width: 155px !important;
  }

  .site-header .brand-main {
    font-size: 0.90rem !important;
  }

  .site-header .brand-sub {
    font-size: 0.48rem !important;
  }

  .site-header .site-nav {
    gap: 2px !important;
  }

  .site-header .site-nav a {
    padding: 7px 4px !important;
    font-size: 0.53rem !important;
    letter-spacing: 0.055em !important;
  }

  .site-header .site-nav a span {
    margin-top: 3px !important;
    font-size: 0.40rem !important;
    letter-spacing: 0.08em !important;
  }
}

/* Mobile navigation switches early enough that nine desktop links never get crushed. */
@media (max-width: 860px) {
  .site-header {
    min-height: 56px !important;
    padding: 7px 10px !important;
    gap: 10px !important;
  }

  .site-header .site-brand {
    min-width: 0 !important;
  }

  .site-header .brand-main {
    font-size: 0.90rem !important;
  }

  .site-header .brand-sub {
    margin-top: 3px !important;
    font-size: 0.48rem !important;
  }

  .site-header .mobile-nav-toggle {
    display: grid !important;
    width: 40px !important;
    height: 40px !important;
    min-width: 40px !important;
    min-height: 40px !important;
    margin-left: auto !important;
    padding: 0 !important;
    place-items: center !important;
    flex: 0 0 40px !important;
    border: 1px solid rgba(126, 173, 214, 0.30) !important;
    border-radius: 9px !important;
    background: rgba(15, 31, 50, 0.94) !important;
    color: #fff !important;
    font-size: 1.05rem !important;
    line-height: 1 !important;
  }

  .site-header .site-nav {
    position: fixed !important;
    top: 56px !important;
    left: 8px !important;
    right: 8px !important;
    z-index: 5001 !important;
    width: auto !important;
    max-height: calc(100dvh - 66px) !important;
    margin: 0 !important;
    padding: 8px !important;
    display: none !important;
    flex-direction: column !important;
    align-items: stretch !important;
    justify-content: flex-start !important;
    gap: 4px !important;
    overflow-y: auto !important;
    border: 1px solid rgba(126, 173, 214, 0.24) !important;
    border-radius: 12px !important;
    background: rgba(3, 10, 21, 0.985) !important;
    box-shadow: 0 22px 55px rgba(0, 0, 0, 0.42) !important;
    backdrop-filter: blur(16px) !important;
    -webkit-backdrop-filter: blur(16px) !important;
  }

  .site-header .site-nav.open {
    display: flex !important;
  }

  .site-header .site-nav a {
    flex: 0 0 auto !important;
    width: 100% !important;
    min-height: 44px !important;
    padding: 9px 11px !important;
    align-items: flex-start !important;
    justify-content: center !important;
    text-align: left !important;
    font-size: 0.68rem !important;
  }

  .site-header .site-nav a span {
    margin-top: 3px !important;
    font-size: 0.50rem !important;
  }
}

/* Mobile homepage sanity: one clean column, no horizontal bleed, full-width media. */
@media (max-width: 768px) {
  .forecast-dashboard {
    padding: 16px 8px 26px !important;
    overflow-x: hidden !important;
  }

  .ops-reference-layout,
  .ops-board-shell,
  .forecast-dashboard .ops-dashboard-grid,
  .forecast-dashboard .ops-center-column,
  .forecast-dashboard .ops-right-column,
  .forecast-dashboard .dashboard-card {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
  }

  .ops-reference-layout {
    display: block !important;
  }

  .ops-reference-rail {
    display: none !important;
  }

  .forecast-dashboard .ops-dashboard-grid,
  .forecast-dashboard .ops-center-column,
  .forecast-dashboard .ops-right-column {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) !important;
    gap: 12px !important;
  }

  .forecast-dashboard .radar-card,
  .forecast-dashboard .spc-card {
    min-height: 0 !important;
  }

  .forecast-dashboard .radar-frame {
    width: 100% !important;
    height: clamp(300px, 78vw, 370px) !important;
    min-height: 0 !important;
    max-height: none !important;
  }

  .forecast-dashboard .spc-slideshow {
    width: 100% !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    aspect-ratio: 4 / 3 !important;
  }

  .quick-tools-row,
  .ops-board-shell .quick-tools-row {
    width: 100% !important;
    max-width: 100% !important;
    margin: 12px 0 28px !important;
    padding: 0 !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 9px !important;
  }
}

@media (max-width: 420px) {
  .forecast-dashboard {
    padding: 12px 6px 22px !important;
  }

  .operations-intro {
    padding: 14px !important;
  }

  .operations-intro h2 {
    font-size: 1.35rem !important;
  }

  .forecast-dashboard .radar-frame {
    height: 300px !important;
  }
}
</style>
'''

OLD_BUTTON = '''  <button class="mobile-nav-toggle" type="button" aria-label="Open navigation">
    ☰
  </button>'''
NEW_BUTTON = '''  <button class="mobile-nav-toggle" type="button" aria-label="Open navigation" aria-controls="siteNav" aria-expanded="false">
    ☰
  </button>'''

OLD_JS = '''const mobileNavToggle = document.querySelector(".mobile-nav-toggle");
const siteNav = document.querySelector("#siteNav");

if (mobileNavToggle && siteNav) {
  mobileNavToggle.addEventListener("click", () => {
    siteNav.classList.toggle("open");
  });
}'''

NEW_JS = '''const mobileNavToggle = document.querySelector(".mobile-nav-toggle");
const siteNav = document.querySelector("#siteNav");

if (mobileNavToggle && siteNav) {
  const closeMobileNav = () => {
    siteNav.classList.remove("open");
    mobileNavToggle.setAttribute("aria-expanded", "false");
  };

  mobileNavToggle.setAttribute("aria-controls", "siteNav");
  mobileNavToggle.setAttribute("aria-expanded", "false");

  mobileNavToggle.addEventListener("click", () => {
    const isOpen = siteNav.classList.toggle("open");
    mobileNavToggle.setAttribute("aria-expanded", String(isOpen));
  });

  siteNav.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMobileNav();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMobileNav();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 860) closeMobileNav();
  }, { passive: true });
}'''


def main() -> None:
    text = PATH.read_text(encoding="utf-8")

    if STYLE_MARKER not in text:
        if "</head>" not in text:
            raise SystemExit("index.html has no </head> marker")
        text = text.replace("</head>", STYLE + "\n</head>", 1)

    if OLD_BUTTON in text:
        text = text.replace(OLD_BUTTON, NEW_BUTTON, 1)

    if OLD_JS in text:
        text = text.replace(OLD_JS, NEW_JS, 1)
    elif "const closeMobileNav = () =>" not in text:
        raise SystemExit("Homepage mobile-nav script block was not found")

    PATH.write_text(text, encoding="utf-8")
    print("Homepage header/mobile polish applied")


if __name__ == "__main__":
    main()
