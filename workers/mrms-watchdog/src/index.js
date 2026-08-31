const OWNER = "ZacharyBeattyWx";
const REPO = "ZacharologistWx";
const WORKFLOW = "publish-mrms-radar-data.yml";
const MAX_PUBLISH_AGE_MS = 8 * 60 * 1000;

const manifestUrl =
  `https://raw.githubusercontent.com/${OWNER}/${REPO}/radar-data/manifest.json`;
const workflowRunsUrl =
  `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`;
const dispatchUrl =
  `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ZacharologistWx-MRMS-Watchdog",
  };
}

async function getManifest() {
  const response = await fetch(`${manifestUrl}?t=${Date.now()}`, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!response.ok) {
    throw new Error(`Manifest request failed: ${response.status}`);
  }
  return response.json();
}

async function workflowAlreadyRunning(token) {
  const response = await fetch(workflowRunsUrl, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`Workflow-runs request failed: ${response.status}`);
  }
  const payload = await response.json();
  return (payload.workflow_runs || []).some(
    (run) => run.status === "queued" || run.status === "in_progress",
  );
}

async function dispatchWorkflow(token) {
  const response = await fetch(dispatchUrl, {
    method: "POST",
    headers: {
      ...githubHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Workflow dispatch failed: ${response.status} ${body}`);
  }
}

async function checkPublisher(env) {
  if (!env.GITHUB_ACTIONS_TOKEN) {
    throw new Error("Missing GITHUB_ACTIONS_TOKEN secret");
  }

  const manifest = await getManifest();
  const generatedAt = Date.parse(manifest.generated_at || "");
  if (!Number.isFinite(generatedAt)) {
    throw new Error("Published MRMS manifest has no valid generated_at timestamp");
  }

  const ageMs = Date.now() - generatedAt;
  const ageMinutes = ageMs / 60000;

  if (ageMs <= MAX_PUBLISH_AGE_MS) {
    console.log(`MRMS publisher healthy: ${ageMinutes.toFixed(1)} minutes old`);
    return { action: "healthy", ageMinutes };
  }

  if (await workflowAlreadyRunning(env.GITHUB_ACTIONS_TOKEN)) {
    console.log(
      `MRMS publisher is ${ageMinutes.toFixed(1)} minutes old, but a recovery run is active`,
    );
    return { action: "already-running", ageMinutes };
  }

  await dispatchWorkflow(env.GITHUB_ACTIONS_TOKEN);
  console.log(
    `MRMS publisher was ${ageMinutes.toFixed(1)} minutes old; dispatched recovery workflow`,
  );
  return { action: "dispatched", ageMinutes };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(checkPublisher(env));
  },

  async fetch(_request, env) {
    try {
      const result = await checkPublisher(env);
      return Response.json({ ok: true, ...result });
    } catch (error) {
      console.error(error);
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
};
