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

  // v15.3 remains the single native temporal-buffer owner, but separates
  // fetch/decode work from paced WebGL uploads so large native fills do not
  // monopolize one animation frame. The successful v15.2 runway depths remain.
  load("scripts/radar/mrms-native-bandwidth-v15-3.js?v=20260918a");

  // Small loop-start reserve only: keeps the first few native observations
  // resident during playback so the newest-frame hold never turns into a
  // multi-second network wait at wrap. This does not restore full-history warm.
  load("scripts/radar/mrms-native-wrap-reserve-v15.js?v=20260917a");

  // Overview v16 replaces the core page's fixed 18-frame desktop prefetch with
  // a small speed-aware rolling runway while leaving the existing playback
  // clock untouched. It also caps simultaneous overview body transfers.
  load("scripts/radar/mrms-overview-bandwidth-v16.js?v=20260918a");
})();
