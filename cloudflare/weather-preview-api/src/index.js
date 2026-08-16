const PREFIX = "/weather-data/current-wx/";

function contentType(key) {
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const key = url.pathname.slice(PREFIX.length);
    if (!key || key.includes("..")) return new Response("Not found", { status: 404 });

    const object = await env.WEATHER_PREVIEWS.get(key);
    if (!object) return new Response("Preview not published yet", {
      status: 404,
      headers: { "Cache-Control": "no-store" }
    });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", headers.get("Content-Type") || contentType(key));
    headers.set("ETag", object.httpEtag);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set(
      "Cache-Control",
      key.endsWith("manifest.json")
        ? "public, max-age=30, stale-while-revalidate=120"
        : "public, max-age=120, stale-while-revalidate=600"
    );

    const response = new Response(request.method === "HEAD" ? null : object.body, { headers });
    if (request.method === "GET") {
      ctx.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  }
};
