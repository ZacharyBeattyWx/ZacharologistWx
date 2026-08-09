const CPC_OUTLOOK_CACHE_TTL_SECONDS = 900;
const CPC_PROGNOSTIC_DISCUSSION_URL =
  "https://www.cpc.ncep.noaa.gov/products/predictions/610day/fxus06.html";

const CPC_OUTLOOK_MAPS = {
  sixToTen: {
    temperature: "https://www.cpc.ncep.noaa.gov/products/predictions/610day/610temp.new.gif",
    precipitation: "https://www.cpc.ncep.noaa.gov/products/predictions/610day/610prcp.new.gif",
    page: "https://www.cpc.ncep.noaa.gov/products/predictions/610day/"
  },
  eightToFourteen: {
    temperature: "https://www.cpc.ncep.noaa.gov/products/predictions/814day/814temp.new.gif",
    precipitation: "https://www.cpc.ncep.noaa.gov/products/predictions/814day/814prcp.new.gif",
    page: "https://www.cpc.ncep.noaa.gov/products/predictions/814day/"
  }
};

const CPC_AREA_DEFINITIONS = [
  ["WASHINGTON", "Washington", "Northwest"],
  ["OREGON", "Oregon", "Northwest"],
  ["IDAHO", "Idaho", "Northwest"],
  ["W MONTANA", "Western Montana", "Northwest"],
  ["E MONTANA", "Eastern Montana", "Plains"],
  ["N DAKOTA", "North Dakota", "Plains"],
  ["S DAKOTA", "South Dakota", "Plains"],
  ["NEBRASKA", "Nebraska", "Plains"],
  ["KANSAS", "Kansas", "Plains"],
  ["WYOMING", "Wyoming", "Plains"],
  ["NRN CALIF", "Northern California", "West"],
  ["SRN CALIF", "Southern California", "West"],
  ["NEVADA", "Nevada", "Southwest"],
  ["UTAH", "Utah", "Southwest"],
  ["ARIZONA", "Arizona", "Southwest"],
  ["COLORADO", "Colorado", "Southwest"],
  ["NEW MEXICO", "New Mexico", "Southwest"],
  ["OKLAHOMA", "Oklahoma", "South"],
  ["N TEXAS", "North Texas", "South"],
  ["S TEXAS", "South Texas", "South"],
  ["W TEXAS", "West Texas", "South"],
  ["ARKANSAS", "Arkansas", "South"],
  ["LOUISIANA", "Louisiana", "South"],
  ["MINNESOTA", "Minnesota", "Midwest"],
  ["IOWA", "Iowa", "Midwest"],
  ["MISSOURI", "Missouri", "Midwest"],
  ["WISCONSIN", "Wisconsin", "Midwest"],
  ["ILLINOIS", "Illinois", "Midwest"],
  ["MICHIGAN", "Michigan", "Midwest"],
  ["INDIANA", "Indiana", "Midwest"],
  ["OHIO", "Ohio", "Midwest"],
  ["KENTUCKY", "Kentucky", "Southeast"],
  ["TENNESSEE", "Tennessee", "Southeast"],
  ["MISSISSIPPI", "Mississippi", "Southeast"],
  ["ALABAMA", "Alabama", "Southeast"],
  ["W VIRGINIA", "West Virginia", "Southeast"],
  ["VIRGINIA", "Virginia", "Southeast"],
  ["N CAROLINA", "North Carolina", "Southeast"],
  ["S CAROLINA", "South Carolina", "Southeast"],
  ["GEORGIA", "Georgia", "Southeast"],
  ["FL PNHDL", "Florida Panhandle", "Southeast"],
  ["FL PENIN", "Florida Peninsula", "Southeast"],
  ["NEW YORK", "New York", "Northeast"],
  ["VERMONT", "Vermont", "Northeast"],
  ["NEW HAMP", "New Hampshire", "Northeast"],
  ["MAINE", "Maine", "Northeast"],
  ["MASS", "Massachusetts", "Northeast"],
  ["CONN", "Connecticut", "Northeast"],
  ["RHODE IS", "Rhode Island", "Northeast"],
  ["PENN", "Pennsylvania", "Northeast"],
  ["NEW JERSEY", "New Jersey", "Northeast"],
  ["MARYLAND", "Maryland", "Northeast"],
  ["DELAWARE", "Delaware", "Northeast"],
  ["AK N SLOPE", "Alaska North Slope", "Alaska"],
  ["AK ALEUTIAN", "Aleutians", "Alaska"],
  ["AK WESTERN", "Western Alaska", "Alaska"],
  ["AK INT BSN", "Interior Alaska", "Alaska"],
  ["AK S INT", "South Interior Alaska", "Alaska"],
  ["AK SO COAST", "South Coast Alaska", "Alaska"],
  ["AK PNHDL", "Alaska Panhandle", "Alaska"]
].map(([sourceLabel, label, region]) => ({ sourceLabel, label, region }));

