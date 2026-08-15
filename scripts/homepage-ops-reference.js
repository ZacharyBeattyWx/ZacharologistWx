(() => {
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
  const DAYLIGHT_FALLBACK_LOCATION = {
    latitude: 36.0726,
    longitude: -79.7920,
    locationName: "Greensboro, NC",
    timeZone: "America/New_York"
  };

  function resolveDaylightTimeZone(candidate) {
    const fallback =
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      DAYLIGHT_FALLBACK_LOCATION.timeZone;

    const requested = String(candidate || "").trim();

    if (!requested) return fallback;

    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: requested
      }).format();

      return requested;
    } catch (error) {
      return fallback;
    }
  }

  function getDaylightLocation() {
    try {
      const cached =
        typeof window.readLiveConditionsCache === "function"
          ? window.readLiveConditionsCache()
          : null;

      const latitude = Number(cached?.latitude);
      const longitude = Number(cached?.longitude);

      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        return {
          latitude,
          longitude,
          locationName:
            String(cached.locationName || "").trim() ||
            DAYLIGHT_FALLBACK_LOCATION.locationName,
          timeZone: resolveDaylightTimeZone(cached.timeZone)
        };
      }
    } catch (error) {
      console.warn("Unable to read live location for daylight card:", error);
    }

    return {
      ...DAYLIGHT_FALLBACK_LOCATION,
      timeZone: resolveDaylightTimeZone(
        DAYLIGHT_FALLBACK_LOCATION.timeZone
      )
    };
  }

  const NWS_ALERT_MAP_BBOX = "-14200000,2800000,-7000000,6500000";

  function buildNwsMapExportUrl(serviceUrl, layers) {
    const query = new URLSearchParams({
      bbox: NWS_ALERT_MAP_BBOX,
      bboxSR: "3857",
      imageSR: "3857",
      size: "640,330",
      format: "png32",
      transparent: "true",
      layers: `show:${layers}`,
      f: "image",
      cache: String(Math.floor(Date.now() / 300000))
    });

    return `${serviceUrl}/export?${query.toString()}`;
  }

  function getNwsAlertMapUrls() {
    const alertService =
      "https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer";

    return {
      base: buildNwsMapExportUrl(
        "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer",
        "3"
      ),
      alerts: buildNwsMapExportUrl(alertService, "1"),
      currentWarnings: buildNwsMapExportUrl(alertService, "0")
    };
  }

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function opsUrl() {
    if (LOCAL_HOSTS.has(window.location.hostname) && window.location.port !== "8787") {
      return "http://127.0.0.1:8787/api/ops/summary";
    }

    return "/api/ops/summary";
  }

  function scrollButton(label, target) {
    return `
      <button class="ops-reference-button" type="button"
        data-ops-reference-scroll="${esc(target)}">
        ${esc(label)}
      </button>
    `;
  }

  function card(tone, icon, kicker, title, body, extraClass = "") {
    return `
      <article class="ops-reference-card ops-reference-card--${tone} ${extraClass}">
        <span class="ops-reference-icon" aria-hidden="true">${esc(icon)}</span>
        <p class="ops-reference-kicker">${esc(kicker)}</p>
        <strong class="ops-reference-title">${esc(title)}</strong>
        ${body}
      </article>
    `;
  }

  function countItems(value) {
    if (Array.isArray(value)) return value;

    if (value && typeof value === "object") {
      return Object.entries(value).map(([event, count]) => ({ event, count }));
    }

    return [];
  }

  function riskRank(label) {
    const text = clean(label).toLowerCase();

    if (text.includes("high")) return 5;
    if (text.includes("moderate")) return 4;
    if (text.includes("enhanced")) return 3;
    if (text.includes("slight")) return 2;
    if (text.includes("marginal")) return 1;

    return 0;
  }

  function riskScore(rank) {
    /*
      SPC categorical scale:
      0 = no organized severe risk
      1 = Marginal
      2 = Slight
      3 = Enhanced
      4 = Moderate
      5 = High
    */
    return Math.max(0, Math.min(5, rank));
  }

  function riskTone(rank) {
    if (rank >= 4) return "red";
    if (rank >= 1) return "amber";
    return "green";
  }

  function riskDial(rank) {
  const score = riskScore(rank);
  const angle = -90 + ((score / 5) * 180);

  return `
    <div class="ops-risk-dial risk-rank-${rank}" style="--risk-needle:${angle}deg" aria-hidden="true">
      <span class="ops-risk-dial-arc"></span>
            <span class="ops-risk-score">
        <strong>${score}<span class="ops-risk-score-denominator">/5</span></strong>
      </span>
    </div>
  `;
}

  function dayOfYear(date) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const today = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate()
    );

    return Math.floor((today - start) / 86400000);
  }

  function normalizeAngle(value) {
    return ((value % 360) + 360) % 360;
  }

  function sunHour(date, latitude, longitude, sunrise) {
    const zenith = 90.833;
    const day = dayOfYear(date);
    const longitudeHour = longitude / 15;
    const t = day + ((sunrise ? 6 : 18) - longitudeHour) / 24;
    const m = (0.9856 * t) - 3.289;

    let solarLongitude = m +
      (1.916 * Math.sin(m * Math.PI / 180)) +
      (0.020 * Math.sin(2 * m * Math.PI / 180)) +
      282.634;

    solarLongitude = normalizeAngle(solarLongitude);

    let rightAscension = Math.atan(
      0.91764 * Math.tan(solarLongitude * Math.PI / 180)
    ) * 180 / Math.PI;

    rightAscension = normalizeAngle(rightAscension);

    const longitudeQuadrant = Math.floor(solarLongitude / 90) * 90;
    const rightAscensionQuadrant = Math.floor(rightAscension / 90) * 90;

    rightAscension = (
      rightAscension + (longitudeQuadrant - rightAscensionQuadrant)
    ) / 15;

    const sinDeclination = 0.39782 * Math.sin(solarLongitude * Math.PI / 180);
    const cosDeclination = Math.cos(Math.asin(sinDeclination));

    const cosHour = (
      Math.cos(zenith * Math.PI / 180) -
      (sinDeclination * Math.sin(latitude * Math.PI / 180))
    ) / (cosDeclination * Math.cos(latitude * Math.PI / 180));

    if (cosHour > 1 || cosHour < -1) return null;

    const hourAngle = sunrise
      ? 360 - (Math.acos(cosHour) * 180 / Math.PI)
      : Math.acos(cosHour) * 180 / Math.PI;

    const localMean = (hourAngle / 15) + rightAscension - (0.06571 * t) - 6.622;
    return (localMean - longitudeHour + 24) % 24;
  }

  function zonedCalendarDate(date, timeZone) {
    const values = {};

    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(date)
      .forEach((part) => {
        if (part.type !== "literal") {
          values[part.type] = part.value;
        }
      });

    return new Date(
      Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day)
      )
    );
  }

  function daylightData() {
    const location = getDaylightLocation();
    const now = new Date();
    const locationDate = zonedCalendarDate(now, location.timeZone);

    const sunriseHour = sunHour(
      locationDate,
      location.latitude,
      location.longitude,
      true
    );

    const sunsetHour = sunHour(
      locationDate,
      location.latitude,
      location.longitude,
      false
    );

    if (sunriseHour === null || sunsetHour === null) {
      return {
        sunrise: "--",
        sunset: "--",
        length: "--",
        locationName: location.locationName
      };
    }

    const dayStart = locationDate.getTime();
    const sunriseMs = dayStart + Math.round(sunriseHour * 3600000);
    let sunsetMs = dayStart + Math.round(sunsetHour * 3600000);

    if (sunsetMs <= sunriseMs) {
      sunsetMs += 86400000;
    }

    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: location.timeZone,
      hour: "numeric",
      minute: "2-digit"
    });

    const minutes = Math.round((sunsetMs - sunriseMs) / 60000);

    return {
      sunrise: format.format(new Date(sunriseMs)),
      sunset: format.format(new Date(sunsetMs)),
      length: `${Math.floor(minutes / 60)}h ${minutes % 60}m`,
      locationName: location.locationName
    };
  }

  function moonData() {
    const location = getDaylightLocation();
    const now = new Date();
    const month = 29.530588853;
    const reference = Date.UTC(2000, 0, 6, 18, 14);
    const age = (((now.getTime() - reference) / 86400000) % month + month) % month;
    const fraction = age / month;
    const illumination = Math.round(
      ((1 - Math.cos(2 * Math.PI * fraction)) / 2) * 100
    );
    const isWaxing = fraction < 0.5;

    let phase = "New Moon";

    if (fraction >= 0.03 && fraction < 0.22) phase = "Waxing Crescent";
    else if (fraction < 0.28) phase = "First Quarter";
    else if (fraction < 0.47) phase = "Waxing Gibbous";
    else if (fraction < 0.53) phase = "Full Moon";
    else if (fraction < 0.72) phase = "Waning Gibbous";
    else if (fraction < 0.78) phase = "Last Quarter";
    else if (fraction < 0.97) phase = "Waning Crescent";

    return {
      phase,
      illumination,
      isWaxing,
      date: now.toISOString(),
      latitude: location.latitude,
      locationName: location.locationName
    };
  }

  function briefingText() {
    const heading = Array.from(
      document.querySelectorAll("h1, h2, h3, h4, h5, strong")
    ).find((node) => /forecast discussion/i.test(clean(node.textContent)));

    if (!heading) {
      return "Open the forecast discussion for the latest operational weather focus.";
    }

    let parent = heading.parentElement;

    for (let i = 0; i < 4 && parent; i += 1) {
      const paragraph = Array.from(parent.querySelectorAll("p"))
        .map((node) => clean(node.textContent))
        .find((text) => text.length > 35);

      if (paragraph) {
        return paragraph.match(/^(.{45,175}?[.!?])(?:\s|$)/)?.[1] ||
          paragraph.slice(0, 175);
      }

      parent = parent.parentElement;
    }

    return "Open the forecast discussion for the latest operational weather focus.";
  }

  function shortTime(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit"
      }).format(date);
    }

    return clean(value).slice(0, 12) || "—";
  }

  function reportTitle(report) {
    const magnitude = clean(report?.magnitude || report?.value || "");
    const type = clean(report?.type || report?.reportType || "Storm report");
    return clean(`${magnitude} ${type}`) || "Storm report";
  }

  function reportLocation(report) {
    return clean(
      report?.location ||
      report?.county ||
      report?.state ||
      report?.remarks ||
      "Location pending"
    );
  }

  function numericPercent(value) {
    const match = String(value ?? "").match(/-?\d+(\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function stormReportsPageUrl(hazard, monthLabel) {
    const monthNumbers = {
      january: 1,
      february: 2,
      march: 3,
      april: 4,
      may: 5,
      june: 6,
      july: 7,
      august: 8,
      september: 9,
      october: 10,
      november: 11,
      december: 12
    };

    const match = clean(monthLabel).match(/^([A-Za-z]+)\s+(\d{4})$/);
    const fallbackDate = new Date(Date.now() - (12 * 60 * 60 * 1000));
    const year = match
      ? Number(match[2])
      : fallbackDate.getUTCFullYear();
    const month = match
      ? monthNumbers[match[1].toLowerCase()]
      : fallbackDate.getUTCMonth() + 1;

    const query = new URLSearchParams({
      year: String(year),
      month: String(month || fallbackDate.getUTCMonth() + 1),
      scope: "national",
      type: hazard,
      dataset: "preliminary",
      view: "map"
    });

    return `storm-reports.html?${query.toString()}`;
  }

  function watchRows(items) {
    if (!items.length) {
      return `<span class="ops-reference-copy">No active NWS watch products are currently returned by the live feed.</span>`;
    }

    return `
      <div class="ops-list">
        ${items.slice(0, 3).map((item) => `
          <span class="ops-list-row">
            <span class="ops-list-label">${esc(item.event || item.label || "Watch")}</span>
            <strong class="ops-list-value">${esc(item.count ?? item.value ?? "")}</strong>
          </span>
        `).join("")}
      </div>
    `;
  }

  function fireRows(items) {
    if (!items.length) {
      return `
        <div class="ops-fire-quiet">
          <span class="ops-quiet-orb"></span>
          <strong>No active fire products</strong>
          <span>No Red Flag Warning or Fire Weather Watch is currently returned by NWS.</span>
        </div>
      `;
    }

    return watchRows(items);
  }

  function renderLeft(summary) {
    const nwsAlertMap = getNwsAlertMapUrls();const risk = summary?.severeRisk || {};
    const rank = Number.isFinite(Number(risk.rank))
      ? Number(risk.rank)
      : riskRank(risk.label);

    const daylight = daylightData();
    const moon = moonData();
    const metar = summary?.metar || {};

    const temperature = Number.isFinite(Number(metar.temperatureF))
      ? `${Math.round(Number(metar.temperatureF))}°F`
      : "--";

    const wind = Number.isFinite(Number(metar.windSpeed))
      ? `${Math.round(Number(metar.windSpeed))} kt`
      : "--";

    const dewPoint = Number.isFinite(Number(metar.dewPointF))
      ? `${Math.round(Number(metar.dewPointF))}°`
      : "--";

    const altimeter = Number.isFinite(Number(metar.altimeterInHg))
      ? `${Number(metar.altimeterInHg).toFixed(2)} in`
      : "--";

    return `
      ${card(
        riskTone(rank),
        "RISK",
        "Severe Weather Risk Today",
        risk.label || "No severe risk",
        `
          ${riskDial(rank)}
          <strong class="ops-risk-label">${esc(risk.label || "General thunder")}</strong>
          <span class="ops-reference-meta">SPC Day 1 • national outlook</span>
          <span class="ops-reference-copy">Highest categorical risk in the current national convective outlook.</span>
          ${scrollButton("View Outlooks", "spc")}
        `
      )}

      ${card(
        "amber",
        "SUN",
        "Daylight",
        "Local daylight window",
        `
          <div class="ops-sun-arc" aria-hidden="true"></div>
          <div class="ops-sun-grid">
            <span class="ops-sun-cell">
              <span class="ops-sun-label">Sunrise</span>
              <strong class="ops-sun-value">${esc(daylight.sunrise)}</strong>
            </span>
            <span class="ops-sun-cell">
              <span class="ops-sun-label">Sunset</span>
              <strong class="ops-sun-value">${esc(daylight.sunset)}</strong>
            </span>
          </div>
          <span class="ops-reference-meta">${esc(daylight.length)} daylight • ${esc(daylight.locationName)}</span>
        `
      )}

      ${card(
        "amber",
        "SAFE",
        "Safety Reminder",
        "Have multiple warning sources",
        `<span class="ops-reference-copy">Use NOAA Weather Radio, Wireless Emergency Alerts, trusted local media, and live radar awareness together.</span>`,
        "ops-reference-card--safety"
      )}      ${card(
        "blue",
        "MOON",
        "Current Moon",
        moon.phase,
        `
          <div class="ops-moon-row"
            data-moon-phase="${esc(moon.phase)}"
            data-moon-illumination="${esc(moon.illumination)}"
            data-moon-waxing="${moon.isWaxing ? "true" : "false"}"
            data-moon-date="${esc(moon.date)}"
            data-moon-latitude="${esc(moon.latitude)}"
            data-moon-location="${esc(moon.locationName)}">
            <span class="ops-moon-disc" aria-hidden="true">
              <i class="ops-moon-shadow"></i>
            </span>
            <span>
              <strong class="ops-moon-phase">${esc(`${moon.illumination}% illuminated`)}</strong>
              <span class="ops-moon-detail">Calculated astronomical phase for tonight.</span>
            </span>
          </div>
        `
      )}

      ${card(
        "blue",
        "MAP",
        "NWS Alerts Map",
        "",
        `
          <div class="ops-nws-alert-map" role="img"
            aria-label="Live National Weather Service active alerts map">
            <img class="ops-nws-alert-map-base"
              src="${esc(nwsAlertMap.base)}"
              alt=""
              aria-hidden="true">
            <img class="ops-nws-alert-map-alerts"
              src="${esc(nwsAlertMap.alerts)}"
              alt="Current National Weather Service watches, warnings, and advisories">
            <img class="ops-nws-alert-map-warnings"
              src="${esc(nwsAlertMap.currentWarnings)}"
              alt=""
              aria-hidden="true">
          </div>

          <a class="ops-reference-button ops-nws-alert-map-button"
            href="level2-mobile-radar.html">
            View Alert Map
          </a>
        `,
        "ops-reference-card--nws-alert-map"
      )}
    `;
  }

  function renderRight(summary) {
    const tornadoCount = summary?.tornadoCount || {};

    const tornadoDailyAvailable =
      tornadoCount.dailyAvailable === true &&
      Number.isFinite(Number(tornadoCount.dailyCount));

    const tornadoDailyValue = tornadoDailyAvailable
      ? Number(tornadoCount.dailyCount).toLocaleString("en-US")
      : "—";

    const tornadoMonthCount =
      tornadoCount.monthCount ?? tornadoCount.count;

    const tornadoMonthlyAvailable =
      (tornadoCount.monthlyAvailable === true ||
        tornadoCount.available === true) &&
      Number.isFinite(Number(tornadoMonthCount));

    const tornadoMonthValue = tornadoMonthlyAvailable
      ? Number(tornadoMonthCount).toLocaleString("en-US")
      : "—";

    const tornadoMonth =
      clean(tornadoCount.monthLabel) || "Current month";

    const tornadoTrackerUrl =
      clean(tornadoCount.trackerUrl) ||
      "https://www.spc.noaa.gov/climo/reports/today.html";

    function reportMetric(value) {
      const dailyAvailable =
        value?.dailyAvailable === true &&
        Number.isFinite(Number(value?.dailyCount));

      const monthlyAvailable =
        value?.monthlyAvailable === true &&
        Number.isFinite(Number(value?.monthCount));

      return {
        dailyAvailable,
        dailyValue: dailyAvailable
          ? Number(value.dailyCount).toLocaleString("en-US")
          : "—",
        monthlyAvailable,
        monthValue: monthlyAvailable
          ? Number(value.monthCount).toLocaleString("en-US")
          : "—",
        monthLabel: clean(value?.monthLabel) || "Current month",
        trackerUrl:
          clean(value?.trackerUrl) ||
          "https://www.spc.noaa.gov/climo/reports/today.html"
      };
    }

    const hailMetric = reportMetric(summary?.hailCount || {});
    const windMetric = reportMetric(summary?.windCount || {});
    const watches = countItems(summary?.alerts?.watches);

    const fireWeather = countItems(summary?.alerts?.fireWeather);
    const watchTotal = watches.reduce(
      (total, item) => total + Number(item.count || item.value || 0),
      0
    );


    const watchTypeCount = watches.length;
const threats = [
      ["Tornado", numericPercent(summary?.spcThreats?.tornado?.percent)],
      ["Wind", numericPercent(summary?.spcThreats?.wind?.percent)],
      ["Hail", numericPercent(summary?.spcThreats?.hail?.percent)]
    ].filter(([, percent]) => Number.isFinite(percent));

    return `
      ${card(
  "red",
  "TOR",
  "Tornado Reports",
  "Today",
  `
    <div class="ops-tornado-layout ops-report-count-layout">
      <span class="ops-tornado-icon ops-report-count-icon" aria-hidden="true">
        <svg viewBox="0 0 64 64" role="presentation">
          <path d="M12 10h40M17 19h30M22 28h20M27 37h10M31 46h3"
            fill="none" stroke="currentColor" stroke-linecap="round"
            stroke-width="5"></path>
          <path d="M45 10c0 9-6 13-10 18-4 5-2 10-2 18"
            fill="none" stroke="currentColor" stroke-linecap="round"
            stroke-width="4"></path>
        </svg>
      </span>

      <span class="ops-tornado-metric">
        <strong class="ops-tornado-count">${esc(tornadoDailyValue)}</strong>
        <small class="ops-tornado-delta">
          ${esc(
            tornadoDailyAvailable
              ? "Current SPC day"
              : "Live tracker unavailable"
          )}
        </small>
      </span>
    </div>

    <a class="ops-report-month-total ops-report-month-link"
      href="${esc(stormReportsPageUrl("tornado", tornadoMonth))}"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open tornado reports in the Storm Report Explorer">
      <span>${esc(`${tornadoMonth} total`)}</span>
      <strong>${esc(tornadoMonthValue)}</strong>
      <span class="ops-report-month-arrow" aria-hidden="true">&#8250;</span>
    </a>

    <span class="ops-tornado-note">
      Preliminary SPC tornado reports.
    </span>

    <a class="ops-reference-button ops-tornado-button"
      href="${esc(tornadoTrackerUrl)}"
      target="_blank"
      rel="noopener noreferrer">
      Today&#39;s SPC Reports
    </a>
  `,
  "ops-reference-card--tornado ops-reference-card--report-count"
)}
      ${card(
        "blue",
        "HAIL",
        "Hail Reports",
        "Today",
        `
          <div class="ops-tornado-layout ops-report-count-layout">
            <span class="ops-tornado-icon ops-report-count-icon" aria-hidden="true">
              <svg viewBox="0 0 64 64" role="presentation">
                <!-- Falling streaks -->
                <path
                  d="M18 8v8M32 5v10M46 9v8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                  opacity="0.8">
                </path>

                <!-- Three faceted hailstones -->
                <path
                  d="M10 28 17 21 27 23 31 32 27 42 17 45 9 38Z"
                  fill="currentColor"
                  opacity="0.22">
                </path>
                <path
                  d="M10 28 17 21 27 23 31 32 27 42 17 45 9 38Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linejoin="round">
                </path>

                <path
                  d="M35 22 42 17 51 20 55 29 51 38 42 41 35 35 33 28Z"
                  fill="currentColor"
                  opacity="0.22">
                </path>
                <path
                  d="M35 22 42 17 51 20 55 29 51 38 42 41 35 35 33 28Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linejoin="round">
                </path>

                <path
                  d="M22 46 30 40 40 43 44 52 39 60 29 61 21 55Z"
                  fill="currentColor"
                  opacity="0.22">
                </path>
                <path
                  d="M22 46 30 40 40 43 44 52 39 60 29 61 21 55Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linejoin="round">
                </path>

                <!-- Ice facets -->
                <path
                  d="M15 30l5-4 5 2-3 6-6 2-3-3
                     M40 25l4-3 5 2-2 6-6 2-3-3
                     M28 49l5-4 5 2-2 6-6 2-4-3"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  opacity="0.88">
                </path>
              </svg>
            </span>

            <span class="ops-tornado-metric">
              <strong class="ops-tornado-count">${esc(hailMetric.dailyValue)}</strong>
              <small class="ops-tornado-delta">
                ${esc(
                  hailMetric.dailyAvailable
                    ? "Current SPC day"
                    : "Live tracker unavailable"
                )}
              </small>
            </span>
          </div>

          <a class="ops-report-month-total ops-report-month-link"
            href="${esc(stormReportsPageUrl("hail", hailMetric.monthLabel))}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open hail reports in the Storm Report Explorer">
            <span>${esc(`${hailMetric.monthLabel} total`)}</span>
            <strong>${esc(hailMetric.monthValue)}</strong>
            <span class="ops-report-month-arrow" aria-hidden="true">&#8250;</span>
          </a>

          <span class="ops-tornado-note">
            Preliminary SPC hail reports.
          </span>

          <a class="ops-reference-button ops-tornado-button ops-report-count-button"
            href="${esc(hailMetric.trackerUrl)}"
            target="_blank"
            rel="noopener noreferrer">
            Today&#39;s SPC Reports
          </a>
        `,
        "ops-reference-card--report-count ops-reference-card--hail"
      )}

      ${card(
        "blue",
        "WND",
        "Wind Reports",
        "Today",
        `
          <div class="ops-tornado-layout ops-report-count-layout">
            <span class="ops-tornado-icon ops-report-count-icon" aria-hidden="true">
              <svg viewBox="0 0 64 64" role="presentation">
                <path d="M9 22h30c7 0 10-4 10-8 0-4-3-7-7-7-4 0-7 2-8 6"
                  fill="none" stroke="currentColor" stroke-width="4"
                  stroke-linecap="round"></path>
                <path d="M9 32h40c5 0 8 3 8 7s-3 8-8 8c-4 0-7-2-8-6"
                  fill="none" stroke="currentColor" stroke-width="4"
                  stroke-linecap="round"></path>
                <path d="M9 43h22"
                  fill="none" stroke="currentColor" stroke-width="4"
                  stroke-linecap="round"></path>
              </svg>
            </span>

            <span class="ops-tornado-metric">
              <strong class="ops-tornado-count">${esc(windMetric.dailyValue)}</strong>
              <small class="ops-tornado-delta">
                ${esc(
                  windMetric.dailyAvailable
                    ? "Current SPC day"
                    : "Live tracker unavailable"
                )}
              </small>
            </span>
          </div>

          <a class="ops-report-month-total ops-report-month-link"
            href="${esc(stormReportsPageUrl("wind", windMetric.monthLabel))}"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open wind reports in the Storm Report Explorer">
            <span>${esc(`${windMetric.monthLabel} total`)}</span>
            <strong>${esc(windMetric.monthValue)}</strong>
            <span class="ops-report-month-arrow" aria-hidden="true">&#8250;</span>
          </a>

          <span class="ops-tornado-note">
            Preliminary SPC damaging-wind reports.
          </span>

          <a class="ops-reference-button ops-tornado-button ops-report-count-button"
            href="${esc(windMetric.trackerUrl)}"
            target="_blank"
            rel="noopener noreferrer">
            Today&#39;s SPC Reports
          </a>
        `,
        "ops-reference-card--report-count ops-reference-card--wind"
      )}

      ${card(
        "blue",
        "SPC",
        "SPC Threat Snapshot",
        "Day 1 outlook",
        threats.length
          ? threats.map(([name, percent]) => `
              <div class="ops-threat">
                <span class="ops-threat-head">
                  <span class="ops-threat-name">${esc(name)}</span>
                  <strong class="ops-threat-value">${esc(percent)}%</strong>
                </span>
                <span class="ops-threat-track">
                  <i class="ops-threat-fill"
                    style="--threat-width:${Math.min(100, Math.max(4, percent * 2.5))}%"></i>
                </span>
              </div>
            `).join("")
          : `<span class="ops-reference-copy">No Day 1 probabilistic contours are currently available.</span>`
      )}


    `;
  }

  function scrollToTarget(target) {
    if (target === "discussion") {
      const node = Array.from(
        document.querySelectorAll("h1, h2, h3, h4, h5, strong")
      ).find((item) => /forecast discussion/i.test(clean(item.textContent)));

      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const selectors = {
      alerts: ".alerts-card",
      spc: ".spc-card"
    };

    document.querySelector(selectors[target])?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }

  function bindButtons(scope) {
    scope.querySelectorAll("[data-ops-reference-scroll]").forEach((button) => {
      button.addEventListener("click", () => {
        scrollToTarget(button.dataset.opsReferenceScroll);
      });
    });
  }

  function ensureLayout() {
    const shell = document.querySelector(".ops-board-shell");
    if (!shell) return null;

    let layout = shell.closest(".ops-reference-layout");

    if (!layout) {
      layout = document.createElement("div");
      layout.className = "ops-reference-layout";
      shell.parentNode.insertBefore(layout, shell);
      layout.appendChild(shell);
    }

    let left = layout.querySelector(":scope > .ops-reference-left");
    let right = layout.querySelector(":scope > .ops-reference-right");

    if (!left) {
      left = document.createElement("aside");
      left.className = "ops-reference-rail ops-reference-left";
      left.setAttribute("aria-label", "Weather operations context");
      layout.insertBefore(left, shell);
    }

    if (!right) {
      right = document.createElement("aside");
      right.className = "ops-reference-rail ops-reference-right";
      right.setAttribute("aria-label", "Weather operations hazards");
      layout.appendChild(right);
    }

    return { layout, left, right };
  }

  function syncRailHeight() {
    const layout = document.querySelector(".ops-reference-layout");
    const spc = document.querySelector(".spc-card");

    if (!layout || !spc) return;

    const spcBottom = spc.getBoundingClientRect().bottom;
    const layoutTop = layout.getBoundingClientRect().top;

    // Preserve the original shared height for any older rail rules.
    layout.style.setProperty(
      "--ops-reference-height",
      `${Math.max(0, Math.round(spcBottom - layoutTop))}px`
    );

    [
      [".ops-reference-left", "--ops-left-rail-height"],
      [".ops-reference-right", "--ops-right-rail-height"],
      [".ops-right-column", "--ops-alerts-height"]
    ].forEach(([selector, variable]) => {
      const column = layout.querySelector(selector);

      if (!column) return;

      layout.style.setProperty(
        variable,
        `${Math.max(0, Math.round(spcBottom - column.getBoundingClientRect().top))}px`
      );
    });
  }

  const OPS_SUMMARY_CACHE_KEY = "zacharologist:homepage-ops-summary:v1";
  const OPS_SUMMARY_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
  function readCachedOpsSummary() {
    try {
      const raw = localStorage.getItem(OPS_SUMMARY_CACHE_KEY);
      if (!raw) return null;

      const cached = JSON.parse(raw);

      if (!cached || typeof cached !== "object" || !cached.summary) {
        return null;
      }

      const savedAt = Number(cached.savedAt || 0);
      const age = Date.now() - savedAt;

      if (!Number.isFinite(savedAt) || age < 0 || age > OPS_SUMMARY_CACHE_MAX_AGE_MS) {
        return null;
      }

      return cached.summary;
    } catch (error) {
      console.warn("Unable to read cached operations summary:", error);
      return null;
    }
  }

  function writeCachedOpsSummary(summary) {
    try {
      localStorage.setItem(
        OPS_SUMMARY_CACHE_KEY,
        JSON.stringify({
          savedAt: Date.now(),
          summary
        })
      );
    } catch (error) {
      console.warn("Unable to cache operations summary:", error);
    }
  }

function writeCachedOpsRailHtml(layout) {
    try {
      localStorage.setItem(
        OPS_RAIL_HTML_CACHE_KEY,
        JSON.stringify({
          savedAt: Date.now(),
          leftHtml: layout.left.innerHTML,
          rightHtml: layout.right.innerHTML
        })
      );
    } catch (error) {
      console.warn("Unable to cache rendered operations rails:", error);
    }
  }
  function paintOpsSummary(layout, summary) {
    layout.left.innerHTML = renderLeft(summary);
    layout.right.innerHTML = renderRight(summary);

    bindButtons(layout.layout);
    syncRailHeight();

    window.setTimeout(syncRailHeight, 250);
    window.setTimeout(syncRailHeight, 1000);
  }

  function bootstrapOpsSummary() {
    const value = window.__ZACH_OPS_BOOTSTRAP__;

    return (
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    )
      ? value
      : null;
  }

  function opsSummaryTimestamp(summary) {
    const value = Date.parse(summary?.generatedAt || "");
    return Number.isFinite(value) ? value : 0;
  }

  function newestOpsSummary(first, second) {
    if (!first) return second || null;
    if (!second) return first;

    return opsSummaryTimestamp(second) >
      opsSummaryTimestamp(first)
        ? second
        : first;
  }

  function revealOpsLayout(layout) {
    layout.layout.classList.remove(
      "ops-reference-preboot"
    );
  }

  async function render() {
    const layout = ensureLayout();
    if (!layout) return;

    /*
      Production priority:
        1. Cloudflare-injected bootstrap snapshot
        2. Recent browser cache
        3. Fresh API response

      Whichever initial source is newest paints synchronously.
    */
    const bootstrapSummary = bootstrapOpsSummary();
    const cachedSummary = readCachedOpsSummary();

    const initialSummary = newestOpsSummary(
      bootstrapSummary,
      cachedSummary
    );

    if (initialSummary) {
      paintOpsSummary(layout, initialSummary);
      revealOpsLayout(layout);
    }

    try {
      const response = await fetch(
        opsUrl(),
        { cache: "no-store" }
      );

      if (!response.ok) {
        throw new Error(
          `Operations summary returned ${response.status}`
        );
      }

      const summary = await response.json();

      writeCachedOpsSummary(summary);

      /*
        Keep future client-side refreshes from repainting an older
        server bootstrap snapshot.
      */
      window.__ZACH_OPS_BOOTSTRAP__ = summary;

      if (
        !initialSummary ||
        opsSummaryTimestamp(summary) !==
          opsSummaryTimestamp(initialSummary)
      ) {
        paintOpsSummary(layout, summary);
      }

      revealOpsLayout(layout);
    } catch (error) {
      console.warn(
        "Operations rail data unavailable:",
        error
      );

      /*
        If bootstrap/cache existed, leave those real values in place.
        If neither existed, reveal the normal board instead of leaving
        the page permanently hidden.
      */
      revealOpsLayout(layout);
    }
  }
  function boot() {
    render();
    window.setInterval(render, 120000);
    window.addEventListener("resize", syncRailHeight, { passive: true });

    window.addEventListener(
      "zacharologist-live-conditions-updated",
      () => {
        render();
      }
    );

    const spc = document.querySelector(".spc-card");

    if (spc && "ResizeObserver" in window) {
      new ResizeObserver(syncRailHeight).observe(spc);
    }
  }

  boot();
})();
