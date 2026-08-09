export { LiveAlertHub } from "./live-alert-hub.js";
import { getCachedCpcOutlook } from "./cpc-outlook.js";
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

const CHASE_LOCATION_STALE_MS = 10 * 60 * 1000;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function trueFlag(value) {
  return value === true ||
    value === 1 ||
    value === "1" ||
    String(value).toLowerCase() === "true";
}

function chaseLocationIsStale(updatedAt) {
  if (!updatedAt) return false;

  const updatedTime = Date.parse(updatedAt);
  if (!Number.isFinite(updatedTime)) return false;

  return Date.now() - updatedTime > CHASE_LOCATION_STALE_MS;
}

function publicChaseLocationFromRow(row) {
  const mapDisplay = trueFlag(row.chase_map_display);
  const updatedAt = row.chase_location_updated || null;
  const isStale = chaseLocationIsStale(updatedAt);

  if (!mapDisplay) {
    return {
      mapDisplay: false,
      status: "off",
      updatedAt,
      isStale
    };
  }

  const lat = finiteNumber(row.chase_lat);
  const lon = finiteNumber(row.chase_lon);

  if (lat === null || lon === null) {
    return {
      mapDisplay: false,
      status: "off",
      updatedAt,
      isStale
    };
  }

  return {
    mapDisplay: true,
    status: isStale ? "stale" : "live",
    lat,
    lon,
    accuracy: finiteNumber(row.chase_accuracy),
    heading: finiteNumber(row.chase_heading),
    speed: finiteNumber(row.chase_speed),
    updatedAt,
    isStale
  };
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
    chaseLocation: publicChaseLocationFromRow(row),
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
    expiresAt: now + 15000,
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


const OPS_CACHE_TTL_SECONDS = 120;

const SPC_MAP_SERVICE =
  "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer";

const SPC_REPORT_SOURCES = [
  {
    type: "tornado",
    url: "https://www.spc.noaa.gov/climo/reports/today_filtered_torn.csv"
  },
  {
    type: "hail",
    url: "https://www.spc.noaa.gov/climo/reports/today_filtered_hail.csv"
  },
  {
    type: "wind",
    url: "https://www.spc.noaa.gov/climo/reports/today_filtered_wind.csv"
  }
];

const NWS_ACTIVE_ALERTS_URL =
  "https://api.weather.gov/alerts/active?status=actual";

const AWC_METAR_URL =
  "https://aviationweather.gov/api/data/metar?ids=KGSO&format=json";

const NWS_HEADERS = {
  "accept": "application/geo+json, application/json",
  "user-agent": "ZacharologistWx Operations Desk (https://zacharologistwx.com)"
};

function opsJsonResponse(data, status = 200, ttlSeconds = OPS_CACHE_TTL_SECONDS) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "cache-control": `public, max-age=${ttlSeconds}`
    }
  });
}

function cleanOpsText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"') {
      if (quoted && nextCharacter === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }

      row.push(cell.trim());

      if (row.some((value) => value !== "")) {
        rows.push(row);
      }

      row = [];
      cell = "";
      continue;
    }

    cell += character;
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell.trim());

    if (row.some((value) => value !== "")) {
      rows.push(row);
    }
  }

  return rows;
}

function normalizeCsvHeader(value) {
  return cleanOpsText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findCsvColumn(headers, possibleNames) {
  return headers.findIndex((header) =>
    possibleNames.includes(normalizeCsvHeader(header))
  );
}

function csvCell(row, index) {
  return index >= 0 ? cleanOpsText(row[index]) : "";
}

function formatSpcTime(value) {
  const digits = String(value || "").replace(/\D/g, "").padStart(4, "0").slice(-4);

  if (!digits || digits === "0000") return "Time unavailable";

  return `${digits.slice(0, 2)}:${digits.slice(2)}Z`;
}

function spcSortValue(value) {
  const digits = String(value || "").replace(/\D/g, "").padStart(4, "0").slice(-4);
  const hour = Number(digits.slice(0, 2));
  const minute = Number(digits.slice(2));

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return -1;

  const time = hour * 100 + minute;

  // SPC report days run 12Z to 1159Z the following day.
  return hour < 12 ? time + 2400 : time;
}

function formatHailSize(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return "Hail report";
  }

  const inches = amount > 10 ? amount / 100 : amount;

  return `${inches.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}" hail`;
}

function parseSpcReportCsv(text, type) {
  const rows = parseCsv(text);

  if (rows.length < 2) return [];

  const headers = rows[0];
  const timeIndex = findCsvColumn(headers, ["time"]);
  const locationIndex = findCsvColumn(headers, ["location"]);
  const countyIndex = findCsvColumn(headers, ["county"]);
  const stateIndex = findCsvColumn(headers, ["state"]);
  const commentsIndex = findCsvColumn(headers, ["comments", "comment"]);
  const sizeIndex = findCsvColumn(headers, ["size"]);
  const speedIndex = findCsvColumn(headers, ["speed"]);
  const scaleIndex = findCsvColumn(headers, ["fscale", "scale"]);

  if (timeIndex < 0) return [];

  return rows
    .slice(1)
    .map((row) => {
      const rawTime = csvCell(row, timeIndex);

      if (!rawTime) return null;

      const location = csvCell(row, locationIndex);
      const county = csvCell(row, countyIndex);
      const state = csvCell(row, stateIndex);
      const comments = csvCell(row, commentsIndex);

      let magnitude = "";

      if (type === "hail") {
        magnitude = formatHailSize(csvCell(row, sizeIndex));
      } else if (type === "wind") {
        const speed = Number(csvCell(row, speedIndex));
        magnitude = Number.isFinite(speed) && speed > 0
          ? `${Math.round(speed)} mph wind`
          : "Wind report";
      } else {
        const scale = csvCell(row, scaleIndex);
        magnitude = scale ? `${scale} tornado` : "Tornado report";
      }

      return {
        type,
        timeUtc: formatSpcTime(rawTime),
        sortValue: spcSortValue(rawTime),
        magnitude,
        location: [location, state].filter(Boolean).join(", ") ||
          [county, state].filter(Boolean).join(", ") ||
          "Location unavailable",
        county,
        state,
        comments
      };
    })
    .filter(Boolean);
}

async function fetchJsonOrThrow(url, headers = {}) {
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Source request failed: ${response.status}`);
  }

  return response.json();
}

async function fetchTextOrThrow(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Source request failed: ${response.status}`);
  }

  return response.text();
}

function spcLayerUrl(layerId) {
  const url = new URL(`${SPC_MAP_SERVICE}/${layerId}/query`);

  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "dn,label,valid,issue,expire");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");

  return url.toString();
}

function spcFeatures(payload) {
  return Array.isArray(payload?.features) ? payload.features : [];
}

