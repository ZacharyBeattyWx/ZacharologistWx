(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_NATIVE_ONLY_V23__) return;
  window.__ZWX_MRALA_NATIVE_ONLY_V23__ = true;

  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";
  const OVERVIEW_ID = "mrms-native-numeric-dbz-layer";
  const MOBILE =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (!mapPrototype?.addLayer || mapPrototype.__zwxNativeOnlyV23Installed) return;
  mapPrototype.__zwxNativeOnlyV23Installed = true;

  let overviewLayer = null;
  let nativeLayer = null;
  let handoffReady = false;
  let handoffTimer = 0;
  let purgeOverviewTextures = () => {};
  let baseActivateFrame = null;
  let baseSetBlendFrames = null;

  function isOverviewKey(key) {
    return String(key || "").startsWith("overview:");
  }

  function frameIdFromOverviewKey(key) {
    const text = String(key || "");
    return text.startsWith("overview:")
      ? text.slice("overview:".length)
      : "";
  }

  function nativeOnlyActive() {
    return !MOBILE && Boolean(nativeLayer?.enabled) && handoffReady;
  }

  function visibleIds() {
    return [...new Set((nativeLayer?.visibleIds || []).map(String))];
  }

  function overviewState() {
    const fromId = frameIdFromOverviewKey(overviewLayer?.activeKey);
    const nextId = frameIdFromOverviewKey(overviewLayer?.nextKey) || fromId;
    const mix = Math.max(0, Math.min(1, Number(overviewLayer?.mixAmount || 0)));
    const blending = Boolean(overviewLayer?.nextKey) && mix > 0;
    return { fromId, nextId, mix, blending };
  }

  function synchronizeNativeToOverview() {
    if (!nativeLayer?.enabled || !overviewLayer) return false;

    const ids = visibleIds();
    const state = overviewState();
    if (!ids.length || !state.fromId) return false;

    if (!nativeLayer.hasFrame?.(state.fromId, ids)) return false;
    if (state.blending && !nativeLayer.hasFrame?.(state.nextId, ids)) return false;

    if (state.blending) {
      if (typeof baseSetBlendFrames !== "function") return false;
      const ok = baseSetBlendFrames.call(
        nativeLayer,
        state.fromId,
        state.nextId,
        state.mix
      );
      if (!ok) return false;
    } else {
      if (typeof baseActivateFrame !== "function") return false;
      if (
        String(nativeLayer.fromFrame || "") !== state.fromId ||
        String(nativeLayer.toFrame || "") !== state.fromId
      ) {
        const ok = baseActivateFrame.call(nativeLayer, state.fromId);
        if (!ok) return false;
      }
    }

    const exactFrom = String(nativeLayer.fromFrame || "") === state.fromId;
    const exactTo = state.blending
      ? String(nativeLayer.toFrame || "") === state.nextId
      : String(nativeLayer.toFrame || "") === state.fromId;

    return exactFrom && exactTo;
  }

  function clearHandoffTimer() {
    if (handoffTimer) window.clearTimeout(handoffTimer);
    handoffTimer = 0;
  }

  function scheduleHandoff(delay = 60) {
    if (MOBILE || handoffReady || !nativeLayer?.enabled) return;
    clearHandoffTimer();

    handoffTimer = window.setTimeout(() => {
      handoffTimer = 0;
      if (handoffReady || !nativeLayer?.enabled) return;

      // Do not release overview merely because some native frame exists.
      // Native must be complete for the current viewport AND synchronized to
      // the exact overview timeline frame/blend that the playback clock shows.
      if (!synchronizeNativeToOverview()) {
        scheduleHandoff(60);
        return;
      }

      window.requestAnimationFrame?.(() => {
        window.requestAnimationFrame?.(() => {
          if (!nativeLayer?.enabled || !synchronizeNativeToOverview()) {
            scheduleHandoff(60);
            return;
          }

          handoffReady = true;
          purgeOverviewTextures();
          overviewLayer?.map?.triggerRepaint?.();
          nativeLayer?.map?.triggerRepaint?.();

          console.info(
            "MRALA v23 native-only handoff: exact timeline-native frame ready • overview released once"
          );
        });
      });
    }, Math.max(0, delay));
  }

  const previousAddLayer = mapPrototype.addLayer;
  mapPrototype.addLayer = function(layer, ...args) {
    const result = previousAddLayer.call(this, layer, ...args);

    if (layer?.id === OVERVIEW_ID && !layer.__zwxNativeOnlyV23OverviewPatched) {
      layer.__zwxNativeOnlyV23OverviewPatched = true;
      overviewLayer = layer;

      const baseEvictExcept = layer.evictExcept;
      purgeOverviewTextures = () => {
        if (!overviewLayer || typeof baseEvictExcept !== "function") return;
        baseEvictExcept.call(overviewLayer, new Set());
        overviewLayer.map?.triggerRepaint?.();
      };

      const originalHasTexture = layer.hasTexture;
      if (typeof originalHasTexture === "function") {
        layer.hasTexture = function(key) {
          if (nativeOnlyActive() && isOverviewKey(key)) return true;
          return originalHasTexture.call(this, key);
        };
      }

      const originalActivate = layer.activate;
      if (typeof originalActivate === "function") {
        layer.activate = function(key) {
          if (nativeOnlyActive() && isOverviewKey(key)) {
            this.activeKey = String(key);
            this.nextKey = "";
            this.mixAmount = 0;
            this.map?.triggerRepaint?.();
            return true;
          }
          return originalActivate.call(this, key);
        };
      }

      const originalSetBlend = layer.setBlend;
      if (typeof originalSetBlend === "function") {
        layer.setBlend = function(fromKey, toKey, amount) {
          if (
            nativeOnlyActive() &&
            isOverviewKey(fromKey) &&
            isOverviewKey(toKey)
          ) {
            this.activeKey = String(fromKey);
            this.nextKey = String(toKey);
            this.mixAmount = Math.max(0, Math.min(1, Number(amount) || 0));
            this.map?.triggerRepaint?.();
            return true;
          }
          return originalSetBlend.call(this, fromKey, toKey, amount);
        };
      }

      const originalRender = layer.render;
      if (typeof originalRender === "function") {
        layer.render = function(...renderArgs) {
          if (nativeOnlyActive()) return;
          return originalRender.apply(this, renderArgs);
        };
      }
    }

    if (layer?.id === NATIVE_ID && !layer.__zwxNativeOnlyV23NativePatched) {
      layer.__zwxNativeOnlyV23NativePatched = true;
      nativeLayer = layer;
      baseActivateFrame = layer.activateFrame;
      baseSetBlendFrames = layer.setBlendFrames;

      const originalRender = layer.render;
      if (typeof originalRender === "function") {
        layer.render = function(...renderArgs) {
          if (!MOBILE && this.enabled && !handoffReady) return;
          return originalRender.apply(this, renderArgs);
        };
      }

      const originalSetEnabled = layer.setEnabled;
      if (typeof originalSetEnabled === "function") {
        layer.setEnabled = function(enabled) {
          const wasEnabled = Boolean(this.enabled);
          const output = originalSetEnabled.call(this, enabled);
          const isEnabled = Boolean(this.enabled);

          // Only reset the handoff on a real LOD transition. Repeated
          // setEnabled(true) calls must not blank a native loop that is already
          // active and resident.
          if (!wasEnabled && isEnabled && !MOBILE) {
            handoffReady = false;
            scheduleHandoff(30);
          } else if (wasEnabled && !isEnabled) {
            handoffReady = false;
            clearHandoffTimer();
            overviewLayer?.map?.triggerRepaint?.();
          } else if (isEnabled && !handoffReady && !MOBILE) {
            scheduleHandoff(30);
          }

          return output;
        };
      }

      const originalSetVisible = layer.setVisible;
      if (typeof originalSetVisible === "function") {
        layer.setVisible = function(ids) {
          const output = originalSetVisible.call(this, ids);
          if (this.enabled && !handoffReady && !MOBILE) scheduleHandoff(20);
          return output;
        };
      }

      const originalAddTexture = layer.addTexture;
      if (typeof originalAddTexture === "function") {
        layer.addTexture = function(...textureArgs) {
          const output = originalAddTexture.apply(this, textureArgs);
          if (this.enabled && !handoffReady && !MOBILE) scheduleHandoff(20);
          return output;
        };
      }

      const originalActivateFrame = layer.activateFrame;
      if (typeof originalActivateFrame === "function") {
        layer.activateFrame = function(...activateArgs) {
          const output = originalActivateFrame.apply(this, activateArgs);
          if (output && this.enabled && !handoffReady && !MOBILE) scheduleHandoff(10);
          return output;
        };
      }

      const originalSetBlendFrames = layer.setBlendFrames;
      if (typeof originalSetBlendFrames === "function") {
        layer.setBlendFrames = function(...blendArgs) {
          const output = originalSetBlendFrames.apply(this, blendArgs);
          if (output && this.enabled && !handoffReady && !MOBILE) scheduleHandoff(10);
          return output;
        };
      }
    }

    return result;
  };

  window.__ZWX_MRALA_NATIVE_ONLY_STATE__ = () => ({
    mobile: MOBILE,
    active: nativeOnlyActive(),
    nativeEnabled: Boolean(nativeLayer?.enabled),
    handoffReady,
    exactTimelineReady: synchronizeNativeToOverview(),
    overviewTextures: Number(overviewLayer?.textures?.size || 0),
    nativeTextures: Number(nativeLayer?.textures?.size || 0),
    overview: overviewState(),
    nativeFromFrame: String(nativeLayer?.fromFrame || ""),
    nativeToFrame: String(nativeLayer?.toFrame || ""),
    fullNative: window.__ZWX_MRALA_FULL_NATIVE_STATE__?.() || null,
    lodHandoff: window.__ZWX_MRALA_LOD_HANDOFF_STATE__?.() || null
  });

  console.info(
    MOBILE
      ? "MRALA v23: mobile unchanged"
      : "MRALA v23: native-only handoff requires exact timeline sync and ignores redundant enable calls"
  );
})();
