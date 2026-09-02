window.MAPBOX_PUBLIC_TOKEN = "pk.eyJ1IjoiemFjaGFyeWJlYXR0eXd4IiwiYSI6ImNtcGRpOHFxOTBja2Iyc29nOXBtNDJkOTgifQ.A5PX2kdbDFzGYOoHmmnrKg";

(() => {
  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-canvas-test\.html$/i.test(path)) return;

  const script = document.createElement("script");
  script.src = "scripts/radar/mrms-timelapse-playback-v2.js?v=20260830e";
  script.async = true;
  document.head.appendChild(script);

  const performanceScript = document.createElement("script");
  performanceScript.src = "scripts/radar/mrms-playback-performance.js?v=20260830b";
  performanceScript.async = true;
  document.head.appendChild(performanceScript);

  const params = new URLSearchParams(window.location.search);
  if (params.get("home") === "1") {
    const homeScript = document.createElement("script");
    homeScript.src = "scripts/radar/mrms-homepage-mode.js?v=20260902a";
    homeScript.async = true;
    document.head.appendChild(homeScript);

    const mobileScript = document.createElement("script");
    mobileScript.src = "scripts/radar/mrms-homepage-mobile.js?v=20260830d";
    mobileScript.async = true;
    document.head.appendChild(mobileScript);
  }
})();
