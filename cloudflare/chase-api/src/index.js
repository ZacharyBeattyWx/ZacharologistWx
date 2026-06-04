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
    headline: row.headline,
    discussion: row.discussion,
    hazards: JSON.parse(row.hazards || "[]"),
    confidence: row.confidence,
    chaseProbability: row.chase_probability ?? row.confidence,
    chaseProbabilityLabel: row.chase_probability_label || "High",
    nextUpdate: row.next_update,
    lastUpdated: row.last_updated,
    isLive: Boolean(row.is_live)
  };
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

      return jsonResponse(normalizeRow(row));
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
        headline: String(data.headline || "Monitoring potential chase opportunities"),
        discussion: String(data.discussion || ""),
        hazards,
        confidence,
        chaseProbability,
        chaseProbabilityLabel,
        nextUpdate: String(data.nextUpdate || "As needed"),
        lastUpdated: new Date().toISOString(),
        isLive: Boolean(data.isLive)
      };

      await env.DB.prepare(`
        UPDATE chase_status
        SET
          status = ?,
          target_area = ?,
          current_location = ?,
          headline = ?,
          discussion = ?,
          hazards = ?,
          confidence = ?,
          chase_probability = ?,
          chase_probability_label = ?,
          next_update = ?,
          last_updated = ?,
          is_live = ?
        WHERE id = 1
      `).bind(
        saved.status,
        saved.targetArea,
        saved.currentLocation,
        saved.headline,
        saved.discussion,
        JSON.stringify(saved.hazards),
        saved.confidence,
        saved.chaseProbability,
        saved.chaseProbabilityLabel,
        saved.nextUpdate,
        saved.lastUpdated,
        saved.isLive ? 1 : 0
      ).run();

      return jsonResponse({ ok: true, status: saved });
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};

