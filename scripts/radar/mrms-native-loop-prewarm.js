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

  // v22 stages native data before the LOD boundary. v20 owns the full native
  // Play preload. v23 performs a one-time native-only handoff only when native
  // is synchronized to the exact overview timeline frame/blend.
  load("scripts/radar/mrms-lod-handoff-v22.js?v=20260920a");
  load("scripts/radar/mrms-native-full-loop-v20.js?v=20260920b");
  load("scripts/radar/mrms-native-only-v23.js?v=20260920a");
  load("scripts/radar/mrms-native-bandwidth-v15-3.js?v=20260919a");
  load("scripts/radar/mrms-native-wrap-reserve-v15.js?v=20260917a");
  load("scripts/radar/mrms-overview-bandwidth-v16.js?v=20260918a");
})();