function maxSpcProbability(payload) {
  const features = spcFeatures(payload);

  const probabilities = features
    .map((feature) => Number(feature?.attributes?.dn))
    .filter((value) => Number.isFinite(value));

  const strongestFeature = features
    .slice()
    .sort((a, b) =>
      Number(b?.attributes?.dn || 0) - Number(a?.attributes?.dn || 0)
    )[0];

  return {
    percent: probabilities.length ? Math.max(...probabilities) : null,
    valid: cleanOpsText(strongestFeature?.attributes?.valid),
    issued: cleanOpsText(strongestFeature?.attributes?.issue),
    expires: cleanOpsText(strongestFeature?.attributes?.expire)
  };
}

function highestCategoricalRisk(payload) {
  const riskLevels = [
    { match: /HIGH/, rank: 5, label: "High" },
    { match: /MDT|MODERATE/, rank: 4, label: "Moderate" },
    { match: /ENH|ENHANCED/, rank: 3, label: "Enhanced" },
    { match: /SLGT|SLIGHT/, rank: 2, label: "Slight" },
    { match: /MRGL|MARGINAL/, rank: 1, label: "Marginal" },
    { match: /TSTM|THUNDERSTORM/, rank: 0, label: "General thunderstorms" }
  ];

  let strongest = {
    rank: -1,
    label: "No severe risk",
    valid: "",
    issued: "",
    expires: ""
  };

  for (const feature of spcFeatures(payload)) {
    const attributes = feature?.attributes || {};
    const sourceLabel = cleanOpsText(attributes.label).toUpperCase();

    const matched = riskLevels.find((risk) => risk.match.test(sourceLabel));

    if (!matched || matched.rank <= strongest.rank) continue;

    strongest = {
      rank: matched.rank,
      label: matched.label,
      valid: cleanOpsText(attributes.valid),
      issued: cleanOpsText(attributes.issue),
      expires: cleanOpsText(attributes.expire)
    };
  }

  return strongest;
}

function countAlertEvents(features, predicate) {
  const totals = new Map();

  for (const feature of features) {
    const event = cleanOpsText(feature?.properties?.event);

    if (!event || !predicate(event, feature?.properties || {})) continue;

    totals.set(event, (totals.get(event) || 0) + 1);
  }

  return [...totals.entries()]
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event));
}

function nwsStateCountsFromFeatures(features) {
  const validStates = new Set([
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC", "PR", "VI", "GU", "AS", "MP"
  ]);

  const counts = new Map();

  for (const feature of features) {
    const properties = feature?.properties || {};
    const geocode = properties.geocode || {};
    const ugcValues = Array.isArray(geocode.UGC) ? geocode.UGC : [];
    const states = new Set();

    for (const ugc of ugcValues) {
      const match = String(ugc || "").toUpperCase().match(/^([A-Z]{2})[CZ]\d{3}$/);

      if (match && validStates.has(match[1])) {
        states.add(match[1]);
      }
    }

    for (const state of states) {
      counts.set(state, (counts.get(state) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state))
    .slice(0, 12);
}

function summarizeNwsAlerts(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];

  const watches = countAlertEvents(
    features,
    (event) => /\bwatch$/i.test(event)
  );

  const fireWeather = countAlertEvents(
    features,
    (event) => event === "Red Flag Warning" || event === "Fire Weather Watch"
  );

  const eventTotals = countAlertEvents(
    features,
    () => true
  ).slice(0, 10);

  return {
    activeCount: features.length,
    watches,
    fireWeather,
    eventTotals,
    topStates: nwsStateCountsFromFeatures(features),
    updatedAt: new Date().toISOString()
  };
}

function settledValue(result, fallback) {
  return result?.status === "fulfilled" ? result.value : fallback;
}

function settledOkay(result) {
  return result?.status === "fulfilled";
}

function normalizeMetar(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];

  const row = rows[0] || {};

  function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function celsiusToFahrenheit(value) {
    const celsius = numberOrNull(value);
    return celsius === null ? null : Math.round((celsius * 9 / 5) + 32);
  }

  const windDirection = numberOrNull(row.wdir ?? row.windDir);
  const windSpeed = numberOrNull(row.wspd ?? row.windSpeed);
  const visibility = numberOrNull(row.visib ?? row.visibility);
  const altimeter = numberOrNull(row.altim ?? row.altimeter);

  return {
    station: cleanOpsText(row.icaoId || row.icao || "KGSO"),
    flightCategory: cleanOpsText(row.fltCat || row.flightCategory || "OBS"),
    temperatureF: celsiusToFahrenheit(row.temp ?? row.temperature),
    dewPointF: celsiusToFahrenheit(row.dewp ?? row.dewpoint),
    windDirection,
    windSpeed,
    visibilityMiles: visibility,
    altimeterInHg: altimeter,
    rawText: cleanOpsText(row.rawOb || row.raw_text || ""),
    observedAt: cleanOpsText(row.obsTime || row.observationTime || "")
  };
}

function currentSpcReportDay() {
  // SPC report days run from 1200 UTC to 1159 UTC the following day.
  const spcDay = new Date(Date.now() - (12 * 60 * 60 * 1000));
  const year = spcDay.getUTCFullYear();
  const month = String(spcDay.getUTCMonth() + 1).padStart(2, "0");
  const day = String(spcDay.getUTCDate()).padStart(2, "0");

  return {
    dayKey: `${year}-${month}-${day}`,
    monthKey: `${year}-${month}`,
    monthLabel: new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC"
    }).format(spcDay)
  };
}

