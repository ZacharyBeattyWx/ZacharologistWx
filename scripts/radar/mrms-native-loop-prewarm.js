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

  // v26 patches the existing native chunk renderer before v25 captures its
  // methods, allowing f4/f2 pyramid chunks to register their own geometry and
  // become visible in the same renderer. v25 then owns selection/preloading.
  load("scripts/radar/mrms-pyramid-dynamic-geometry-v26.js?v=20260921a");
  load("scripts/radar/mrms-single-renderer-pyramid-v25.js?v=20260921b");
})();