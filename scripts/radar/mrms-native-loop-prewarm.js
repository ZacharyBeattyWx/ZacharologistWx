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

  // v25 uses one MRMS timeline and one GPU renderer. It chooses f4/f2/f1 from
  // the same-source server-side pyramid, preloads the selected viewport loop,
  // then performs an atomic resolution switch inside the same renderer.
  load("scripts/radar/mrms-single-renderer-pyramid-v25.js?v=20260921a");
})();