async function persistAndReadSpcReportCounts(env, spcDay, dailyCounts) {
  const fallbackCounts = Object.fromEntries(
    Object.entries(dailyCounts).map(([type, item]) => [
      type,
      item.available ? Number(item.count || 0) : null
    ])
  );

  const fallback = {
    available: false,
    counts: fallbackCounts,
    days: {}
  };

  if (!env?.DB) {
    return fallback;
  }

  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS spc_report_daily_counts (
        report_day TEXT NOT NULL,
        report_month TEXT NOT NULL,
        report_type TEXT NOT NULL,
        report_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (report_day, report_type)
      )
    `).run();

    const updatedAt = new Date().toISOString();
    const upserts = Object.entries(dailyCounts)
      .filter(([, item]) => item.available)
      .map(([type, item]) =>
        env.DB.prepare(`
          INSERT INTO spc_report_daily_counts (
            report_day,
            report_month,
            report_type,
            report_count,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(report_day, report_type) DO UPDATE SET
            report_month = excluded.report_month,
            report_count = excluded.report_count,
            updated_at = excluded.updated_at
        `).bind(
          spcDay.dayKey,
          spcDay.monthKey,
          type,
          Math.max(0, Math.round(Number(item.count || 0))),
          updatedAt
        )
      );

    if (upserts.length) {
      await env.DB.batch(upserts);
    }

    const monthlyResult = await env.DB.prepare(`
      SELECT
        report_type,
        SUM(report_count) AS report_count,
        COUNT(DISTINCT report_day) AS report_days
      FROM spc_report_daily_counts
      WHERE report_month = ?
      GROUP BY report_type
    `).bind(spcDay.monthKey).all();

    const counts = {
      tornado: 0,
      hail: 0,
      wind: 0
    };

    const days = {
      tornado: 0,
      hail: 0,
      wind: 0
    };

    for (const row of monthlyResult?.results || []) {
      const type = String(row?.report_type || "");

      if (!(type in counts)) continue;

      counts[type] = Math.max(0, Number(row?.report_count || 0));
      days[type] = Math.max(0, Number(row?.report_days || 0));
    }

    return {
      available: true,
      counts,
      days
    };
  } catch (error) {
    console.warn("Unable to store SPC monthly report counts:", error);
    return fallback;
  }
}

async function buildOpsSummary(env) {
  const spcReportDay = currentSpcReportDay();

  const tasks = [
    ["category", fetchJsonOrThrow(spcLayerUrl(1))],
    ["tornadoProbability", fetchJsonOrThrow(spcLayerUrl(3))],
    ["hailProbability", fetchJsonOrThrow(spcLayerUrl(5))],
    ["windProbability", fetchJsonOrThrow(spcLayerUrl(7))],
    ["nwsAlerts", fetchJsonOrThrow(NWS_ACTIVE_ALERTS_URL, NWS_HEADERS)],
    ["tornadoReports", fetchTextOrThrow(SPC_REPORT_SOURCES[0].url)],
    ["hailReports", fetchTextOrThrow(SPC_REPORT_SOURCES[1].url)],
    ["windReports", fetchTextOrThrow(SPC_REPORT_SOURCES[2].url)],
    ["metar", fetchJsonOrThrow(AWC_METAR_URL)]
  ];

  const settled = await Promise.allSettled(tasks.map(([, task]) => task));

  const results = Object.fromEntries(
    tasks.map(([key], index) => [key, settled[index]])
  );

  const tornadoReportRows = parseSpcReportCsv(
    settledValue(results.tornadoReports, ""),
    "tornado"
  );

  const hailReportRows = parseSpcReportCsv(
    settledValue(results.hailReports, ""),
    "hail"
  );

  const windReportRows = parseSpcReportCsv(
    settledValue(results.windReports, ""),
    "wind"
  );

  const monthlyReportCounts = await persistAndReadSpcReportCounts(
    env,
    spcReportDay,
    {
      tornado: {
        available: settledOkay(results.tornadoReports),
        count: tornadoReportRows.length
      },
      hail: {
        available: settledOkay(results.hailReports),
        count: hailReportRows.length
      },
      wind: {
        available: settledOkay(results.windReports),
        count: windReportRows.length
      }
    }
  );

  const reports = [
    ...tornadoReportRows,
    ...hailReportRows,
    ...windReportRows
  ]
    .sort((a, b) => b.sortValue - a.sortValue)
    .slice(0, 6)
    .map(({ sortValue, ...report }) => report);

  return {
    generatedAt: new Date().toISOString(),
    cacheTtlSeconds: OPS_CACHE_TTL_SECONDS,

    availability: {
      spcOutlooks: [
        "category",
        "tornadoProbability",
        "hailProbability",
        "windProbability"
      ].every((key) => settledOkay(results[key])),
      stormReports: [
        "tornadoReports",
        "hailReports",
        "windReports"
      ].every((key) => settledOkay(results[key])),
      nwsAlerts: settledOkay(results.nwsAlerts),
      metar: settledOkay(results.metar)
    },

    severeRisk: highestCategoricalRisk(
      settledValue(results.category, {})
    ),

    spcThreats: {
      tornado: maxSpcProbability(
        settledValue(results.tornadoProbability, {})
      ),
      hail: maxSpcProbability(
        settledValue(results.hailProbability, {})
      ),
      wind: maxSpcProbability(
        settledValue(results.windProbability, {})
      )
    },

    stormReports: {
      preliminary: true,
      count:
        tornadoReportRows.length +
        hailReportRows.length +
        windReportRows.length,
      counts: {
        tornado: tornadoReportRows.length,
        hail: hailReportRows.length,
        wind: windReportRows.length
      },
      reports
    },

    tornadoCount: {
      preliminary: true,
      available: monthlyReportCounts.available,
      count: monthlyReportCounts.counts.tornado,
      monthCount: monthlyReportCounts.counts.tornado,
      dailyAvailable: settledOkay(results.tornadoReports),
      dailyCount: tornadoReportRows.length,
      monthLabel: spcReportDay.monthLabel,
      reportDayKey: spcReportDay.dayKey,
      includedSpcDays: monthlyReportCounts.days.tornado || 0,
      trackerUrl: "https://www.spc.noaa.gov/climo/reports/today.html"
    },

    hailCount: {
      preliminary: true,
      dailyAvailable: settledOkay(results.hailReports),
      dailyCount: hailReportRows.length,
      monthlyAvailable: monthlyReportCounts.available,
      monthCount: monthlyReportCounts.counts.hail,
      monthLabel: spcReportDay.monthLabel,
      reportDayKey: spcReportDay.dayKey,
      includedSpcDays: monthlyReportCounts.days.hail || 0,
      trackerUrl: "https://www.spc.noaa.gov/climo/reports/today.html"
    },

    windCount: {
      preliminary: true,
      dailyAvailable: settledOkay(results.windReports),
      dailyCount: windReportRows.length,
      monthlyAvailable: monthlyReportCounts.available,
      monthCount: monthlyReportCounts.counts.wind,
      monthLabel: spcReportDay.monthLabel,
      reportDayKey: spcReportDay.dayKey,
      includedSpcDays: monthlyReportCounts.days.wind || 0,
      trackerUrl: "https://www.spc.noaa.gov/climo/reports/today.html"
    },

    metar: normalizeMetar(settledValue(results.metar, [])),

    alerts: summarizeNwsAlerts(
      settledValue(results.nwsAlerts, {})
    )
  };
}


// zacharologist-storm-report-explorer-v1

const STORM_REPORTS_FINAL_MAX_YEAR = 2024;
const STORM_REPORTS_PRELIMINARY_MIN_YEAR = 1999;
const STORM_REPORTS_CACHE_SECONDS_CURRENT = 900;
const STORM_REPORTS_CACHE_SECONDS_ARCHIVE = 21600;
const STORM_REPORTS_CACHE_SECONDS_FINAL = 86400;
const STORM_REPORTS_VALID_HAZARDS = new Set(["tornado", "hail", "wind"]);

function stormReportsInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function stormReportsCurrentSpcDate() {
  return new Date(Date.now() - (12 * 60 * 60 * 1000));
}

function stormReportsDateKey(year, month, day) {
  return [
    String(year).slice(-2),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("");
}

function stormReportsIsoDate(year, month, day) {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function stormReportsDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function stormReportsPreliminaryDays(year, month) {
  if (
    year < STORM_REPORTS_PRELIMINARY_MIN_YEAR ||
    month < 1 ||
    month > 12
  ) {
    return [];
  }

  if (year === 1999 && month < 6) {
    return [];
  }

  const current = stormReportsCurrentSpcDate();
  const currentYear = current.getUTCFullYear();
  const currentMonth = current.getUTCMonth() + 1;
  const currentDay = current.getUTCDate();

  if (
    year > currentYear ||
    (year === currentYear && month > currentMonth)
  ) {
    return [];
  }

  let lastDay = stormReportsDaysInMonth(year, month);

  if (year === currentYear && month === currentMonth) {
    lastDay = Math.min(lastDay, currentDay);
  }

  const firstDay = year === 1999 && month === 6 ? 1 : 1;

  return Array.from(
    { length: Math.max(0, lastDay - firstDay + 1) },
    (_, index) => firstDay + index
  );
}

function stormReportsCoordinate(value, longitude = false) {
  const cleaned = String(value ?? "")
    .replace(/[^\d.+-]/g, "")
    .trim();

  if (!cleaned) return null;

  let number = Number(cleaned);

  if (!Number.isFinite(number)) return null;

  const limit = longitude ? 180 : 90;

  while (Math.abs(number) > limit && Math.abs(number) >= 100) {
    number /= 100;
  }

  if (longitude && number > 0 && number >= 60) {
    number *= -1;
  }

  return Math.abs(number) <= limit ? number : null;
}

function stormReportsTimeParts(value) {
  const digits = String(value ?? "")
    .replace(/\D/g, "")
    .padStart(4, "0")
    .slice(-4);

  const hour = Number(digits.slice(0, 2));
  const minute = Number(digits.slice(2));

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour > 23 ||
    minute > 59
  ) {
    return {
      raw: cleanOpsText(value),
      hour: null,
      minute: null,
      label: cleanOpsText(value) || "Time unavailable"
    };
  }

  return {
    raw: digits,
    hour,
    minute,
    label: `${digits.slice(0, 2)}:${digits.slice(2)}Z`
  };
}

function stormReportsDateTimeUtc(year, month, day, rawTime, spcDay = false) {
  const time = stormReportsTimeParts(rawTime);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (spcDay && time.hour !== null && time.hour < 12) {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  date.setUTCHours(time.hour ?? 0, time.minute ?? 0, 0, 0);
  return date.toISOString();
}

function stormReportsCsvIndex(headers, aliases) {
  return findCsvColumn(headers, aliases);
}

function stormReportsMagnitude(hazard, rawValue, dataset) {
  const raw = cleanOpsText(rawValue);

  if (hazard === "hail") {
    const amount = Number(raw);

    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        label: "Hail report",
        value: null,
        significant: false
      };
    }

    const inches = amount > 10 ? amount / 100 : amount;

    return {
      label: `${inches
        .toFixed(2)
        .replace(/\.00$/, "")
        .replace(/(\.\d)0$/, "$1")}" hail`,
      value: inches,
      significant: inches >= 2
    };
  }

  if (hazard === "wind") {
    const speed = Number(raw);

    if (!Number.isFinite(speed) || speed <= 0) {
      return {
        label: "Wind damage",
        value: null,
        significant: false
      };
    }

    if (dataset === "final") {
      return {
        label: `${Math.round(speed)} kt wind`,
        value: speed,
        significant: speed >= 65
      };
    }

    return {
      label: `${Math.round(speed)} mph wind`,
      value: speed,
      significant: speed >= 75
    };
  }

  const scaleMatch = raw.toUpperCase().match(/(?:EF|F)?([0-5])/);
  const scaleNumber = scaleMatch ? Number(scaleMatch[1]) : null;
  const scaleLabel = scaleMatch
    ? `${dataset === "final" ? "F/EF" : "EF/F"}${scaleMatch[1]} tornado`
    : "Tornado report";

  return {
    label: scaleLabel,
    value: scaleNumber,
    significant: Number.isFinite(scaleNumber) && scaleNumber >= 2
  };
}

