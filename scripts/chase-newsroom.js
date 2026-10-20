(() => {
  "use strict";
  const REFRESH_MS = 15000;
  const GPS_MAX_AGE = 90000;
  const FALLBACK_CHANNEL = "https://www.twitch.tv/zacharologist";

  function meaningful(value, fallback = "") {
    if (typeof value !== "string") return fallback;
    const result = value.trim();
    return !result || /^(?:n\/?a|none|null|undefined|t\.?b\.?d\.?|unknown|[-—]+)$/i.test(result) ? fallback : result;
  }
  function percent(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  }
  function coordinate(value, limit) {
    if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
  }
  function safeUrl(raw) {
    if (typeof raw !== "string" || !raw.trim()) return "";
    try { const url = new URL(raw); return url.protocol === "https:" ? url.toString() : ""; } catch { return ""; }
  }
  function toneFor(status) {
    if (/complete|finished/i.test(status)) return "completed";
    if (/offline|inactive|off duty|not activ|awaiting|connecting/i.test(status)) return "offline";
    if (/chasing|active|en route|deploy|on scene/i.test(status)) return "active";
    return "monitoring";
  }
  function locationLabel(value) {
    return meaningful(value)
      .replace(/GPS\s*(?:±|\u252c\u2592)\s*\d+(?:\.\d+)?\s*m/gi, "")
      .replace(/&middot;/g, "·")
      .replace(/(?:^\s*[·|,;]+\s*)|(?:\s*[·|,;]+\s*$)/g, "")
      .replace(/\s{2,}/g, " ").trim();
  }
  function deriveView(data, now = Date.now()) {
    const status = meaningful(data.status, "Monitoring");
    const tone = toneFor(status);
    const gps = data.chaseLocation || {};
    const lat = coordinate(gps.lat, 90), lon = coordinate(gps.lon, 180);
    const gpsTimestamp = Date.parse(gps.updatedAt || "");
    const age = now - gpsTimestamp;
    const shared = gps.mapDisplay === true;
    const canTrack = shared && gps.isStale !== true && lat !== null && lon !== null &&
      Number.isFinite(age) && age >= -30000 && age < GPS_MAX_AGE;
    const location = locationLabel(data.currentLocation) ||
      (canTrack ? "Near " + lat.toFixed(2) + ", " + lon.toFixed(2) :
        tone === "active" ? "Location not shared" : "Not actively chasing");
    const streamStatus = meaningful(data.streamStatus, data.isLive === true ? "Live" : "Offline");
    const streamLive = /^(?:live|online|streaming|active)$/i.test(streamStatus);
    const hazardValues = Array.isArray(data.hazards) ? data.hazards :
      typeof data.hazards === "string" ? data.hazards.split(/\s*(?:,|;|\||\band\b)\s*/i) : [];
    const hazards = [...new Set(hazardValues.map(v => meaningful(v)).filter(Boolean))];
    const confidence = percent(data.confidence), probability = percent(data.chaseProbability);
    const lastUpdated = Date.parse(data.lastUpdated || "");
    const mapUrl = canTrack ? "level2-mobile-radar.html?" + new URLSearchParams({
      chaseLat: String(lat), chaseLon: String(lon), chaseZoom: "9", from: "chase-dashboard"
    }).toString() : "";
    return {
      status, tone, canTrack, shared, gpsTimestamp, mapUrl, location,
      target: meaningful(data.targetArea, "No target selected"),
      headline: meaningful(data.headline, tone === "active" ? "Chase operations underway" : "Watching the next opportunity"),
      discussion: meaningful(data.discussion, "Follow this desk for the next published target discussion and deployment update."),
      nextUpdate: meaningful(data.nextUpdate, "As conditions change"),
      vehicle: meaningful(data.vehicleStatus, tone === "active" ? "Deployment in progress" : "Standby"),
      vehicleDetail: meaningful(data.vehicleDetail, tone === "active" ? "Follow the mission update" : "Awaiting the next deployment"),
      streamStatus, streamLive, streamTitle: meaningful(data.streamTitle, "Zacharologist Wx field coverage"),
      streamUrl: safeUrl(data.streamUrl) || FALLBACK_CHANNEL,
      embedUrl: safeUrl(data.streamEmbedUrl),
      hazards, confidence, probability,
      probabilityLabel: meaningful(data.chaseProbabilityLabel, probability === null ? "Watching for the next opportunity" : "Published deployment likelihood"),
      lastUpdated: Number.isFinite(lastUpdated) ? lastUpdated : null
    };
  }
  function embedFor(view, hostname) {
    if (!view.streamLive) return "";
    if (view.embedUrl) {
      const url = new URL(view.embedUrl);
      if (url.hostname.toLowerCase() === "player.twitch.tv") {
        url.searchParams.delete("parent"); url.searchParams.append("parent", hostname);
      }
      return url.toString();
    }
    const source = new URL(view.streamUrl);
    const host = source.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "twitch.tv" || host === "player.twitch.tv") {
      const channel = host === "player.twitch.tv" ? source.searchParams.get("channel") : source.pathname.split("/").filter(Boolean)[0];
      if (!channel || !/^[a-zA-Z0-9_]+$/.test(channel)) return "";
      const player = new URL("https://player.twitch.tv/");
      player.searchParams.set("channel", channel); player.searchParams.set("parent", hostname);
      player.searchParams.set("autoplay", "true"); player.searchParams.set("muted", "true");
      return player.toString();
    }
    if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
      const video = host === "youtu.be" ? source.pathname.split("/")[1] :
        source.searchParams.get("v") || source.pathname.match(/^\/(?:live|embed)\/([^/?]+)/)?.[1];
      if (video && /^[a-zA-Z0-9_-]{11}$/.test(video)) {
        return "https://www.youtube-nocookie.com/embed/" + video + "?autoplay=1&mute=1";
      }
    }
    return "";
  }
  /* DOM wiring starts here. Pure formatting above is also checked without a browser. */
  const byId = id => document.getElementById(id);
  const root = byId("chaseDashboard");
  if (!root) return;
  let busy = false, lastData = null, expiryTimer = null;
  const setText = (id, value) => { if (byId(id).textContent !== value) byId(id).textContent = value; };
  const setAll = (attribute, value) => {
    document.querySelectorAll("[" + attribute + "]").forEach(el => { el.textContent = value; });
  };
  function setMeter(prefix, value) {
    const meter = byId(prefix + "Meter");
    meter.hidden = value === null;
    if (value === null) { meter.removeAttribute("aria-valuenow"); return; }
    meter.setAttribute("aria-valuenow", String(value));
    byId(prefix + "Fill").style.width = value + "%";
  }
  function formatIssued(timestamp) {
    return new Date(timestamp).toLocaleString([], {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
  }
  function render(data) {
    const view = deriveView(data);
    setAll("data-chase-status", view.status);
    setAll("data-chase-hero-target", view.target);
    setAll("data-chase-location", view.location);
    setAll("data-chase-next-update", view.nextUpdate);
    setAll("data-chase-vehicle-status", view.vehicle);
    setAll("data-chase-vehicle-detail", view.vehicleDetail);
    setAll("data-chase-stream-status", view.streamStatus);
    setAll("data-chase-headline", view.headline);
    setAll("data-chase-discussion", view.discussion);
    setText("missionBadge", view.status); byId("missionBadge").dataset.tone = view.tone;
    setText("broadcastBadge", view.streamStatus);
    byId("broadcastBadge").dataset.tone = view.streamLive ? "active" : "offline";
    setText("confidenceValue", view.confidence === null ? "Target pending" : view.confidence + "%");
    setText("probabilityValue", view.probability === null ? "Monitoring" : view.probability + "%");
    setText("confidenceNote", view.confidence === null ? "Confidence follows the published target" : "Confidence in the published target");
    setText("probabilityNote", view.probabilityLabel);
    setMeter("confidence", view.confidence); setMeter("probability", view.probability);
    const hazardList = byId("chaseHazards");
    hazardList.replaceChildren();
    (view.hazards.length ? view.hazards : ["No primary hazards listed"]).forEach(hazard => {
      const chip = document.createElement("span");
      chip.className = "chase-hazard";
      chip.textContent = hazard;
      chip.dataset.type = /tornado/i.test(hazard) ? "tornado" : /hail/i.test(hazard) ? "hail" :
        /wind|gust/i.test(hazard) ? "wind" : /flood|hydro/i.test(hazard) ? "flood" : "other";
      hazardList.appendChild(chip);
    });
    const tracking = byId("trackChase");
    tracking.hidden = !view.canTrack;
    if (view.canTrack) { tracking.href = view.mapUrl; tracking.removeAttribute("aria-disabled"); }
    else { tracking.removeAttribute("href"); tracking.setAttribute("aria-disabled", "true"); }
    setText("trackLocation", view.location);
    setText("positionSource", view.canTrack ? "Fresh shared GPS fix" : "Published chase location");
    setText("trackingNote", view.canTrack ? "Fresh shared position. Open the interactive map to follow the chase." :
      view.shared ? "GPS has not refreshed recently. Tracking returns automatically with a fresh shared position." :
        "Map tracking appears when a fresh GPS position is shared.");
    if (expiryTimer !== null) window.clearTimeout(expiryTimer);
    expiryTimer = view.canTrack ? window.setTimeout(() => { if (lastData) render(lastData); },
      Math.max(1, view.gpsTimestamp + GPS_MAX_AGE - Date.now() + 10)) : null;
    const embedUrl = embedFor(view, window.location.hostname);
    const frame = byId("chaseStream");
    if (embedUrl) {
      if (frame.getAttribute("src") !== embedUrl) frame.src = embedUrl;
      frame.hidden = false;
    } else {
      frame.removeAttribute("src"); frame.hidden = true;
    }
    byId("chaseStreamPlaceholder").hidden = Boolean(embedUrl);
    byId("expandChasePlayer").hidden = !embedUrl || !byId("chasePlayer").requestFullscreen;
    setText("streamTitle", view.streamTitle);
    setText("playerEyebrow", view.streamLive ? "Storm chase broadcast" : "Between broadcasts");
    setText("playerHeadline", view.streamLive ? "Live coverage" : "Off air");
    setText("playerMessage", view.streamLive ? "Coverage is underway. Open the stream link below to watch on the broadcast channel." :
      "The stream is offline. Follow the mission briefing for the next deployment and live coverage.");
    setText("playerStatus", view.streamStatus.toUpperCase());
    byId("primaryStreamLink").href = view.streamUrl;
    setText("primaryStreamLink", view.streamLive ? "Open live stream ↗" : "Open stream channel ↗");
    setText("briefingUpdated", view.lastUpdated === null ? "Briefing timestamp not posted" : "Updated " + formatIssued(view.lastUpdated));
    setText("missionIssued", view.lastUpdated === null ? "Follows the next published update" : formatIssued(view.lastUpdated));
    root.dataset.mission = view.tone;
    root.dataset.broadcast = view.streamLive ? "live" : "offline";
  }
  function setConnection(state, label) {
    byId("chaseConnection").dataset.state = state; setText("chaseConnection", label);
  }
  async function loadChaseStatus() {
    if (busy) return;
    busy = true;
    const button = byId("refreshChase"), abort = new AbortController();
    button.disabled = true; button.textContent = "Refreshing…";
    const timeout = window.setTimeout(() => abort.abort(), 12000);
    try {
      const response = await fetch("/api/chase/status", { cache: "no-store", signal: abort.signal });
      if (!response.ok) throw new Error("Chase status returned HTTP " + response.status);
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data) ||
        !["status", "headline", "targetArea", "streamStatus", "lastUpdated"].some(key => key in data)) {
        throw new Error("Invalid chase status response");
      }
      lastData = data; render(data);
      setConnection("connected", "Connected to the chase desk");
      setText("chaseFeedNote", "Published mission details • Live status refreshes every 15 seconds.");
    } catch (error) {
      if (lastData) {
        render(lastData);
        setConnection("error", "Reconnecting • Last received briefing shown");
        setText("chaseFeedNote", "Connection interrupted. Keeping the last received briefing while retrying.");
      } else {
        setConnection("error", "Reconnecting to the chase desk");
        setAll("data-chase-status", "Awaiting update");
        setAll("data-chase-hero-target", "Target pending");
        setAll("data-chase-location", "Location follows the briefing");
        setAll("data-chase-vehicle-status", "Awaiting update");
        setAll("data-chase-vehicle-detail", "Vehicle report follows the briefing");
        setAll("data-chase-stream-status", "Checking connection");
        setText("playerMessage", "Reconnecting to the chase desk. Channel links and weather tools remain available below.");
        setText("playerStatus", "RECONNECTING");
        setText("confidenceValue", "Target pending"); setText("probabilityValue", "Monitoring");
        setText("chaseFeedNote", "Connecting to the published mission briefing. Retrying automatically every 15 seconds.");
      }
      console.warn("Chase dashboard refresh failed:", error);
    } finally {
      window.clearTimeout(timeout); busy = false; button.disabled = false; button.textContent = "Refresh";
      root.setAttribute("aria-busy", "false");
    }
  }
  byId("refreshChase").addEventListener("click", loadChaseStatus);
  const nav = byId("siteNav"), toggle = byId("mobileNavToggle");
  function setMenu(open) {
    nav.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  }
  toggle.addEventListener("click", () => setMenu(toggle.getAttribute("aria-expanded") !== "true"));
  document.addEventListener("click", event => {
    if (!event.target.closest("[data-interior-site-header]")) setMenu(false);
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") setMenu(false); });
  window.addEventListener("resize", () => { if (window.innerWidth > 760) setMenu(false); });
  byId("expandChasePlayer").addEventListener("click", async () => {
    try { await byId("chasePlayer").requestFullscreen?.(); }
    catch { setText("expandChasePlayer", "Use the player's fullscreen control"); }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadChaseStatus(); });
  loadChaseStatus();
  window.setInterval(() => { if (!document.hidden) loadChaseStatus(); }, REFRESH_MS);
})();
