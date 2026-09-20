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

  load("scripts/radar/mrms-native-bandwidth-v15-3.js?v=20260919a");
  load("scripts/radar/mrms-native-wrap-reserve-v15.js?v=20260917a");
  load("scripts/radar/mrms-overview-bandwidth-v16.js?v=20260918a");
  load("scripts/radar/mrms-native-ready-v17.js?v=20260919a");
  load("scripts/radar/mrms-native-rebuffer-v18.js?v=20260919a");
})();
