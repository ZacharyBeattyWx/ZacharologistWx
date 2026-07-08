const LIVE_ALERT_STATE_KEY = "current-live-alert-state";

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    ...extra
  };
}

function jsonResponse(data, status = 200, ttlSeconds = 0) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders()
  };

  if (ttlSeconds > 0) {
    headers["cache-control"] = `public, max-age=${ttlSeconds}`;
  } else {
    headers["cache-control"] = "no-store";
  }

  return new Response(JSON.stringify(data), {
    status,
    headers
  });
}

function canonicalAlertId(feature, fallback = "") {
  const properties = feature?.properties || {};

  return String(
    feature?.id ||
    properties.id ||
    properties.identifier ||
    properties._alertId ||
    fallback
  ).trim();
}

function isExpiredFeature(feature, now = Date.now()) {
  const properties = feature?.properties || {};
  const expiresValue = properties.expires || properties.ends || properties.end;

  if (!expiresValue) return false;

  const expiresTime = Date.parse(expiresValue);

  if (!Number.isFinite(expiresTime)) return false;

  return expiresTime <= now;
}

function normalizeFeature(input, index = 0) {
  if (!input || typeof input !== "object") return null;

  if (input.type === "Feature") {
    const id = canonicalAlertId(input, `live-alert-${Date.now()}-${index}`);

    return {
      ...input,
      id,
      properties: {
        ...(input.properties || {}),
        _alertId: id,
        _liveAlert: true,
        _liveUpdatedAt: new Date().toISOString()
      }
    };
  }

  const id = String(
    input.id ||
    input.alertId ||
    input.identifier ||
    input.messageId ||
    `live-alert-${Date.now()}-${index}`
  ).trim();

  return {
    type: "Feature",
    id,
    geometry: input.geometry || null,
    properties: {
      ...input,
      id,
      identifier: input.identifier || id,
      event: input.event || input.productName || input.title || "NWS Alert",
      headline: input.headline || input.title || "",
      description: input.description || input.text || "",
      sent: input.sent || input.issued || new Date().toISOString(),
      effective: input.effective || input.sent || input.issued || "",
      expires: input.expires || input.ends || "",
      _alertId: id,
      _liveAlert: true,
      _liveUpdatedAt: new Date().toISOString()
    }
  };
}

function featuresFromPayload(payload) {
  if (!payload || typeof payload !== "object") return [];

  if (payload.type === "FeatureCollection" && Array.isArray(payload.features)) {
    return payload.features.map(normalizeFeature).filter(Boolean);
  }

  if (payload.type === "Feature") {
    return [normalizeFeature(payload, 0)].filter(Boolean);
  }

  if (Array.isArray(payload.features)) {
    return payload.features.map(normalizeFeature).filter(Boolean);
  }

  if (Array.isArray(payload.alerts)) {
    return payload.alerts.map(normalizeFeature).filter(Boolean);
  }

  if (payload.feature) {
    return [normalizeFeature(payload.feature, 0)].filter(Boolean);
  }

  if (payload.alert) {
    return [normalizeFeature(payload.alert, 0)].filter(Boolean);
  }

  const looksLikeAlertObject =
    payload.id ||
    payload.alertId ||
    payload.identifier ||
    payload.messageId ||
    payload.event ||
    payload.productName ||
    payload.title ||
    payload.geometry ||
    payload.properties;

  return looksLikeAlertObject
    ? [normalizeFeature(payload, 0)].filter(Boolean)
    : [];
}