function normalizeCpcText(value) {
  return String(value || "")
    .replace(/\u00e2\u0080\u0093/g, "\u2013")
    .replace(/\u00e2\u0080\u0094/g, "\u2014")
    .replace(/\u00e2\u0080\u0098/g, "\u2018")
    .replace(/\u00e2\u0080\u0099/g, "\u2019")
    .replace(/\u00e2\u0080\u009c/g, "\u201c")
    .replace(/\u00e2\u0080\u009d/g, "\u201d")
    .replace(/\u00c2\u00a0/g, " ")
    .replace(/\u00a0/g, " ");
}

function decodeCpcEntities(value) {
  return normalizeCpcText(
    String(value || "")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
        String.fromCharCode(Number.parseInt(code, 16))
      )
      .replace(/&#(\d+);/g, (_match, code) =>
        String.fromCharCode(Number(code))
      )
  );
}

function cpcPlainTextFromHtml(value) {
  return decodeCpcEntities(
    String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

function cpcProductTextFromHtml(html) {
  const source = String(html || "");
  const preBlocks = [...source.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)]
    .map((match) => cpcPlainTextFromHtml(match[1]));

  let product = preBlocks.find((block) =>
    /PROGNOSTIC DISCUSSION FOR 6 TO 10 AND 8 TO 14 DAY OUTLOOKS/i.test(block)
  );

  if (!product) {
    product = cpcPlainTextFromHtml(source);
  }

  const startIndex = product.search(
    /PROGNOSTIC DISCUSSION FOR 6 TO 10 AND 8 TO 14 DAY OUTLOOKS/i
  );

  if (startIndex < 0) {
    throw new Error("CPC prognostic discussion was not found in the response");
  }

  product = product.slice(startIndex);

  const endIndex = product.indexOf("$$");
  if (endIndex >= 0) {
    product = product.slice(0, endIndex + 2);
  }

  return normalizeCpcText(product)
    .replace(/\r/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function cleanCpcLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cpcSection(product, startPattern, endPattern) {
  const startMatch = product.match(startPattern);
  if (!startMatch || startMatch.index === undefined) {
    return { header: "", body: "" };
  }

  const bodyStart = startMatch.index + startMatch[0].length;
  const remainder = product.slice(bodyStart);
  const endMatch = remainder.match(endPattern);
  const body = endMatch && endMatch.index !== undefined
    ? remainder.slice(0, endMatch.index)
    : remainder;

  return {
    header: cleanCpcLine(startMatch[1] || ""),
    body: body.trim()
  };
}

function cpcDiscussionParagraphs(sectionBody, periodKey) {
  const stopPattern = periodKey === "sixToTen"
    ? /\n\s*(?:THE OFFICIAL 6-10 DAY 500-HPA HEIGHT BLEND|FORECAST CONFIDENCE FOR THE 6-10 DAY PERIOD)/i
    : /\n\s*(?:THE OFFICIAL 8-14 DAY HEIGHT PROG|FORECAST CONFIDENCE FOR THE 8-14 DAY PERIOD)/i;

  const stopMatch = sectionBody.match(stopPattern);
  const narrative = stopMatch && stopMatch.index !== undefined
    ? sectionBody.slice(0, stopMatch.index)
    : sectionBody;

  return narrative
    .split(/\n\s*\n/)
    .map((paragraph) => cleanCpcLine(paragraph))
    .filter((paragraph) => paragraph.length > 30);
}

function cpcConfidenceLabel(score) {
  if (score >= 5) return "Very High";
  if (score >= 4) return "High";
  if (score >= 3) return "Moderate";
  if (score >= 2) return "Low";
  return "Very Low";
}

function cpcConfidence(sectionBody, periodLabel) {
  const pattern = new RegExp(
    `FORECAST CONFIDENCE FOR THE ${periodLabel} DAY PERIOD:\\s*([^,\\n]+),\\s*(\\d)\\s*out of\\s*5(?:,\\s*([^\\n]+))?`,
    "i"
  );
  const match = sectionBody.match(pattern);

  if (!match) return null;

  const score = Number(match[2]);

  return {
    label: cpcConfidenceLabel(score),
    score,
    max: 5,
    sourceLabel: cleanCpcLine(match[1]),
    detail: cleanCpcLine(match[3] || "")
  };
}

function cpcPeriod(product, periodKey) {
  const sixToTen = periodKey === "sixToTen";
  const section = cpcSection(
    product,
    sixToTen
      ? /6-10 DAY OUTLOOK FOR\s+([^\n]+)/i
      : /8-14 DAY OUTLOOK FOR\s+([^\n]+)/i,
    sixToTen
      ? /\n\s*8-14 DAY OUTLOOK FOR\b/i
      : /\n\s*(?:FORECASTER:|NOTES:|6-10 DAY OUTLOOK TABLE\b)/i
  );

  return {
    valid: section.header,
    confidence: cpcConfidence(section.body, sixToTen ? "6-10" : "8-14"),
    discussion: cpcDiscussionParagraphs(section.body, periodKey)
  };
}

function cpcLabelPattern(label) {
  return label
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
}

function cpcOutlookTableText(product, periodKey) {
  const startToken = periodKey === "sixToTen"
    ? "6-10 DAY OUTLOOK TABLE"
    : "8-14 DAY OUTLOOK TABLE";
  const startIndex = product.indexOf(startToken);

  if (startIndex < 0) return "";

  const remainder = product.slice(startIndex + startToken.length);
  const endPattern = periodKey === "sixToTen"
    ? /\n\s*8-14 DAY OUTLOOK TABLE\b/i
    : /\n\s*LEGEND\b/i;
  const endMatch = remainder.match(endPattern);

  return endMatch && endMatch.index !== undefined
    ? remainder.slice(0, endMatch.index)
    : remainder;
}

function cpcAreaOutlooks(product, periodKey) {
  const table = cpcOutlookTableText(product, periodKey);

  if (!table) return [];

  return CPC_AREA_DEFINITIONS.map((definition) => {
    const match = table.match(
      new RegExp(
        `${cpcLabelPattern(definition.sourceLabel)}\\s+([ANB])\\s+([ANB])\\b`,
        "i"
      )
    );

    if (!match) return null;

    return {
      label: definition.label,
      sourceLabel: definition.sourceLabel,
      region: definition.region,
      temperature: match[1].toUpperCase(),
      precipitation: match[2].toUpperCase()
    };
  }).filter(Boolean);
}

function buildCpcOutlookPayload(html) {
  const product = cpcProductTextFromHtml(html);
  const issuedMatch = product.match(
    /(\d{3,4}\s+(?:AM|PM)\s+(?:EST|EDT|CST|CDT|MST|MDT|PST|PDT)\s+\w{3}\s+\w+\s+\d{1,2}\s+\d{4})/i
  );
  const forecasterMatch = product.match(/FORECASTER:\s*([^\n]+)/i);
  const sixToTen = cpcPeriod(product, "sixToTen");
  const eightToFourteen = cpcPeriod(product, "eightToFourteen");

  sixToTen.areas = cpcAreaOutlooks(product, "sixToTen");
  eightToFourteen.areas = cpcAreaOutlooks(product, "eightToFourteen");

  return {
    generatedAt: new Date().toISOString(),
    cacheTtlSeconds: CPC_OUTLOOK_CACHE_TTL_SECONDS,
    issued: issuedMatch ? cleanCpcLine(issuedMatch[1]) : "",
    forecaster: forecasterMatch ? cleanCpcLine(forecasterMatch[1]) : "",
    referencePeriod: "1991-2020",
    sixToTen,
    eightToFourteen,
    maps: CPC_OUTLOOK_MAPS,
    source: {
      discussion: CPC_PROGNOSTIC_DISCUSSION_URL,
      agency: "NOAA/NWS Climate Prediction Center"
    }
  };
}


function cpcJsonResponse(data, status = 200, ttlSeconds = CPC_OUTLOOK_CACHE_TTL_SECONDS) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "cache-control": `public, max-age=${ttlSeconds}`
    }
  });
}

async function buildCpcOutlook() {
  const upstream = await fetch(CPC_PROGNOSTIC_DISCUSSION_URL, {
    headers: {
      "accept": "text/html,text/plain;q=0.9,*/*;q=0.8",
      "user-agent": "ZacharologistWx Climate Outlook Center (https://zacharologistwx.com)"
    }
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    throw new Error(
      `CPC discussion request failed: HTTP ${upstream.status}` +
      (detail ? ` - ${detail.slice(0, 180)}` : "")
    );
  }

  return buildCpcOutlookPayload(await upstream.text());
}

export async function getCachedCpcOutlook(request) {
  const cache = caches.default;
  const cacheKey = new Request(
    new URL("/api/cpc/outlook", request.url).toString(),
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const payload = await buildCpcOutlook();
  const response = cpcJsonResponse(payload);

  try {
    await cache.put(cacheKey, response.clone());
  } catch (error) {
    console.warn("Unable to cache CPC outlook response:", error);
  }

  return response;
}