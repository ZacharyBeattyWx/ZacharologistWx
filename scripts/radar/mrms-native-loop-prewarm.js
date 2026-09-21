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

  // v20 loads first so its Play capture gate runs before v15.3's short-runway
  // gate. Desktop native playback is prepared once for the full visible loop.
  load("scripts/radar/mrms-native-full-loop-v20.js?v=20260920a");
  load("scripts/radar/mrms-native-bandwidth-v15-3.js?v=20260919a");
  load("scripts/radar/mrms-native-wrap-reserve-v15.js?v=20260917a");
  load("scripts/radar/mrms-overview-bandwidth-v16.js?v=20260918a");
})();