function deleteIdsFromPayload(payload) {
  const values = [
    ...(Array.isArray(payload?.deleteIds) ? payload.deleteIds : []),
    ...(Array.isArray(payload?.deletedIds) ? payload.deletedIds : []),
    ...(payload?.deleteId ? [payload.deleteId] : []),
    ...(payload?.deletedId ? [payload.deletedId] : [])
  ];

  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function emptyState() {
  return {
    type: "FeatureCollection",
    featuresById: {},
    generatedAt: new Date().toISOString(),
    source: "live-alert-hub",
    sequence: 0
  };
}

function stateToFeatureCollection(state) {
  return {
    type: "FeatureCollection",
    features: Object.values(state.featuresById || {}),
    generatedAt: state.generatedAt,
    source: state.source || "live-alert-hub",
    sequence: state.sequence || 0
  };
}

export class LiveAlertHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async getState() {
    const stored = await this.state.storage.get(LIVE_ALERT_STATE_KEY);
    const current = stored && typeof stored === "object"
      ? stored
      : emptyState();

    return this.pruneExpired(current);
  }

  async saveState(state) {
    await this.state.storage.put(LIVE_ALERT_STATE_KEY, state);
    return state;
  }

  async pruneExpired(state) {
    const featuresById = {};
    let changed = false;

    for (const [id, feature] of Object.entries(state.featuresById || {})) {
      if (isExpiredFeature(feature)) {
        changed = true;
        continue;
      }

      featuresById[id] = feature;
    }

    if (!changed) return state;

    const next = {
      ...state,
      featuresById,
      generatedAt: new Date().toISOString(),
      sequence: (Number(state.sequence) || 0) + 1
    };

    await this.saveState(next);
    return next;
  }

  broadcast(message) {
    const payload = JSON.stringify(message);

    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (_error) {
        try {
          socket.close(1011, "Unable to send live alert update");
        } catch {
          // Ignore close failures.
        }
      }
    }
  }

  async handleCurrent() {
    const state = await this.getState();
    return jsonResponse(stateToFeatureCollection(state), 200, 0);
  }

  async handleStream(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse(
        { error: "Expected WebSocket upgrade" },
        426,
        0
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);

    const state = await this.getState();

    server.send(JSON.stringify({
      type: "live-alerts:snapshot",
      ...stateToFeatureCollection(state)
    }));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  authorized(request) {
    const expected = this.env.LIVE_ALERTS_INGEST_TOKEN;

    if (!expected) return false;

    return request.headers.get("authorization") === `Bearer ${expected}`;
  }

  async handleIngest(request) {
    if (!this.authorized(request)) {
      return jsonResponse({ error: "Unauthorized" }, 401, 0);
    }

    let payload;

    try {
      payload = await request.json();
    } catch (_error) {
      return jsonResponse({ error: "Invalid JSON body" }, 400, 0);
    }

    const incomingFeatures = featuresFromPayload(payload);
    const deleteIds = deleteIdsFromPayload(payload);
    const replace = payload?.mode === "replace" || payload?.replace === true;

    const current = replace ? emptyState() : await this.getState();
    const featuresById = { ...(current.featuresById || {}) };

    for (const id of deleteIds) {
      delete featuresById[id];
    }

    for (const feature of incomingFeatures) {
      const id = canonicalAlertId(feature);

      if (!id || isExpiredFeature(feature)) {
        continue;
      }

      featuresById[id] = {
        ...feature,
        id,
        properties: {
          ...(feature.properties || {}),
          _alertId: id,
          _liveAlert: true,
          _liveUpdatedAt: new Date().toISOString()
        }
      };
    }

    const next = await this.saveState({
      type: "FeatureCollection",
      featuresById,
      generatedAt: new Date().toISOString(),
      source: payload?.source || "live-alert-ingest",
      sequence: (Number(current.sequence) || 0) + 1
    });

    const update = {
      type: "live-alerts:update",
      sequence: next.sequence,
      generatedAt: next.generatedAt,
      features: incomingFeatures,
      deleteIds,
      replace
    };

    this.broadcast(update);

    return jsonResponse({
      ok: true,
      accepted: incomingFeatures.length,
      deleted: deleteIds.length,
      total: Object.keys(next.featuresById).length,
      sequence: next.sequence,
      generatedAt: next.generatedAt
    }, 200, 0);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/api/live-alerts/current" && request.method === "GET") {
      return this.handleCurrent();
    }

    if (url.pathname === "/api/live-alerts/stream" && request.method === "GET") {
      return this.handleStream(request);
    }

    if (url.pathname === "/api/live-alerts/ingest" && request.method === "POST") {
      return this.handleIngest(request);
    }

    return jsonResponse({ error: "Live alert route not found" }, 404, 0);
  }

  async webSocketMessage(socket, message) {
    if (message === "ping") {
      socket.send("pong");
    }
  }

  async webSocketClose() {
    // Durable Object WebSocket cleanup is handled by the runtime.
  }

  async webSocketError() {
    // Durable Object WebSocket cleanup is handled by the runtime.
  }
}