function stormReportsPreliminaryUrl(key, hazard) {
  const suffix = {
    tornado: "torn",
    hail: "hail",
    wind: "wind"
  }[hazard];

  return (
    "https://www.spc.noaa.gov/climo/reports/" +
    `${key}_rpts_filtered_${suffix}.csv`
  );
}

async function stormReportsFetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "text/csv,text/plain,*/*",
      "user-agent":
        "ZacharologistWx Storm Report Explorer (https://zacharologistwx.com)"
    }
  });

  if (response.status === 404) {
    return "";
  }

  if (!response.ok) {
    throw new Error(`SPC source returned HTTP ${response.status}`);
  }

  return response.text();
}

function stormReportsParsePreliminaryCsv(
  text,
  hazard,
  year,
  month,
  day,
  sourceUrl
) {
  const rows = parseCsv(text);

  if (rows.length < 2) return [];

  const headers = rows[0];
  const timeIndex = stormReportsCsvIndex(headers, ["time"]);
  const scaleIndex = stormReportsCsvIndex(headers, ["fscale", "scale"]);
  const sizeIndex = stormReportsCsvIndex(headers, ["size"]);
  const speedIndex = stormReportsCsvIndex(headers, ["speed"]);
  const locationIndex = stormReportsCsvIndex(headers, ["location"]);
  const countyIndex = stormReportsCsvIndex(headers, ["county"]);
  const stateIndex = stormReportsCsvIndex(headers, ["state"]);
  const latIndex = stormReportsCsvIndex(headers, ["lat", "latitude"]);
  const lonIndex = stormReportsCsvIndex(headers, ["lon", "longitude"]);
  const commentsIndex = stormReportsCsvIndex(
    headers,
    ["comments", "comment", "remarks"]
  );

  if (timeIndex < 0) return [];

  const reportDay = stormReportsIsoDate(year, month, day);
  const dateKey = stormReportsDateKey(year, month, day);

  return rows
    .slice(1)
    .map((row, index) => {
      const rawTime = csvCell(row, timeIndex);

      if (!rawTime) return null;

      const magnitudeRaw = hazard === "hail"
        ? csvCell(row, sizeIndex)
        : hazard === "wind"
          ? csvCell(row, speedIndex)
          : csvCell(row, scaleIndex);

      const magnitude = stormReportsMagnitude(
        hazard,
        magnitudeRaw,
        "preliminary"
      );

      const comments = csvCell(row, commentsIndex);
      const tornadoCommentMatch = hazard === "tornado"
        ? comments.toUpperCase().match(/\bEF([0-5])\b/)
        : null;

      const commentScale = tornadoCommentMatch
        ? Number(tornadoCommentMatch[1])
        : null;

      const significant =
        magnitude.significant ||
        (Number.isFinite(commentScale) && commentScale >= 2);

      const time = stormReportsTimeParts(rawTime);
      const lat = stormReportsCoordinate(csvCell(row, latIndex));
      const lon = stormReportsCoordinate(csvCell(row, lonIndex), true);

      return {
        id: [
          "preliminary",
          hazard,
          dateKey,
          time.raw || index,
          lat ?? "x",
          lon ?? "x",
          index
        ].join("-"),
        dataset: "preliminary",
        hazard,
        reportDay,
        eventDate: stormReportsDateTimeUtc(
          year,
          month,
          day,
          rawTime,
          true
        ).slice(0, 10),
        dateTimeUtc: stormReportsDateTimeUtc(
          year,
          month,
          day,
          rawTime,
          true
        ),
        timeRaw: time.raw,
        timeLabel: time.label,
        magnitude: tornadoCommentMatch && !magnitude.value
          ? `EF${tornadoCommentMatch[1]} tornado`
          : magnitude.label,
        magnitudeValue: tornadoCommentMatch && !magnitude.value
          ? Number(tornadoCommentMatch[1])
          : magnitude.value,
        significant,
        location: csvCell(row, locationIndex) || "Location unavailable",
        county: csvCell(row, countyIndex),
        state: csvCell(row, stateIndex).toUpperCase(),
        lat,
        lon,
        comments,
        sourceUrl
      };
    })
    .filter(Boolean);
}

