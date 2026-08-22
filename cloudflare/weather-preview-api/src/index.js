const PREFIX = "/weather-data/current-wx/";
const NDFD_WMS_PROXY_PATH = `${PREFIX}ndfd-wms`;

async function proxyNdfdWms(request, url, ctx) {
  const layer = String(url.searchParams.get("layer") || "");
  const allowedLayers = new Set([
    "ndfd.conus.maxt",
    "ndfd.conus.mint"
  ]);

  if (!allowedLayers.has(layer)) {
    return new Response("Unsupported NDFD layer", {
      status: 400,
      headers: {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  const bbox = String(url.searchParams.get("bbox") || "");

  if (!bbox || !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(bbox)) {
    return new Response("Invalid bbox", {
      status: 400,
      headers: {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  const seasonRaw = Number(url.searchParams.get("season"));
  const season =
    seasonRaw === -1 || seasonRaw === 1
      ? seasonRaw
      : 0;

  const upstreamParams = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.3.0",
    LAYERS: layer,
    FORMAT: "image/png",
    TRANSPARENT: "TRUE",
    SEASON: String(season),
    EXCEPTIONS: "INIMAGE",
    STYLES: "",
    CRS: "EPSG:3857",
    WIDTH: "256",
    HEIGHT: "256",
    BBOX: bbox
  });

  const upstreamUrl =
    `https://digital.weather.gov/ndfd.conus/wms?${upstreamParams.toString()}`;

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), {
    method: "GET"
  });

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = await fetch(upstreamUrl, {
    headers: {
      "User-Agent":
        "ZacharologistWx/1.0 NDFD Mapbox proxy (zacharologistwx.com)"
    }
  });

  if (!upstream.ok) {
    return new Response(
      `NDFD upstream HTTP ${upstream.status}`,
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }

  const headers = new Headers();
  headers.set("Content-Type", "image/png");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Cache-Control",
    "public, max-age=300, stale-while-revalidate=600"
  );

  const response = new Response(upstream.body, {
    status: 200,
    headers
  });

  ctx.waitUntil(
    cache.put(cacheKey, response.clone())
  );

  return response;
}

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

    if (
      url.pathname === NDFD_WMS_PROXY_PATH &&
      request.method === "GET"
    ) {
      return proxyNdfdWms(request, url, ctx);
    }

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
