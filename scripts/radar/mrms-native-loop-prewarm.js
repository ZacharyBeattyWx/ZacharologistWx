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

  // v15 is the single native temporal-buffer owner. The older v9/v10/v11/v14
  // stack intentionally stays unloaded so full-history archive caching,
  // predictive native warmups, and competing playback queues cannot multiply
  // CloudFront transfer behind the active viewport.
  load("scripts/radar/mrms-native-bandwidth-v15.js?v=20260917a");

  // Small loop-start reserve only: keeps the first few native observations
  // resident during playback so the newest-frame hold never turns into a
  // multi-second network wait at wrap. This does not restore full-history warm.
  load("scripts/radar/mrms-native-wrap-reserve-v15.js?v=20260917a");
})();
