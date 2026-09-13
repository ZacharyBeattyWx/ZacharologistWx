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

  load("scripts/radar/mrms-native-loop-prewarm-v9-core.js?v=20260913a");
  load("scripts/radar/mrms-native-motion-gate-v10.js?v=20260913a");
  load("scripts/radar/mrms-native-motion-lead-v11.js?v=20260913b");
  load("scripts/radar/mrms-native-playback-stability-v12.js?v=20260913c");
})();
