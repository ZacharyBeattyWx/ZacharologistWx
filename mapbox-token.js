window.MAPBOX_PUBLIC_TOKEN = "pk.eyJ1IjoiemFjaGFyeWJlYXR0eXd4IiwiYSI6ImNtcGRpOHFxOTBja2Iyc29nOXBtNDJkOTgifQ.A5PX2kdbDFzGYOoHmmnrKg";

(() => {
  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-canvas-test\.html$/i.test(path)) return;

  const script = document.createElement("script");
  script.src = "scripts/radar/mrms-timelapse-playback-v2.js?v=20260830b";
  script.async = true;
  document.head.appendChild(script);

  const params = new URLSearchParams(window.location.search);
  if (params.get("home") === "1") {
    const homeScript = document.createElement("script");
    homeScript.src = "scripts/radar/mrms-homepage-mode.js?v=20260830c";
    homeScript.async = true;
    document.head.appendChild(homeScript);

    const mobileScript = document.createElement("script");
    mobileScript.src = "scripts/radar/mrms-homepage-mobile.js?v=20260830c";
    mobileScript.async = true;
    document.head.appendChild(mobileScript);
  }
})();