function stormReportsFinalSource(year, hazard) {
  const suffix = {
    tornado: "torn",
    hail: "hail",
    wind: "wind"
  }[hazard];

  if (!suffix) return null;

  if (hazard !== "tornado" && year < 1955) {
    return null;
  }

  let fileName = "";

  if (year >= 2008 && year <= STORM_REPORTS_FINAL_MAX_YEAR) {
    fileName = `${year}_${suffix}.csv`;
  } else if (year >= 2005 && year <= 2007) {
    fileName = `2005-2007_${suffix}.csv`;
  } else if (year >= 2000 && year <= 2004) {
    fileName = `2000-2004_${suffix}.csv`;
  } else if (year >= 1990 && year <= 1999) {
    fileName = `90-99_${suffix}.csv`;
  } else if (year >= 1980 && year <= 1989) {
    fileName = `80-89_${suffix}.csv`;
  } else if (year >= 1970 && year <= 1979) {
    fileName = `70-79_${suffix}.csv`;
  } else if (year >= 1960 && year <= 1969) {
    fileName = `60-69_${suffix}.csv`;
  } else if (year >= 1950 && year <= 1959) {
    fileName = hazard === "tornado"
      ? `50-59_${suffix}.csv`
      : `55-59_${suffix}.csv`;
  }

  return fileName
    ? `https://www.spc.noaa.gov/wcm/data/${fileName}`
    : null;
}

function stormReportsParseDateField(value) {
  const text = cleanOpsText(value);

  if (!text) return null;

  const parts = text.match(
    /^(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})|(\d{1,2})[-/](\d{1,2})[-/](\d{2,4}))$/
  );

  if (!parts) return null;

  if (parts[1]) {
    return {
      year: Number(parts[1]),
      month: Number(parts[2]),
      day: Number(parts[3])
    };
  }

  const parsedYear = Number(parts[6]);

  return {
    year: parsedYear < 100 ? 2000 + parsedYear : parsedYear,
    month: Number(parts[4]),
    day: Number(parts[5])
  };
}

function stormReportsParseFinalCsv(
  text,
  hazard,
  requestedYear,
  requestedMonth,
  sourceUrl
) {
  const rows = parseCsv(text);

  if (rows.length < 2) return [];

  const headers = rows[0];
  const yearIndex = stormReportsCsvIndex(headers, ["yr", "year"]);
  const monthIndex = stormReportsCsvIndex(headers, ["mo", "month"]);
  const dayIndex = stormReportsCsvIndex(headers, ["dy", "day"]);
  const dateIndex = stormReportsCsvIndex(headers, ["date", "begindate"]);
  const timeIndex = stormReportsCsvIndex(
    headers,
    ["time", "begintime", "bgntime"]
  );
  const stateIndex = stormReportsCsvIndex(headers, ["st", "state"]);
  const magnitudeIndex = stormReportsCsvIndex(
    headers,
    ["mag", "magnitude", "fscale"]
  );
  const latIndex = stormReportsCsvIndex(
    headers,
    ["slat", "beginlat", "lat", "latitude"]
  );
  const lonIndex = stormReportsCsvIndex(
    headers,
    ["slon", "beginlon", "lon", "longitude"]
  );
  const endLatIndex = stormReportsCsvIndex(headers, ["elat", "endlat"]);
  const endLonIndex = stormReportsCsvIndex(headers, ["elon", "endlon"]);
  const countyIndex = stormReportsCsvIndex(
    headers,
    ["county", "czname", "f1"]
  );
  const locationIndex = stormReportsCsvIndex(
    headers,
    ["location", "beglocation", "stn"]
  );
  const injuriesIndex = stormReportsCsvIndex(
    headers,
    ["inj", "injuriesdirect"]
  );
  const fatalitiesIndex = stormReportsCsvIndex(
    headers,
    ["fat", "deaths", "deathsdirect"]
  );

  return rows
    .slice(1)
    .map((row, index) => {
      const parsedDate = stormReportsParseDateField(csvCell(row, dateIndex));

      const year = yearIndex >= 0
        ? Number(csvCell(row, yearIndex))
        : parsedDate?.year;
      const month = monthIndex >= 0
        ? Number(csvCell(row, monthIndex))
        : parsedDate?.month;
      const day = dayIndex >= 0
        ? Number(csvCell(row, dayIndex))
        : parsedDate?.day;

      if (
        year !== requestedYear ||
        month !== requestedMonth ||
        !Number.isInteger(day)
      ) {
        return null;
      }

      const rawTime = csvCell(row, timeIndex);
      const time = stormReportsTimeParts(rawTime);
      const magnitude = stormReportsMagnitude(
        hazard,
        csvCell(row, magnitudeIndex),
        "final"
      );
      const lat = stormReportsCoordinate(csvCell(row, latIndex));
      const lon = stormReportsCoordinate(csvCell(row, lonIndex), true);
      const endLat = stormReportsCoordinate(csvCell(row, endLatIndex));
      const endLon = stormReportsCoordinate(
        csvCell(row, endLonIndex),
        true
      );
      const injuries = Number(csvCell(row, injuriesIndex));
      const fatalities = Number(csvCell(row, fatalitiesIndex));
      const comments = [
        Number.isFinite(injuries) && injuries > 0
          ? `${injuries} injuries`
          : "",
        Number.isFinite(fatalities) && fatalities > 0
          ? `${fatalities} fatalities`
          : ""
      ].filter(Boolean).join(" • ");

      const eventDate = stormReportsIsoDate(year, month, day);
      const dateTimeUtc = stormReportsDateTimeUtc(
        year,
        month,
        day,
        rawTime,
        false
      );

      return {
        id: [
          "final",
          hazard,
          requestedYear,
          requestedMonth,
          day,
          time.raw || index,
          lat ?? "x",
          lon ?? "x",
          index
        ].join("-"),
        dataset: "final",
        hazard,
        reportDay: eventDate,
        eventDate,
        dateTimeUtc,
        timeRaw: time.raw,
        timeLabel: time.label.replace(/Z$/, ""),
        magnitude: magnitude.label,
        magnitudeValue: magnitude.value,
        significant: magnitude.significant,
        location: csvCell(row, locationIndex) || "Storm Data event",
        county: csvCell(row, countyIndex),
        state: csvCell(row, stateIndex).toUpperCase(),
        lat,
        lon,
        endLat,
        endLon,
        comments,
        sourceUrl
      };
    })
    .filter(Boolean);
}

