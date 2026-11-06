/* Temporary service switch. Set customFeedsPaused to false when publishers resume. */
window.ZWX_SERVICE_STATUS = Object.freeze({ customFeedsPaused: true });
(() => {
  const service = document.currentScript?.dataset.pausedService;
  if (window.ZWX_SERVICE_STATUS.customFeedsPaused && service) {
    const target = new URL("service-unavailable.html", location.href);
    target.searchParams.set("service", service);
    document.documentElement.style.opacity = "0";
    location.replace(target.href);
  }
})();
