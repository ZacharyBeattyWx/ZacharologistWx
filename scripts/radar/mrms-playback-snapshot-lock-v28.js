(() => {
  "use strict";

  const path = String(window.location.pathname || "");
  if (!/\/mosaic-radar-home\.html$/i.test(path)) return;
  if (window.__ZWX_MRALA_PLAYBACK_SNAPSHOT_V28__) return;
  window.__ZWX_MRALA_PLAYBACK_SNAPSHOT_V28__ = true;

  const MANIFEST_RE = /\/mrms-native-numeric\/manifest\.json(?:[?#]|$)/i;
  const NATIVE_ID = "mrms-native-numeric-viewport-chunks";

  let locked = false;
  let cachedManifest = null;

  function playButton() {
    return document.getElementById("playPause");
  }

  function coreIsPlaying() {
    return /Pause/i.test(String(playButton()?.textContent || ""));
  }

  function setLocked(next) {
    const value = Boolean(next);
    if (value === locked) return;
    locked = value;
    window.__ZWX_MRALA_PLAYBACK_LOCK_V28__ = locked;

    if (locked) {
      console.info(
        "MRALA v28 playback snapshot locked • manifest/viewport refresh paused until playback stops"
      );
    } else {
      console.info(
        "MRALA v28 playback snapshot released • live manifest/viewport refresh restored"
      );
    }
  }

  function syncLock() {
    setLocked(coreIsPlaying());
  }

  // Keep v25's manifest wrapper completely out of the call chain while the
  // loop is playing. The core player receives the last known manifest snapshot,
  // so no new frames can enter the active 3-hour timeline mid-loop and v25 does
  // not schedule another full-loop preload/eviction pass.
  const previousFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const url = String(
      typeof input === "string"
        ? input
        : input?.url || ""
    );

    if (MANIFEST_RE.test(url) && locked && cachedManifest) {
      const headers = new Headers(cachedManifest.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("etag");

      return new Response(cachedManifest.body, {
        status: cachedManifest.status,
        statusText: cachedManifest.statusText,
        headers
      });
    }

    const response = await previousFetch(input, init);

    if (MANIFEST_RE.test(url) && response.ok && !locked) {
      try {
        cachedManifest = {
          body: await response.clone().text(),
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()]
        };
      } catch (error) {
        console.warn("MRALA v28 manifest snapshot capture failed", error);
      }
    }

    return response;
  };

  // v25 registers its own zoomend/moveend refresh callbacks while the native
  // layer is added. Wrap only those registrations so camera interaction cannot
  // trigger a pyramid rebuild while playback is locked. Other map listeners are
  // left alone.
  const mapPrototype = window.mapboxgl?.Map?.prototype;
  if (mapPrototype?.addLayer && !mapPrototype.__zwxPlaybackSnapshotV28Installed) {
    mapPrototype.__zwxPlaybackSnapshotV28Installed = true;
    const previousAddLayer = mapPrototype.addLayer;

    mapPrototype.addLayer = function(layer, ...args) {
      if (layer?.id !== NATIVE_ID || typeof this.on !== "function") {
        return previousAddLayer.call(this, layer, ...args);
      }

      const mapInstance = this;
      const instanceOn = mapInstance.on;

      mapInstance.on = function(type, listener, ...onArgs) {
        if (
          (type === "zoomend" || type === "moveend") &&
          typeof listener === "function"
        ) {
          const wrapped = function(...eventArgs) {
            if (locked) return mapInstance;
            return listener.apply(this, eventArgs);
          };
          return instanceOn.call(this, type, wrapped, ...onArgs);
        }
        return instanceOn.call(this, type, listener, ...onArgs);
      };

      try {
        const result = previousAddLayer.call(mapInstance, layer, ...args);

        // Core/legacy eviction calls are harmless while paused, but during a
        // resident playback loop they can only reduce the frame set we already
        // paid to preload. Freeze them until Pause.
        if (typeof layer.evictExcept === "function" && !layer.__zwxPlaybackSnapshotV28EvictPatched) {
          layer.__zwxPlaybackSnapshotV28EvictPatched = true;
          const previousEvictExcept = layer.evictExcept;
          layer.evictExcept = function(...evictArgs) {
            if (locked) return;
            return previousEvictExcept.apply(this, evictArgs);
          };
        }

        return result;
      } finally {
        mapInstance.on = instanceOn;
      }
    };
  }

  function installButtonObserver() {
    const button = playButton();
    if (!button) return false;

    const observer = new MutationObserver(syncLock);
    observer.observe(button, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"]
    });

    button.addEventListener("click", () => {
      window.setTimeout(syncLock, 0);
      window.setTimeout(syncLock, 50);
    });

    syncLock();
    return true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installButtonObserver, { once: true });
  } else if (!installButtonObserver()) {
    window.setTimeout(installButtonObserver, 0);
  }

  console.info(
    "MRALA v28: playback snapshot lock armed • resident pyramid loop stays immutable while playing"
  );
})();