async function stormReportsBuildPreliminary(year, month, hazard) {
  const days = stormReportsPreliminaryDays(year, month);

  const dayResults = await mapWithConcurrency(
    days,
    6,
    async (day) => {
      const key = stormReportsDateKey(year, month, day);
      const sourceUrl = stormReportsPreliminaryUrl(key, hazard);

      try {
        const text = await stormReportsFetchText(sourceUrl);

        return {
          day,
          reports: stormReportsParsePreliminaryCsv(
            text,
            hazard,
            year,
            month,
            day,
            sourceUrl
          ),
          error: ""
        };
      } catch (error) {
        return {
          day,
          reports: [],
          error: String(error?.message || error)
        };
      }
    }
  );

  return {
    reports: dayResults.flatMap((result) => result.reports),
    partialFailures: dayResults
      .filter((result) => result.error)
      .map((result) => ({
        day: result.day,
        error: result.error
      })),
    source:
      "https://www.spc.noaa.gov/climo/reports/YYMMDD_rpts_filtered_HAZARD.csv"
  };
}

async function stormReportsBuildFinal(year, month, hazard) {
  if (year > STORM_REPORTS_FINAL_MAX_YEAR) {
    throw new Error(
      `Final SPC Storm Data are available through ${STORM_REPORTS_FINAL_MAX_YEAR}`
    );
  }

  const sourceUrl = stormReportsFinalSource(year, hazard);

  if (!sourceUrl) {
    return {
      reports: [],
      partialFailures: [],
      source: ""
    };
  }

  const text = await stormReportsFetchText(sourceUrl);

  return {
    reports: stormReportsParseFinalCsv(
      text,
      hazard,
      year,
      month,
      sourceUrl
    ),
    partialFailures: [],
    source: sourceUrl
  };
}

function stormReportsCacheTtl(year, month, dataset) {
  if (dataset === "final") {
    return STORM_REPORTS_CACHE_SECONDS_FINAL;
  }

  const current = stormReportsCurrentSpcDate();
  const isCurrent =
    current.getUTCFullYear() === year &&
    current.getUTCMonth() + 1 === month;

  return isCurrent
    ? STORM_REPORTS_CACHE_SECONDS_CURRENT
    : STORM_REPORTS_CACHE_SECONDS_ARCHIVE;
}

async function getCachedStormReports(request) {
  const requestUrl = new URL(request.url);
  const currentYear = stormReportsCurrentSpcDate().getUTCFullYear();
  const year = stormReportsInteger(
    requestUrl.searchParams.get("year"),
    currentYear
  );
  const month = stormReportsInteger(
    requestUrl.searchParams.get("month"),
    stormReportsCurrentSpcDate().getUTCMonth() + 1
  );
  const hazard = cleanOpsText(
    requestUrl.searchParams.get("hazard")
  ).toLowerCase();
  const dataset = cleanOpsText(
    requestUrl.searchParams.get("dataset") || "preliminary"
  ).toLowerCase();

  if (
    !STORM_REPORTS_VALID_HAZARDS.has(hazard) ||
    !["preliminary", "final"].includes(dataset) ||
    month < 1 ||
    month > 12 ||
    year < 1950 ||
    year > currentYear
  ) {
    return opsJsonResponse(
      {
        error: "Invalid storm-report query",
        allowedHazards: [...STORM_REPORTS_VALID_HAZARDS],
        allowedDatasets: ["preliminary", "final"],
        finalMaxYear: STORM_REPORTS_FINAL_MAX_YEAR
      },
      400,
      60
    );
  }

  if (
    dataset === "preliminary" &&
    year < STORM_REPORTS_PRELIMINARY_MIN_YEAR
  ) {
    return opsJsonResponse(
      {
        error: "SPC preliminary daily archives begin in 1999",
        finalMaxYear: STORM_REPORTS_FINAL_MAX_YEAR
      },
      400,
      60
    );
  }

  const cache = caches.default;
  const normalizedUrl = new URL("/api/storm-reports", request.url);
  normalizedUrl.searchParams.set("year", String(year));
  normalizedUrl.searchParams.set("month", String(month));
  normalizedUrl.searchParams.set("hazard", hazard);
  normalizedUrl.searchParams.set("dataset", dataset);

  const cacheKey = new Request(normalizedUrl.toString(), {
    method: "GET"
  });

  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached;
  }

  const built = dataset === "final"
    ? await stormReportsBuildFinal(year, month, hazard)
    : await stormReportsBuildPreliminary(year, month, hazard);

  const ttl = stormReportsCacheTtl(year, month, dataset);
  const response = opsJsonResponse(
    {
      generatedAt: new Date().toISOString(),
      dataset,
      year,
      month,
      hazard,
      count: built.reports.length,
      reports: built.reports,
      source: built.source,
      partialFailures: built.partialFailures,
      finalMaxYear: STORM_REPORTS_FINAL_MAX_YEAR,
      preliminaryMinYear: STORM_REPORTS_PRELIMINARY_MIN_YEAR
    },
    200,
    ttl
  );

  try {
    await cache.put(cacheKey, response.clone());
  } catch (error) {
    console.warn("Unable to cache storm-report response:", error);
  }

  return response;
}


