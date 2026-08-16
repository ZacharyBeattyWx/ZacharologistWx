function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      ...headers
    }
  });
}

function contentTypeFor(path) {
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

async function serveModelData(request, env, url) {
  const prefix = "/model-data/";
  const relative = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/^\/+/, "");

  if (!relative || relative.includes("..") || relative.includes("\\")) {
    return textResponse("Invalid model asset path", 400);
  }

  if (!env.RADAR_BUCKET) {
    return textResponse("Model storage binding unavailable", 503);
  }

  const objectKey = `models/${relative}`;
  const object = await env.RADAR_BUCKET.get(objectKey);

  if (!object) {
    return textResponse("Model asset not found", 404, { "cache-control": "no-store" });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", headers.get("content-type") || contentTypeFor(relative));
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.set("etag", object.httpEtag);
  headers.set(
    "cache-control",
    relative.endsWith("manifest.json")
      ? "public,max-age=30,must-revalidate"
      : "public,max-age=3600"
  );

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return textResponse("", 204);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Method not allowed", 405, {
        "allow": "GET, HEAD, OPTIONS"
      });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith("/model-data/")) {
      return serveModelData(request, env, url);
    }

    return textResponse("Not found", 404);
  }
};
