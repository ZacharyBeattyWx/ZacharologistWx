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
  // become visible in the same renderer. v29 applies only to ?viewer=regional:
  // it starts inside the f2 quality band and caps zoom below the f1 threshold.
  // v25 then owns selection/preloading. v27 repairs the preload-complete Play
  // relay. v28 freezes the resident loop while playing so manifest/camera
  // refreshes cannot trigger mid-loop preload/eviction work.
  load("scripts/radar/mrms-pyramid-dynamic-geometry-v26.js?v=20260921a");
  load("scripts/radar/mrms-regional-quality-cap-v29.js?v=20260923a");
  load("scripts/radar/mrms-single-renderer-pyramid-v25.js?v=20260921b");
  load("scripts/radar/mrms-pyramid-play-gate-v27.js?v=20260921a");
  load("scripts/radar/mrms-playback-snapshot-lock-v28.js?v=20260921a");
})();