async function getCachedOpsSummary(request, env) {
  const cache = caches.default;

  const cacheKey = new Request(
    new URL("/api/ops/summary", request.url).toString(),
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached;
  }

  const summary = await buildOpsSummary(env);
  const response = opsJsonResponse(summary);

  try {
    await cache.put(cacheKey, response.clone());
  } catch (error) {
    console.warn("Unable to cache operations summary:", error);
  }

  return response;
}

const NWS_ALERT_PROXY_AREAS = [
  "AL", "AZ", "AR", "CA", "CO", "CT", "DE", "FL",
  "GA", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
  "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC"
];

const NWS_ALERT_PROXY_TTL_SECONDS = 120;
const NWS_ALERT_PROXY_FETCH_CONCURRENCY = 6;

function normalizeNwsAlertAreas(rawAreas) {
  const requested = String(rawAreas || "")
    .split(",")
    .map((area) => area.trim().toUpperCase())
    .filter((area) => NWS_ALERT_PROXY_AREAS.includes(area));

  return [...new Set(requested)].sort();
}

function nwsAlertsUrlForArea(area) {
  return `https://api.weather.gov/alerts/active?area=${encodeURIComponent(area)}`;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || !items.length) return [];

  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const itemIndex = nextIndex;
      nextIndex += 1;

      if (itemIndex >= items.length) return;

      results[itemIndex] = await mapper(items[itemIndex], itemIndex);
    }
  };

  const workerCount = Math.min(
    items.length,
    Math.max(1, Number(concurrency) || 1)
  );

  await Promise.all(
    Array.from({ length: workerCount }, () => worker())
  );

  return results;
}

async function fetchNwsAlertFeaturesForArea(area) {
  const upstream = await fetch(nwsAlertsUrlForArea(area), {
    headers: NWS_HEADERS
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");

    throw new Error(
      `NWS alerts ${area} request failed: HTTP ${upstream.status}` +
      (detail ? ` - ${detail.slice(0, 220)}` : "")
    );
  }

  const collection = await upstream.json();

  return Array.isArray(collection?.features)
    ? collection.features
    : [];
}

function dedupeNwsAlertFeatures(features) {
  const seenAlertIds = new Set();

  return (Array.isArray(features) ? features : []).filter((feature, index) => {
    const alertId = String(
      feature?.id ||
      feature?.properties?.id ||
      feature?.properties?.identifier ||
      `unknown-alert-${index}`
    );

    if (seenAlertIds.has(alertId)) return false;

    seenAlertIds.add(alertId);
    return true;
  });
}

async function getCachedNwsAlerts(request) {
  const requestUrl = new URL(request.url);
  const areas = normalizeNwsAlertAreas(
    requestUrl.searchParams.get("areas")
  );

  const cache = caches.default;
  const cacheUrl = new URL("/api/nws-alerts", request.url);

  if (areas.length) {
    cacheUrl.searchParams.set("areas", areas.join(","));
  }

  const cacheKey = new Request(cacheUrl.toString(), {
    method: "GET"
  });

  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached;
  }

  let features = [];
  let partialFailures = [];
  let source = NWS_ACTIVE_ALERTS_URL;

  if (areas.length) {
    source = "https://api.weather.gov/alerts/active?area={state}";

    const areaResults = await mapWithConcurrency(
      areas,
      NWS_ALERT_PROXY_FETCH_CONCURRENCY,
      async (area) => {
        try {
          return {
            area,
            features: await fetchNwsAlertFeaturesForArea(area),
            error: ""
          };
        } catch (error) {
          console.warn(`NWS alert-area request failed for ${area}:`, error);

          return {
            area,
            features: [],
            error: String(error?.message || error || "Unknown failure")
          };
        }
      }
    );

    features = dedupeNwsAlertFeatures(
      areaResults.flatMap((result) => result.features)
    );

    partialFailures = areaResults
      .filter((result) => result.error)
      .map((result) => ({
        area: result.area,
        error: result.error
      }));
  } else {
    const upstream = await fetch(NWS_ACTIVE_ALERTS_URL, {
      headers: NWS_HEADERS
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");

      throw new Error(
        `NWS active-alert request failed: HTTP ${upstream.status}` +
        (detail ? ` - ${detail.slice(0, 220)}` : "")
      );
    }

    const collection = await upstream.json();

    features = Array.isArray(collection?.features)
      ? collection.features
      : [];
  }

  const response = opsJsonResponse(
    {
      type: "FeatureCollection",
      features,
      generatedAt: new Date().toISOString(),
      source,
      requestedAreas: areas,
      partialFailures
    },
    200,
    NWS_ALERT_PROXY_TTL_SECONDS
  );

  try {
    await cache.put(cacheKey, response.clone());
  } catch (error) {
    console.warn("Unable to cache NWS alerts response:", error);
  }

  return response;
}
const NWS_ZONE_PROXY_CACHE_TTL_SECONDS = 86400;

function normalizeNwsZoneProxyUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const host = url.hostname.toLowerCase();

    if (
      url.protocol !== "https:" ||
      host !== "api.weather.gov" ||
      !url.pathname.startsWith("/zones/")
    ) {
      return "";
    }

    url.hash = "";
    return url.toString();
  } catch (_error) {
    return "";
  }
}

async function getCachedNwsZone(request) {
  const requestUrl = new URL(request.url);
  const upstreamUrl = normalizeNwsZoneProxyUrl(requestUrl.searchParams.get("url"));

  if (!upstreamUrl) {
    return opsJsonResponse(
      { error: "Invalid NWS zone URL" },
      400,
      60
    );
  }

  const cache = caches.default;
  const cacheKeyUrl = new URL("/api/nws-zone", request.url);
  cacheKeyUrl.searchParams.set("url", upstreamUrl);

  const cacheKey = new Request(cacheKeyUrl.toString(), {
    method: "GET"
  });

  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached;
  }

  const upstream = await fetch(upstreamUrl, {
    headers: NWS_HEADERS
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");

    throw new Error(
      `NWS zone request failed: HTTP ${upstream.status}` +
      (detail ? ` - ${detail.slice(0, 220)}` : "")
    );
  }

  const zone = await upstream.json();
  const response = opsJsonResponse(
    zone,
    200,
    NWS_ZONE_PROXY_CACHE_TTL_SECONDS
  );

  try {
    await cache.put(cacheKey, response.clone());
  } catch (error) {
    console.warn("Unable to cache NWS zone geometry:", error);
  }

  return response;
}
const NWS_ALERT_SNAPSHOT_OBJECT_KEY =
  "alerts/active-alert-snapshot.json";

