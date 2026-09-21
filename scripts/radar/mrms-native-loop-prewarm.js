(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;

  function load(src) {
    if (document.readyState === "loading") {
      document.write('<script src="' + src + '"><\/script>');
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    document.head.appendChild(script);
  }

  // v24 is the desktop experiment: one native/high-resolution radar dataset,
  // one native renderer, and a virtual overview object used only as the core
  // timeline clock. The older LOD/handoff/bandwidth shims are intentionally
  // not loaded so they cannot fight the single-source playback path.
  load("scripts/radar/mrms-native-single-source-v24.js?v=20260920a");
})();