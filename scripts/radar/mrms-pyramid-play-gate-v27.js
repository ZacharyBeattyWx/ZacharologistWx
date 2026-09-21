(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_PYRAMID_PLAY_GATE_V27__) return;
  window.__ZWX_MRALA_PYRAMID_PLAY_GATE_V27__ = true;

  const prototype = window.HTMLButtonElement?.prototype;
  if (!prototype || prototype.__zwxPyramidPlayGateV27Patched) return;
  prototype.__zwxPyramidPlayGateV27Patched = true;

  const originalClick = prototype.click;
  if (typeof originalClick !== "function") return;

  prototype.click = function(...args) {
    if (this?.id !== "playPause" || !this.disabled) {
      return originalClick.apply(this, args);
    }

    // v25 deliberately disables Play while the selected pyramid loop is being
    // loaded. Once that preload finishes it relays the original user click with
    // button.click(). Browsers suppress programmatic clicks on disabled buttons,
    // so temporarily enable this one button for that relay only.
    const wasDisabled = this.disabled;
    this.disabled = false;
    try {
      return originalClick.apply(this, args);
    } finally {
      this.disabled = wasDisabled;
    }
  };

  console.info(
    "MRALA v27: pyramid Play relay repaired • preload-complete synthetic click can reach core playback"
  );
})();