async function getPublishedNwsAlertSnapshot(env) {
  if (!env.RADAR_BUCKET) {
    throw new Error("Missing R2 binding: RADAR_BUCKET");
  }

  const object = await env.RADAR_BUCKET.get(
    NWS_ALERT_SNAPSHOT_OBJECT_KEY
  );

  if (!object) {
    return opsJsonResponse(
      {
        error: "Published alert snapshot is not available yet"
      },
      404,
      15
    );
  }

  const headers = new Headers();

  object.writeHttpMetadata(headers);

  headers.set(
    "content-type",
    object.httpMetadata?.contentType ||
      "application/geo+json; charset=utf-8"
  );

  headers.set(
    "cache-control",
    "public, max-age=45, stale-while-revalidate=75"
  );

  headers.set("etag", object.httpEtag);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "content-type, authorization"
  );

  return new Response(object.body, {
    status: 200,
    headers
  });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return jsonResponse({ ok: true });
    }

    if (url.pathname.startsWith("/api/live-alerts/")) {
      try {
        if (!env.LIVE_ALERT_HUB) {
          return opsJsonResponse(
            {
              error: "Live alert hub is not configured",
              generatedAt: new Date().toISOString()
            },
            503,
            15
          );
        }

        const hubId = env.LIVE_ALERT_HUB.idFromName("global-alert-hub");
        const hub = env.LIVE_ALERT_HUB.get(hubId);

        return await hub.fetch(request);
      } catch (error) {
        console.error("Live alert hub failed:", error);

        return opsJsonResponse(
          {
            error: "Live alert hub is temporarily unavailable",
            generatedAt: new Date().toISOString()
          },
          503,
          15
        );
      }
    }
    if (url.pathname === "/api/nws-alert-snapshot" && request.method === "GET") {
      try {
        return await getPublishedNwsAlertSnapshot(env);
      } catch (error) {
        console.error("Published alert snapshot failed:", error);

        return opsJsonResponse(
          {
            error: "Published alert snapshot is temporarily unavailable",
            generatedAt: new Date().toISOString()
          },
          503,
          15
        );
      }
    }
    if (url.pathname === "/api/nws-zone" && request.method === "GET") {
      try {
        return await getCachedNwsZone(request);
      } catch (error) {
        console.error("NWS zone proxy failed:", error);

        return opsJsonResponse(
          {
            error: "NWS zone geometry is temporarily unavailable",
            generatedAt: new Date().toISOString()
          },
          503,
          30
        );
      }
    }
    if (url.pathname === "/api/nws-alerts" && request.method === "GET") {
      try {
        return await getCachedNwsAlerts(request);
      } catch (error) {
        console.error("NWS alerts proxy failed:", error);

        return opsJsonResponse(
          {
            type: "FeatureCollection",
            features: [],
            error: "NWS alerts are temporarily unavailable",
            generatedAt: new Date().toISOString()
          },
          503,
          30
        );
      }
    }

    if (url.pathname === "/api/storm-reports" && request.method === "GET") {
      try {
        return await getCachedStormReports(request);
      } catch (error) {
        console.error("Storm report explorer failed:", error);

        return opsJsonResponse(
          {
            error: "Unable to load storm reports",
            detail: String(error?.message || error || "Unknown failure"),
            finalMaxYear: STORM_REPORTS_FINAL_MAX_YEAR
          },
          502,
          60
        );
      }
    }

    if (url.pathname === "/api/cpc/outlook" && request.method === "GET") {
      try {
        return await getCachedCpcOutlook(request);
      } catch (error) {
        console.error("CPC outlook failed:", error);

        return opsJsonResponse(
          {
            error: "CPC outlook is temporarily unavailable",
            generatedAt: new Date().toISOString()
          },
          503,
          60
        );
      }
    }
    if (url.pathname === "/api/ops/summary" && request.method === "GET") {
      try {
        return await getCachedOpsSummary(request, env);
      } catch (error) {
        console.error("Operations summary failed:", error);

        return opsJsonResponse(
          {
            error: "Operations summary is temporarily unavailable",
            generatedAt: new Date().toISOString()
          },
          503,
          30
        );
      }
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
      const hasChaseLocation = data.chaseLocation && typeof data.chaseLocation === "object";
      const chaseLocation = hasChaseLocation ? data.chaseLocation : {};
      const hasChaseField = (field) => Object.prototype.hasOwnProperty.call(chaseLocation, field);

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
        isLive: Boolean(data.isLive) || String(data.streamStatus || "").toLowerCase() === "live",
        chaseLocation: {
          mapDisplay: trueFlag(chaseLocation.mapDisplay),
          lat: finiteNumber(chaseLocation.lat),
          lon: finiteNumber(chaseLocation.lon),
          accuracy: hasChaseField("accuracy") ? finiteNumber(chaseLocation.accuracy) : undefined,
          heading: hasChaseField("heading") ? finiteNumber(chaseLocation.heading) : undefined,
          speed: hasChaseField("speed") ? finiteNumber(chaseLocation.speed) : undefined,
          updatedAt: chaseLocation.updatedAt ? String(chaseLocation.updatedAt) : undefined
        }
      };

      const updateFields = [
        "status = ?",
        "target_area = ?",
        "current_location = ?",
        "vehicle_status = ?",
        "vehicle_detail = ?",
        "headline = ?",
        "discussion = ?",
        "hazards = ?",
        "confidence = ?",
        "chase_probability = ?",
        "chase_probability_label = ?",
        "next_update = ?",
        "stream_status = ?",
        "stream_title = ?",
        "stream_url = ?",
        "stream_embed_url = ?",
        "last_updated = ?",
        "is_live = ?"
      ];

      const updateBinds = [
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
      ];

      if (hasChaseLocation) {
        updateFields.push("chase_map_display = ?");
        updateBinds.push(saved.chaseLocation.mapDisplay ? 1 : 0);

        if (saved.chaseLocation.lat !== null) {
          updateFields.push("chase_lat = ?");
          updateBinds.push(saved.chaseLocation.lat);
        }

        if (saved.chaseLocation.lon !== null) {
          updateFields.push("chase_lon = ?");
          updateBinds.push(saved.chaseLocation.lon);
        }

        if (hasChaseField("accuracy")) {
          updateFields.push("chase_accuracy = ?");
          updateBinds.push(saved.chaseLocation.accuracy);
        }

        if (hasChaseField("heading")) {
          updateFields.push("chase_heading = ?");
          updateBinds.push(saved.chaseLocation.heading);
        }

        if (hasChaseField("speed")) {
          updateFields.push("chase_speed = ?");
          updateBinds.push(saved.chaseLocation.speed);
        }

        if (saved.chaseLocation.updatedAt !== undefined) {
          updateFields.push("chase_location_updated = ?");
          updateBinds.push(saved.chaseLocation.updatedAt);
        }
      }

      await env.DB.prepare(`
        UPDATE chase_status
        SET ${updateFields.join(",\n          ")}
        WHERE id = 1
      `).bind(...updateBinds).run();

      return jsonResponse({ ok: true, status: saved });
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};






