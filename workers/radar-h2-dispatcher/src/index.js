const GITHUB_DISPATCH_URL = "https://api.github.com/repos/ZacharyBeattyWx/ZacharologistWx/dispatches";
const DISPATCH_REQUESTS = [
  {
    event_type: "radar_h2_cron",
    client_payload: {
      source: "cloudflare-worker-cron",
      workflow: "render-radar-json-h2",
      site_mode: "core",
    },
  },
  {
    event_type: "radar_level2_cron",
    client_payload: {
      source: "cloudflare-worker-cron",
      workflow: "render-level2-radar",
      site: "",
      source_count: "25",
    },
  },
];

async function dispatchRepositoryDispatch(env, dispatchRequest) {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    throw new Error("Missing required secret: GITHUB_DISPATCH_TOKEN");
  }

  const timestamp = new Date().toISOString();
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
      event_type: dispatchRequest.event_type,
      client_payload: dispatchRequest.client_payload,
    }),
  });

  const responseText = response.status === 204 ? "" : await response.text();

  console.log(
    JSON.stringify({
      timestamp,
      event_type: dispatchRequest.event_type,
      status: response.status,
      ok: response.ok,
      responseText: responseText || undefined,
    }),
  );

  if (!response.ok) {
    throw new Error(`GitHub repository_dispatch failed with status ${response.status}: ${responseText}`);
  }

  return { timestamp, event_type: dispatchRequest.event_type, status: response.status };
}

async function dispatchAllRadarWorkflows(env) {
  return Promise.all(
    DISPATCH_REQUESTS.map((dispatchRequest) => dispatchRepositoryDispatch(env, dispatchRequest)),
  );
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatchAllRadarWorkflows(env));
  },

  async fetch(request) {
    const url = new URL(request.url);
    const body = {
      ok: true,
      service: "zacharologistwx-radar-h2-dispatcher",
      dispatch: "scheduled-only",
      timestamp: new Date().toISOString(),
      event_types: DISPATCH_REQUESTS.map((dispatchRequest) => dispatchRequest.event_type),
    };

    if (url.searchParams.get("dryRun") === "1") {
      body.dryRun = true;
      body.dispatches = DISPATCH_REQUESTS;
    }

    return Response.json(body);
  },
};
