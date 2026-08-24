(() => {
  "use strict";

  const header = document.querySelector("[data-interior-site-header]");
  if (!header) return;

  const currentPage =
    window.location.pathname.split("/").filter(Boolean).pop() || "index.html";

  const nav = header.querySelector("[data-interior-site-nav]");
  const toggle = header.querySelector("[data-interior-nav-toggle]");

  nav?.querySelectorAll("a[href]").forEach((link) => {
    const url = new URL(link.getAttribute("href"), window.location.href);
    const linkPage =
      url.pathname.split("/").filter(Boolean).pop() || "index.html";
    const currentPageLower = currentPage.toLowerCase();
    const linkPageLower = linkPage.toLowerCase();

    const isRadarAlertsSection =
      currentPageLower === "live-alerts.html" &&
      linkPageLower === "level2-mobile-radar.html";

    const isActive =
      linkPageLower === currentPageLower ||
      isRadarAlertsSection;

    link.classList.toggle("active", isActive);

    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  const setOpen = (open) => {
    if (!nav || !toggle) return;
    nav.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  };

  /*
   * storm-reports.html already owns the mobile toggle listener internally.
   * Do not bind a second click handler there, or one click would toggle twice.
   */
  if (!["storm-reports.html", "chase-dashboard.html"].includes(currentPage.toLowerCase()) && toggle && nav) {
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpen(!nav.classList.contains("open"));
    });

    document.addEventListener("click", (event) => {
      if (!header.contains(event.target)) {
        setOpen(false);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 760) {
        setOpen(false);
      }
    });
  }
})();
