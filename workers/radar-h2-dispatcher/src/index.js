const GITHUB_DISPATCH_URL = "https://api.github.com/repos/ZacharyBeattyWx/ZacharologistWx/dispatches";
const EVENT_TYPE = "radar_h2_cron";
const CLIENT_PAYLOAD = {
  source: "cloudflare-worker-cron",
  workflow: "render-radar-json-h2",
  site_mode: "core",
};

async function dispatchRadarH2(env) {
  const timestamp = new Date().toISOString();

  if (!env.GITHUB_DISPATCH_TOKEN) {
    throw new Error("Missing required secret: GITHUB_DISPATCH_TOKEN");
  }

  const response = await fetch(GITHUB_DISPATCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "zacharologistwx-radar-dispatcher",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: EVENT_TYPE,
      client_payload: CLIENT_PAYLOAD,
    }),
  });

  const responseText = response.status === 204 ? "" : await response.text();

  console.log(
    JSON.stringify({
      timestamp,
      event_type: EVENT_TYPE,
      status: response.status,
      ok: response.ok,
      responseText: responseText || undefined,
    }),
  );

  if (!response.ok) {
    throw new Error(`GitHub repository_dispatch failed with status ${response.status}: ${responseText}`);
  }

  return { timestamp, event_type: EVENT_TYPE, status: response.status };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatchRadarH2(env));
  },

  async fetch(request) {
    const url = new URL(request.url);
    const body = {
      ok: true,
      service: "zacharologistwx-radar-h2-dispatcher",
      dispatch: "scheduled-only",
      timestamp: new Date().toISOString(),
    };

    if (url.searchParams.get("dryRun") === "1") {
      body.dryRun = true;
      body.event_type = EVENT_TYPE;
      body.client_payload = CLIENT_PAYLOAD;
    }

    return Response.json(body);
  },
};
