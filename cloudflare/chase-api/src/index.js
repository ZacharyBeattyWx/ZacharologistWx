function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization"
    }
  });
}

function normalizeRow(row) {
  return {
    status: row.status,
    targetArea: row.target_area,
    currentLocation: row.current_location,
    vehicleStatus: row.vehicle_status || "Assessing Target",
    vehicleDetail: row.vehicle_detail || "Idle",
    headline: row.headline,
    discussion: row.discussion,
    hazards: JSON.parse(row.hazards || "[]"),
    confidence: row.confidence,
    chaseProbability: row.chase_probability ?? row.confidence,
    chaseProbabilityLabel: row.chase_probability_label || "High",
    nextUpdate: row.next_update,
    streamStatus: row.stream_status || (row.is_live ? "Live" : "Offline"),
    streamStatusMode: row.stream_status || (row.is_live ? "Live" : "Offline"),
    streamTitle: row.stream_title || "",
    streamUrl: row.stream_url || "",
    streamEmbedUrl: row.stream_embed_url || "",
    lastUpdated: row.last_updated,
    isLive: Boolean(row.is_live)
  };
}


let twitchTokenCache = {
  token: "",
  expiresAt: 0
};

let twitchLiveCache = {
  channel: "",
  checkedAt: "",
  expiresAt: 0,
  live: false
};

function twitchChannelFromUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "zacharologist";

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "twitch.tv") {
      return url.pathname.split("/").filter(Boolean)[0] || "zacharologist";
    }

    if (host === "player.twitch.tv") {
      return url.searchParams.get("channel") || "zacharologist";
    }
  } catch (_error) {
    return "zacharologist";
  }

  return "zacharologist";
}

async function getTwitchAppToken(env) {
  const now = Date.now();

  if (twitchTokenCache.token && twitchTokenCache.expiresAt > now + 60000) {
    return twitchTokenCache.token;
  }

  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    throw new Error("Missing Twitch API credentials");
  }

  const body = new URLSearchParams();
  body.set("client_id", env.TWITCH_CLIENT_ID);
  body.set("client_secret", env.TWITCH_CLIENT_SECRET);
  body.set("grant_type", "client_credentials");

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`Twitch token request failed: ${response.status}`);
  }

  const tokenData = await response.json();
  const expiresIn = Number(tokenData.expires_in || 3600);

  twitchTokenCache = {
    token: tokenData.access_token,
    expiresAt: now + Math.max(60, expiresIn - 120) * 1000
  };

  return twitchTokenCache.token;
}

async function getTwitchLiveStatus(env, channel) {
  const now = Date.now();
  const cleanChannel = String(channel || "zacharologist").trim().toLowerCase();

  if (
    twitchLiveCache.channel === cleanChannel &&
    twitchLiveCache.expiresAt > now
  ) {
    return twitchLiveCache;
  }

  const token = await getTwitchAppToken(env);

  const response = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(cleanChannel)}`,
    {
      headers: {
        "authorization": `Bearer ${token}`,
        "client-id": env.TWITCH_CLIENT_ID
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Twitch stream check failed: ${response.status}`);
  }

  const data = await response.json();
  const live = Array.isArray(data.data) && data.data.length > 0;

  twitchLiveCache = {
    channel: cleanChannel,
    checkedAt: new Date().toISOString(),
    expiresAt: now + 60000,
    live
  };

  return twitchLiveCache;
}

async function resolveAutoStreamStatus(status, env) {
  const configuredStatus = String(status.streamStatus || "").trim();

  status.streamStatusMode = configuredStatus || (status.isLive ? "Live" : "Offline");

  if (configuredStatus.toLowerCase() !== "auto") {
    return status;
  }

  try {
    const channel = twitchChannelFromUrl(status.streamUrl);
    const twitch = await getTwitchLiveStatus(env, channel);

    return {
      ...status,
      streamStatusMode: "Auto",
      streamStatus: twitch.live ? "Live" : "Offline",
      streamAutoCheckedAt: twitch.checkedAt,
      streamAutoSource: "twitch",
      isLive: twitch.live
    };
  } catch (error) {
    console.warn("Twitch auto stream check failed:", error);

    return {
      ...status,
      streamStatusMode: "Auto",
      streamStatus: "Standby",
      streamAutoSource: "twitch-error",
      streamAutoError: "Unable to check Twitch right now",
      isLive: false
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/api/chase/status" && request.method === "GET") {
      const row = await env.DB.prepare(
        "SELECT * FROM chase_status WHERE id = 1"
      ).first();

      if (!row) {
        return jsonResponse({ error: "No chase status found" }, 404);
      }

      const normalized = normalizeRow(row);
      const resolved = await resolveAutoStreamStatus(normalized, env);
      return jsonResponse(resolved);
    }

    if (url.pathname === "/api/chase/status" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      const expected = `Bearer ${env.CHASE_ADMIN_TOKEN}`;

      if (!env.CHASE_ADMIN_TOKEN || auth !== expected) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      const data = await request.json();

      const hazards = Array.isArray(data.hazards)
        ? data.hazards.map((item) => String(item).trim()).filter(Boolean)
        : [];

      const confidence = Math.max(0, Math.min(100, Number(data.confidence || 0)));
      const chaseProbability = Math.max(0, Math.min(100, Number(data.chaseProbability || confidence)));
      const chaseProbabilityLabel = String(data.chaseProbabilityLabel || "High");

      const saved = {
        status: String(data.status || "Monitoring"),
        targetArea: String(data.targetArea || "T.B.D."),
        currentLocation: String(data.currentLocation || "Not actively chasing"),
        vehicleStatus: String(data.vehicleStatus || "Assessing Target"),
        vehicleDetail: String(data.vehicleDetail || "Idle"),
        headline: String(data.headline || "Monitoring potential chase opportunities"),
        discussion: String(data.discussion || ""),
        hazards,
        confidence,
        chaseProbability,
        chaseProbabilityLabel,
        nextUpdate: String(data.nextUpdate || "As needed"),
        streamStatus: String(data.streamStatus || (data.isLive ? "Live" : "Offline")),
        streamTitle: String(data.streamTitle || ""),
        streamUrl: String(data.streamUrl || ""),
        streamEmbedUrl: String(data.streamEmbedUrl || ""),
        lastUpdated: new Date().toISOString(),
        isLive: Boolean(data.isLive) || String(data.streamStatus || "").toLowerCase() === "live"
      };

      await env.DB.prepare(`
        UPDATE chase_status
        SET
          status = ?,
          target_area = ?,
          current_location = ?,
          vehicle_status = ?,
          vehicle_detail = ?,
          headline = ?,
          discussion = ?,
          hazards = ?,
          confidence = ?,
          chase_probability = ?,
          chase_probability_label = ?,
          next_update = ?,
          stream_status = ?,
          stream_title = ?,
          stream_url = ?,
          stream_embed_url = ?,
          last_updated = ?,
          is_live = ?
        WHERE id = 1
      `).bind(
        saved.status,
        saved.targetArea,
        saved.currentLocation,
        saved.vehicleStatus,
        saved.vehicleDetail,
        saved.headline,
        saved.discussion,
        JSON.stringify(saved.hazards),
        saved.confidence,
        saved.chaseProbability,
        saved.chaseProbabilityLabel,
        saved.nextUpdate,
        saved.streamStatus,
        saved.streamTitle,
        saved.streamUrl,
        saved.streamEmbedUrl,
        saved.lastUpdated,
        saved.isLive ? 1 : 0
      ).run();

      return jsonResponse({ ok: true, status: saved });
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};





