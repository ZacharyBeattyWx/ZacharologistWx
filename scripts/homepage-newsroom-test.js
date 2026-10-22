/* Seasonal homepage. Existing radar, alerts and operations feeds remain independent. */
(function (root, factory) {
  const data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  else { root.ZachNewsroomData = data; data.boot(root); }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const DEFAULT_LOCATION = { latitude: 36.0726, longitude: -79.792, locationName: 'Greensboro, NC', timeZone: 'America/New_York' };
  const CACHE_KEY = 'zach:newsroom-preview:weather:v1';
  const HOUR = 3600000;
  const ALERT_CATEGORIES=[['all','All'],['storm','Storm'],['winter','Winter'],['hydro','Flood'],['tropical','Tropical'],['fire','Fire'],['other','Other']];
  const QUICK_HIT_BANK = [
  {
    "id": "fact-01",
    "tag": "Great Lakes / Weather explained",
    "title": "A snow band can be surprisingly narrow",
    "text": "Heavy lake-effect snow can fall while sunshine is just a mile or two away. Small shifts in wind direction can move the band and sharply change who gets buried.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/winter-lake-effect-snow"
  },
  {
    "id": "fact-02",
    "tag": "Desert Southwest / Weather explained",
    "title": "A dry wash can flood under a clear sky",
    "text": "Rain upstream can send water rushing into a dry channel far from the storm. Your immediate sky does not tell the whole flooding story.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/flood-hazards"
  },
  {
    "id": "fact-03",
    "tag": "Northern Plains / Weather explained",
    "title": "Wind chill does not change the thermometer",
    "text": "Wind speeds up heat loss from exposed skin. It can also cool objects faster, but wind chill alone does not lower a car or water pipe below the actual air temperature.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/cold-wind-chill-chart"
  },
  {
    "id": "fact-04",
    "tag": "Across the nation / Weather explained",
    "title": "Thunder is rapidly expanding air",
    "text": "Lightning heats the surrounding air extremely quickly. That sudden expansion creates the sound wave you hear as thunder.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/lightning-science-overview"
  },
  {
    "id": "fact-05",
    "tag": "Northern U.S. / Weather explained",
    "title": "A blizzard is about wind and visibility",
    "text": "The NWS definition involves winds of at least 35 mph and snow or blowing snow frequently reducing visibility below a quarter mile for at least three hours.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/winter-snow"
  },
  {
    "id": "fact-06",
    "tag": "Great Plains / Weather explained",
    "title": "Hail grows inside rising air",
    "text": "A thunderstorm updraft lifts water into freezing conditions. A hailstone grows as more liquid drops collide with it and freeze onto its surface.",
    "source": "NOAA / NSSL",
    "href": "https://www.nssl.noaa.gov/education/svrwx101/hail/"
  },
  {
    "id": "fact-07",
    "tag": "Appalachian valleys / Weather explained",
    "title": "Clear nights can help build morning fog",
    "text": "As the ground and nearby air cool overnight, the air can become saturated. Sheltered valleys with light winds are favored places for this kind of fog.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/fog-radiation"
  },
  {
    "id": "fact-08",
    "tag": "Across the nation / Weather explained",
    "title": "A double rainbow reverses the colors",
    "text": "Look closely at the fainter, outer rainbow: its color order is reversed. Red appears along its lower edge, opposite the primary bow.",
    "source": "NOAA / NESDIS",
    "href": "https://www.nesdis.noaa.gov/about/k-12-education/optical-phenomena/rainbow-simulator"
  },
  {
    "id": "fact-09",
    "tag": "Great Lakes / Weather explained",
    "title": "Open water can fuel a snowstorm",
    "text": "Cold air crossing relatively warm, unfrozen lake water picks up heat and moisture. Rising air then forms clouds and narrow bands of snow downwind.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/winter-lake-effect-snow"
  },
  {
    "id": "fact-10",
    "tag": "Cities nationwide / Weather explained",
    "title": "Pavement changes how rain runs off",
    "text": "Concrete and asphalt keep much of the rain from soaking into the ground. That makes urban areas especially vulnerable to rapid runoff and flash flooding.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/flood-hazards"
  },
  {
    "id": "fact-11",
    "tag": "Across the nation / Weather explained",
    "title": "Count the seconds after a flash",
    "text": "Sound takes about five seconds to travel a mile. Dividing the flash-to-thunder delay by five gives a rough distance to the lightning—not a safe-distance guarantee.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/lightning-science-overview"
  },
  {
    "id": "fact-12",
    "tag": "Northern U.S. / Weather explained",
    "title": "Blowing snow does not need fresh snowfall",
    "text": "Wind can lift snow that is already on the ground and reduce visibility. A whiteout can develop without new snow falling at your exact location.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/winter-snow"
  },
  {
    "id": "fact-13",
    "tag": "Great Plains / Weather explained",
    "title": "Hail can have clear and cloudy layers",
    "text": "Drops that freeze quickly trap air bubbles, creating cloudy ice. Slower freezing lets bubbles escape, producing clearer layers within the same hailstone.",
    "source": "NOAA / NSSL",
    "href": "https://www.nssl.noaa.gov/education/svrwx101/hail/"
  },
  {
    "id": "fact-14",
    "tag": "Pacific Coast / Weather explained",
    "title": "Fog can travel with the wind",
    "text": "Advection fog forms when warmer, moist air moves over a colder surface. Unlike calm-night radiation fog, it can develop with clouds and stronger winds.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/fog-advection"
  },
  {
    "id": "fact-15",
    "tag": "Across the nation / Weather explained",
    "title": "Wind chill has a specific range",
    "text": "The NWS wind-chill calculation is defined for air temperatures at or below 50°F and winds above 3 mph. It describes cold-weather heat loss, not every cool breeze.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/cold-wind-chill-chart"
  },
  {
    "id": "fact-16",
    "tag": "Great Lakes / Weather explained",
    "title": "Lake-effect snow can pile up fast",
    "text": "Strong lake-effect bands can produce two to three inches of snow per hour or more. Wind direction and the shape of the shoreline help determine the hardest-hit areas.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/winter-lake-effect-snow"
  },
  {
    "id": "fact-17",
    "tag": "Western mountains / Weather explained",
    "title": "Steep terrain can turn rain into fast runoff",
    "text": "Water moves quickly downhill through steep, narrow valleys. A small mountain creek can respond rapidly when heavy rain falls upstream.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/flood-hazards"
  },
  {
    "id": "fact-18",
    "tag": "Across the nation / Weather explained",
    "title": "Ice helps thunderstorms become electric",
    "text": "Collisions among ice crystals, hail, and other precipitation particles help separate electrical charges inside a storm. Lightning releases that built-up electrical difference.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/lightning-science-overview"
  },
  {
    "id": "fact-19",
    "tag": "Northern U.S. / Weather explained",
    "title": "Flurries and snow showers are different",
    "text": "Flurries are light, brief snow with little or no accumulation. Snow showers vary in intensity and can leave measurable accumulation.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/winter-snow"
  },
  {
    "id": "fact-20",
    "tag": "California / Weather explained",
    "title": "Tule fog is a Central Valley specialty",
    "text": "California's winter tule fog forms with moist air near the surface, clear skies above, and light winds. The thick fog can be visible from satellites.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/fog-radiation"
  },
  {
    "id": "fact-21",
    "tag": "Great Plains / Weather explained",
    "title": "Hail falls when the updraft loses its grip",
    "text": "A hailstone reaches the ground when rising air can no longer support its weight. The stone may become too large, or the updraft may weaken.",
    "source": "NOAA / NSSL",
    "href": "https://www.nssl.noaa.gov/education/svrwx101/hail/"
  },
  {
    "id": "fact-22",
    "tag": "Western U.S. / Weather explained",
    "title": "A burn scar can change a watershed",
    "text": "Wildfire can remove vegetation and alter the soil. Rain may run off more readily, increasing the chance of flooding and debris flows after the flames are gone.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/flood-hazards"
  },
  {
    "id": "fact-23",
    "tag": "Cold-weather country / Weather explained",
    "title": "Wind chill is a heat-loss measure",
    "text": "The wind-chill index describes how wind and cold combine to remove heat from people and animals. Higher wind speeds can make exposed skin lose heat faster.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/cold-wind-chill-chart"
  },
  {
    "id": "fact-24",
    "tag": "Across the nation / Weather explained",
    "title": "A lightning flash does not have to hit the ground",
    "text": "Lightning can discharge between different charged regions inside a thunderstorm cloud. Cloud-to-ground strikes are only one part of a storm's electrical activity.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/lightning-science-overview"
  },
  {
    "id": "fact-25",
    "tag": "Pacific Coast / Weather explained",
    "title": "Some fog can linger for days",
    "text": "As moist air keeps moving over a colder surface, advection fog can persist and drift across the landscape. It is particularly common along the West Coast.",
    "source": "NOAA / NWS",
    "href": "https://www.weather.gov/safety/fog-advection"
  }
];
  function dailyQuickHits(now=Date.now()) {
    const date=new Date(now);
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
    const part=type=>parts.find(p=>p.type===type).value;
    const key=part('year')+'-'+part('month')+'-'+part('day');
    const day=Math.floor(Date.UTC(Number(part('year')),Number(part('month'))-1,Number(part('day')))/86400000);
    const start=((day*7)%QUICK_HIT_BANK.length+QUICK_HIT_BANK.length)%QUICK_HIT_BANK.length;
    return {key,label:new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric'}).format(date),
      slides:Array.from({length:5},(_,i)=>QUICK_HIT_BANK[(start+i)%QUICK_HIT_BANK.length])};
  }
  function forecastIcon(text='') {
    const sun='<g stroke="#ffd15c" stroke-width="2" stroke-linecap="round"><path d="M16 2v3m0 22v3M2 16h3m22 0h3M6 6l2 2m16 16 2 2M6 26l2-2M24 8l2-2"/><circle cx="16" cy="16" r="7" fill="#ffd15c" stroke="none"/></g>';
    const cloud='<path d="M8 23a6 6 0 0 1-1-12 8 8 0 0 1 15-1 6.5 6.5 0 1 1 2 13Z" fill="#d9e3eb"/>';
    let art;
    if(/thunder|lightning/i.test(text)) art=cloud+'<path d="m17 18-5 8h5l-2 6 10-11h-6l3-3Z" fill="#ffbc45"/>';
    else if(/snow|sleet|freez|wintr|\\bice\\b/i.test(text)) art=cloud+'<g stroke="#ace5ff" stroke-width="1.8" stroke-linecap="round"><path d="M11 25v6m-3-4.5 6 3m-6 0 6-3M24 25v6m-3-4.5 6 3m-6 0 6-3"/></g>';
    else if(/rain|shower|drizzle/i.test(text)) art=cloud+'<path d="m10 26-2 4m10-4-2 4m10-4-2 4" stroke="#66baff" stroke-width="2.4" stroke-linecap="round"/>';
    else if(/partly|mostly sunny|mostly clear|few clouds/i.test(text)) art='<g transform="translate(-2 -3) scale(.85)">'+sun+'</g>'+cloud;
    else if(/clear|sunny/i.test(text)) art=sun;
    else art=cloud;
    return '<svg viewBox="0 0 34 34" width="34" height="34" aria-hidden="true" focusable="false">'+art+'</svg>';
  }
  function alertCategory(event='') {
    if(/hurricane|tropical|storm surge|typhoon/i.test(event))return 'tropical';
    if(/flood|hydrologic/i.test(event))return 'hydro';
    if(/winter|snow|ice storm|blizzard|freez|frost|wind chill|extreme cold|cold weather|avalanche/i.test(event))return 'winter';
    if(/red flag|fire weather|fire warning/i.test(event))return 'fire';
    if(/tornado|thunderstorm|special marine|marine weather|special weather statement/i.test(event))return 'storm';
    return 'other';
  }
  function filteredAlerts(alerts,category='all',now=Date.now()) {
    const seen=new Set();
    return (alerts || []).filter(a=>{
      const p=a?.properties || {},expiry=Date.parse(p.ends || p.expires || '');
      if(Number.isFinite(expiry) && expiry<=now)return false;
      if(!p.event || (category!=='all' && alertCategory(p.event)!==category))return false;
      const key=p._canonicalId || a.id || p.id || `${p.event}|${p.areaDesc}|${p.sent}`;
      if(seen.has(key))return false;seen.add(key);return true;
    });
  }
  function alertPriority(alert) {
    const event=alert?.properties?.event || '';
    if(event==='Tornado Warning')return 0;
    if(event==='Severe Thunderstorm Warning')return 1;
    if(event==='Flash Flood Warning')return 2;
    if(/Warning$/.test(event))return 3;
    if(/Watch$/.test(event))return 4;
    return 5;
  }
  const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rounded = value => num(value) === null ? null : Math.round(value);
  const deg = value => num(value) === null ? null : `${Math.round(value)}°`;
  const dateLabel = (value, zone) => new Date(value).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone });
  const dayKey = (value, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(value));
  const localMonth = (now, zone) => Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, month:'numeric' }).format(new Date(now)));
  const coldSeason = (now, zone) => { const month = localMonth(now, zone); return month >= 10 || month <= 3; };
  const min = values => { const valid = values.filter(v => num(v) !== null); return valid.length ? Math.min(...valid) : null; };
  const max = values => { const valid = values.filter(v => num(v) !== null); return valid.length ? Math.max(...valid) : null; };
  function quantity(q, kind) {
    const value = num(q?.value);
    if (value === null) return null;
    const unit = String(q.unitCode || '');
    if (kind === 'temp') return unit.endsWith('degF') ? value : value * 9 / 5 + 32;
    if (kind === 'wind') return unit.endsWith('km_h-1') ? value / 1.609344 : unit.endsWith('mi_h-1') ? value : unit.endsWith('kn') ? value * 1.15078 : value * 2.236936;
    if (kind === 'pressure') return unit.endsWith('Pa') ? value * 0.0002953 : null;
    if (kind === 'distance') return unit.endsWith('m') ? value / 1609.344 : null;
    return value;
  }
  function windPeak(text) {
    const values = String(text || '').match(/\d+(?:\.\d+)?/g);
    return values ? Math.max(...values.map(Number)) : null;
  }
  function normalizeNwsForecast(payload, zone, now = Date.now()) {
    const periods = (payload?.properties?.periods || []).filter(p => Date.parse(p.endTime) > now && num(p.temperature) !== null);
    const byDay = new Map();
    for (const p of periods) {
      const key = dayKey(p.startTime, zone);
      const value = p.temperatureUnit === 'C' ? p.temperature * 9 / 5 + 32 : p.temperature;
      const day = byDay.get(key) || { date:key, high:null, low:null, pop:null, wind:null, text:'', nights:[] };
      if (p.isDaytime) { day.high = value; day.text = p.shortForecast || day.text; }
      else { day.low = value; day.nights.push({value, name:p.name, time:p.startTime}); if (!day.text) day.text = p.shortForecast || ''; }
      day.pop = max([day.pop, num(p.probabilityOfPrecipitation?.value)]);
      day.wind = max([day.wind, windPeak(p.windSpeed)]);
      byDay.set(key, day);
    }
    return { days:[...byDay.values()].slice(0,7), source:'NWS', issuedAt:payload?.properties?.updateTime || payload?.properties?.generatedAt, endTime:periods.at(-1)?.endTime, periods };
  }
  function normalizeObservation(payload, stationName) {
    const p = payload?.properties || {};
    const observed = Date.parse(p.timestamp);
    if (!Number.isFinite(observed)) return null;
    return { source:'NWS observation', stationName:p.station?.split('/').pop() || stationName, timestamp:p.timestamp,
      temp:quantity(p.temperature,'temp'), feels:quantity(p.windChill,'temp') ?? quantity(p.heatIndex,'temp') ?? quantity(p.temperature,'temp'),
      dew:quantity(p.dewpoint,'temp'), humidity:num(p.relativeHumidity?.value), wind:quantity(p.windSpeed,'wind'),
      gust:quantity(p.windGust,'wind'), pressure:quantity(p.barometricPressure,'pressure'), visibility:quantity(p.visibility,'distance'),
      description:p.textDescription || 'Station observation', direction:num(p.windDirection?.value) };
  }
  const weatherText = code => ({0:'Clear',1:'Mostly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Freezing fog',51:'Light drizzle',53:'Drizzle',55:'Drizzle',56:'Freezing drizzle',57:'Freezing drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',66:'Freezing rain',67:'Freezing rain',71:'Light snow',73:'Snow',75:'Heavy snow',77:'Snow grains',80:'Rain showers',81:'Rain showers',82:'Heavy showers',85:'Snow showers',86:'Snow showers',95:'Thunderstorms',96:'Thunderstorms / hail',99:'Thunderstorms / hail'}[code] || 'Forecast');
  function normalizeModel(payload) {
    const d = payload?.daily || {}, current = payload?.current || {};
    const days = (d.time || []).map((date,i) => ({ date, high:num(d.temperature_2m_max?.[i]), low:num(d.temperature_2m_min?.[i]), pop:num(d.precipitation_probability_max?.[i]), wind:num(d.wind_speed_10m_max?.[i]), gust:num(d.wind_gusts_10m_max?.[i]), precip:num(d.precipitation_sum?.[i]), snow:num(d.snowfall_sum?.[i])===null?null:d.snowfall_sum[i]/(payload.daily_units?.snowfall_sum==='inch'?1:2.54), text:weatherText(d.weather_code?.[i]), sunrise:d.sunrise?.[i], sunset:d.sunset?.[i] }));
    return { days, source:'Open-Meteo model', timeZone:payload?.timezone, issuedAt:new Date().toISOString(), observation:num(current.temperature_2m) === null ? null : { source:'Open-Meteo model estimate', timestamp:Number.isFinite(current.time) ? new Date(current.time*1000).toISOString() : null, temp:num(current.temperature_2m), feels:num(current.apparent_temperature), dew:null, humidity:num(current.relative_humidity_2m), wind:num(current.wind_speed_10m), gust:num(current.wind_gusts_10m), pressure:num(current.surface_pressure) === null ? null : current.surface_pressure * 0.02953, visibility:null, direction:num(current.wind_direction_10m), description:weatherText(current.weather_code) } };
  }
  function forecastUsable(forecast, now) {
    if (!forecast?.days?.length) return false;
    const issued = Date.parse(forecast.issuedAt || '');
    return Number.isFinite(issued) && issued <= now + HOUR && now - issued < 18 * HOUR;
  }
  function validLocation(loc) { return num(loc?.latitude) !== null && num(loc?.longitude) !== null && Math.abs(loc.latitude) <= 90 && Math.abs(loc.longitude) <= 180; }
  function sameLocation(a,b) { return validLocation(a) && validLocation(b) && Math.abs(a.latitude-b.latitude) < 0.01 && Math.abs(a.longitude-b.longitude) < 0.01; }
  function chooseForecast(nws, model, now = Date.now()) { return forecastUsable(nws,now) ? nws : forecastUsable(model,now) ? model : null; }
  function availableDays(forecast, zone, now) { const today=dayKey(now,zone); return (forecast?.days || []).filter(d=>d.date >= today).slice(0,7); }
  function sourceNote(forecast, days) { return `${forecast.source} • through ${days.at(-1)?.date || ''}`; }
  function stat(label, value, note) { return {label,value,note}; }
  function buildStats(forecast, model, observation, location, now = Date.now()) {
    const zone=location.timeZone || DEFAULT_LOCATION.timeZone;
    const cold=coldSeason(now,zone), days=availableDays(forecast,zone,now);
    if (!days.length) {
      // Useful, honestly named observation or location facts if forecasts are down.
      const candidates = [
        stat('Temperature',deg(observation?.temp),observation?.source),
        stat('Feels like',deg(observation?.feels),observation?.source),
        stat('Dew point',deg(observation?.dew),observation?.source),
        stat('Humidity',num(observation?.humidity)===null?null:`${rounded(observation.humidity)}%`,observation?.source),
        stat('Wind',num(observation?.wind)===null?null:`${rounded(observation.wind)} mph`,observation?.source),
        stat('Pressure',num(observation?.pressure)===null?null:`${observation.pressure.toFixed(2)} in`,observation?.source)
      ].filter(s=>s.value!==null);
      const facts=[stat('Forecast area',location.locationName,'Selected location'),stat('Latitude',`${location.latitude.toFixed(2)}°`,'Forecast point'),stat('Longitude',`${location.longitude.toFixed(2)}°`,'Forecast point'),stat('Local time zone',zone.replaceAll('_',' '),'Local forecast times')];
      return {cold,days,stats:[...candidates,...facts].slice(0,6),note:observation?'Latest conditions while the forecast refreshes':'Local reference while weather feeds reconnect'};
    }
    const note=sourceNote(forecast,days), lowest=min(days.map(d=>d.low)), highest=max(days.map(d=>d.high));
    const nights=(forecast.periods || []).filter(p=>!p.isDaytime && Date.parse(p.endTime)>now);
    const nextNight=nights[0];
    const nightTemp=nextNight ? (nextNight.temperatureUnit==='C'?nextNight.temperature*9/5+32:nextNight.temperature) : days[0].low;
    const freeze=days.find(d=>num(d.low)!==null && d.low<=32);
    const first=stat(nextNight?.name || 'Forecast low',deg(nightTemp) || deg(lowest),note);
    const freezeStat=freeze?stat('Next freeze',dateLabel(`${freeze.date}T12:00:00`,zone),`${deg(freeze.low)} forecast low • ${forecast.source}`):stat('Coldest forecast low',deg(lowest) || deg(highest),`${lowest===null?'Temperature outlook': 'No freeze in available lows'} • through ${days.at(-1).date} • ${forecast.source}`);
    const modelDays=forecastUsable(model,now)?availableDays(model,zone,now):[];
    const aligned=modelDays.filter(d=>days.some(n=>n.date===d.date));
    const precip=aligned.length===days.length && aligned.every(d=>num(d.precip)!==null)?aligned.reduce((sum,d)=>sum+d.precip,0):null;
    const snow=aligned.length===days.length && aligned.every(d=>num(d.snow)!==null)?aligned.reduce((sum,d)=>sum+d.snow,0):null;
    const wet=max(days.map(d=>d.pop)), wind=max(days.map(d=>d.wind)), gust=max(aligned.map(d=>d.gust));
    const tempRange=stat('Forecast temperature range',lowest!==null&&highest!==null?`${Math.round(lowest)}–${Math.round(highest)}°`:deg(highest??lowest),note);
    const wetStat=stat('Peak precipitation chance',wet===null?null:`${Math.round(wet)}%`,note);
    const snowStat=snow!==null?stat('Model snowfall total',`${snow.toFixed(1)} in`,`Open-Meteo • ${aligned.length} calendar days • not a probability`):wetStat;
    const windStat=gust!==null?stat('Peak model gust',`${Math.round(gust)} mph`,'Open-Meteo • forecast period'):stat('Peak forecast wind',wind===null?null:`${Math.round(wind)} mph`,note);
    const rainStat=precip!==null?stat('Model precipitation total',`${precip.toFixed(2)} in`,`Open-Meteo • ${aligned.length} calendar days • liquid equivalent`):wetStat;
    const stats = cold?[first,freezeStat,tempRange,snowStat,windStat,rainStat]:[stat('Warmest forecast high',deg(highest),note),first,tempRange,wetStat,windStat,rainStat];
    const fallback=[stat('Forecast days',String(days.length),forecast.source),stat('Forecast area',location.locationName,'Selected location')];
    return {cold,days,stats:stats.map((s,i)=>s.value===null?fallback[i%fallback.length]:s),note};
  }
  function boot(win) {
    const doc=win.document;
    let requestId=0, state=null, lastAttempt=0, activeLocation={...DEFAULT_LOCATION};
    let activeController=null;
    const $=selector=>doc.querySelector(selector);
    const safeRead=key=>{ try{return JSON.parse(win.localStorage.getItem(key));}catch{return null;} };
    const safeWrite=(key,value)=>{try{win.localStorage.setItem(key,JSON.stringify(value));}catch{/* Private browsing: keep memory state. */}};
    const setText=(selector,value)=>{const el=$(selector);if(el && el.textContent!==String(value))el.textContent=value;};
    const stamp=(time,zone)=>new Date(time).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:zone});
    function renderWeather(next, isSaved=false) {
      const now=Date.now(), location=next.location;
      const zone=location.timeZone || DEFAULT_LOCATION.timeZone;
      const forecast=chooseForecast(next.nws,next.model,now);
      const observed=next.observation && now-Date.parse(next.observation.timestamp)<3*HOUR && now-Date.parse(next.observation.timestamp)>-HOUR ? next.observation : null;
      const estimate=next.model?.observation;
      const modelCurrent=estimate && now-Date.parse(estimate.timestamp)<2*HOUR ? estimate : null;
      const current=observed || modelCurrent;
      const snapshot=buildStats(forecast,next.model,current,location,now);
      doc.body.dataset.weatherSeason=snapshot.cold?'cold':'warm';
      setText('#newsSeason',snapshot.cold?'FALL / WINTER':'SPRING / SUMMER');
      setText('#newsStatsTitle',`${location.locationName} / ${snapshot.cold?'Cold season':'Warm season'} stats`);
      setText('#newsForecastTitle',`${location.locationName} / Your week ahead`);
      const cachedPrefix=isSaved?'Saved forecast • ':'';
      setText('#newsForecastStatus',forecast?`${cachedPrefix}${forecast.source} • updated ${stamp(forecast.issuedAt,zone)}`:'Forecast reconnecting • local references below');
      const forecastLink=`https://forecast.weather.gov/MapClick.php?lat=${location.latitude}&lon=${location.longitude}`;
      $('#newsHourlyLink').href=forecastLink+'&unit=0&lg=english&FcstType=graphical';
      $('#newsOfficialLink').href=forecastLink;
      setText('#newsLocationName',location.locationName);
      setText('#currentLocation',location.locationName);
      setText('#conditionsLabel',`${location.locationName} / Conditions`);
      const metrics=[['currentTemp',deg(current?.temp)],['currentFeelsLike',deg(current?.feels)],['currentWind',num(current?.wind)===null?null:`${rounded(current.wind)} mph`],['currentGust',num(current?.gust)===null?null:`${rounded(current.gust)} mph`],['currentDewpoint',deg(current?.dew)],['currentHumidity',num(current?.humidity)===null?null:`${rounded(current.humidity)}%`],['currentPressure',num(current?.pressure)===null?null:`${current.pressure.toFixed(2)} in`],['currentVisibility',num(current?.visibility)===null?null:`${current.visibility.toFixed(1)} mi`]];
      for(const [id,value] of metrics){
        const el=doc.getElementById(id);if(!el)continue;
        const label=el.closest('[data-news-condition]')?.querySelector('span');
        const original=el.dataset.metricLabel;
        if(value!==null){setText(`#${id}`,value);if(label && original)label.textContent=original;el.title=current.source;}
        else {
          // Replace a missing metric with a related, explicitly renamed forecast metric.
          const replacement=id==='currentGust'?snapshot.stats.find(s=>/wind|gust/i.test(s.label)):id==='currentDewpoint'?snapshot.stats.find(s=>/precipitation chance/i.test(s.label)):null;
          const alt=replacement || snapshot.stats[metrics.findIndex(m=>m[0]===id)%snapshot.stats.length];
          setText(`#${id}`,alt?.value || location.locationName);if(label)label.textContent=alt?.label || 'Forecast area';el.title=alt?.note || 'Selected location';
        }
      }
      setText('#currentCondition',current?.description || 'Forecast desk');
      setText('#newsConditionsStatus',current?`${isSaved?'Saved • ':''}${current.source}${observed?.stationName?` • ${observed.stationName}`:''} • ${stamp(current.timestamp,zone)}`:'Showing labeled forecast and location references');
      $('#newsStats').innerHTML=snapshot.stats.map(s=>`<article class="news-stat"><span>${esc(s.label)}</span><strong>${esc(s.value)}</strong><small>${esc(s.note)}</small></article>`).join('');
      $('#newsWeek').innerHTML=snapshot.days.length?snapshot.days.map(d=>`<article class="news-day"><h3>${esc(new Date(`${d.date}T12:00:00`).toLocaleDateString('en-US',{weekday:'short'}))}</h3><small>${esc(d.date.slice(5))}</small><span class="news-weather-symbol" aria-hidden="true">${forecastIcon(d.text)}</span><div class="news-day-temps">${d.high!==null?`<strong>${esc(deg(d.high))}</strong>`:'<span class="news-night-only">Night forecast</span>'}${d.low!==null?`<span>${esc(deg(d.low))}</span>`:''}</div><p>${esc(d.text)}</p><small>${d.pop!==null?`${rounded(d.pop)}% precip`:'See detailed forecast'}${d.wind!==null?` · ${rounded(d.wind)} mph`:''}</small></article>`).join(''):`<div class="news-reconnect"><strong>Keep an eye on the bigger picture.</strong><p>Your local forecast is reconnecting. The outlooks and national monitoring below remain available.</p><a href="${esc(forecastLink)}">Open the official local forecast ↗</a></div>`;
      setText('#newsTickerTemp',deg(current?.temp) || snapshot.stats[0]?.value || 'Forecast');
      setText('#newsTickerDetail',current?.description || `${snapshot.days.length} forecast days`);
      setText('#newsTickerWind',num(current?.wind)===null?snapshot.stats.find(s=>/wind|gust/i.test(s.label))?.value || 'Local forecast':`${rounded(current.wind)} mph`);
      // Do not write estimated weather into the existing observation cache.
      if(observed){
        const cachedObservation=safeRead('zach_preview_live_conditions_cache');
        const observationCache={...location,tempText:deg(observed.temp),conditionText:observed.description,windText:observed.wind===null?null:`${rounded(observed.wind)} mph`,dewpointText:deg(observed.dew),humidityText:observed.humidity===null?null:`${rounded(observed.humidity)}%`,pressureText:observed.pressure===null?null:`${observed.pressure.toFixed(2)} in`,updatedAt:observed.timestamp};
        safeWrite('zach_preview_live_conditions_cache',observationCache);
        if(!sameLocation(cachedObservation,location) || cachedObservation?.updatedAt!==observed.timestamp)win.dispatchEvent(new win.CustomEvent('zacharologist-live-conditions-updated',{detail:observationCache}));
      }
      setText('#newsStatsCoverage',snapshot.note);
    }
    async function json(url,signal){ const response=await win.fetch(url,{signal,headers:{Accept:'application/geo+json, application/json'}});if(!response.ok)throw new Error(`Weather feed: ${response.status}`);return response.json(); }
    async function load(location) {
      if(!validLocation(location))return;
      const id=++requestId;
      activeController?.abort();activeController=new AbortController();
      const {signal}=activeController;
      const controller=activeController;
      const timeout=win.setTimeout(()=>controller.abort(),22000);
      activeLocation={...location};lastAttempt=Date.now();
      const previous=state && sameLocation(state.location,location)?state:null;
      state=previous || {location};renderWeather(state,!!previous);
      setText('#newsLocationStatus','Updating local forecast…');
      const modelUrl=new URL('https://api.open-meteo.com/v1/forecast');
      modelUrl.search=new URLSearchParams({latitude:location.latitude,longitude:location.longitude,timezone:'auto',temperature_unit:'fahrenheit',wind_speed_unit:'mph',precipitation_unit:'inch',forecast_days:'7',timeformat:'unixtime',current:'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max'}).toString();
      const modelTask=json(modelUrl.href,signal).then(payload=>{
        // Unix timestamps ensure model estimates are correctly dated across time zones.
        if(Array.isArray(payload.daily?.time))payload.daily.time=payload.daily.time.map(t=>dayKey(t*1000,payload.timezone || location.timeZone));
        const normalized=normalizeModel(payload);
        if(!normalized.days.length)throw new Error('Model forecast contains no days');
        return normalized;
      });
      const nwsTask=(async()=>{
        const point=await json(`https://api.weather.gov/points/${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`,signal);
        const p=point.properties || {};
        const resolved={...location,timeZone:p.timeZone || location.timeZone};
        if(!location.customName && p.relativeLocation?.properties?.city)resolved.locationName=`${p.relativeLocation.properties.city}, ${p.relativeLocation.properties.state}`;
        const forecastTask=p.forecast?json(p.forecast,signal).then(f=>{const normalized=normalizeNwsForecast(f,resolved.timeZone);if(!normalized.days.length)throw new Error('NWS forecast contains no periods');return normalized;}):Promise.reject(new Error('Forecast URL missing'));
        const obsTask=(async()=>{
          if(!p.observationStations)return null;
          const stations=await json(p.observationStations,signal);
          for(const station of (stations.features || []).slice(0,4)){
            if(!station.id)continue;
            try{const obs=normalizeObservation(await json(`${station.id}/observations/latest`,signal),station.properties?.stationIdentifier);if(obs && obs.temp!==null && Date.now()-Date.parse(obs.timestamp)<3*HOUR)return obs;}catch(error){if(signal.aborted)throw error;}
          }
          return null;
        })();
        const [forecast,observation]=await Promise.allSettled([forecastTask,obsTask]);
        return {location:resolved,nws:forecast.status==='fulfilled'?forecast.value:null,observation:observation.status==='fulfilled'?observation.value:null};
      })();
      // Paint independent feeds as soon as each is ready; a slow source cannot hold the page blank.
      const commit=part=>{if(id!==requestId)return;const valid=Object.fromEntries(Object.entries(part).filter(([,v])=>v!==null));state={...state,...valid,location:{...state.location,...part.location}};renderWeather(state);};
      const results=await Promise.allSettled([modelTask.then(model=>commit({model,location:{timeZone:model.timeZone || location.timeZone}})),nwsTask.then(part=>commit(part))]);
      win.clearTimeout(timeout);
      if(id!==requestId)return;
      if(results.every(r=>r.status==='rejected'))setText('#newsLocationStatus','Connection interrupted • keeping recent data and useful references');
      else setText('#newsLocationStatus',`Forecast point: ${state.location.locationName}`);
      activeLocation={...state.location};safeWrite('zach:newsroom-preview:location',activeLocation);
      if(state.nws || state.model || state.observation)safeWrite(CACHE_KEY,{...state,savedAt:Date.now()});
    }
    function setupLocation(){
      const cached=safeRead('zach:newsroom-preview:location') || safeRead('zach_preview_live_conditions_cache');
      activeLocation=validLocation(cached)?{...DEFAULT_LOCATION,...cached}:{...DEFAULT_LOCATION};
      const cache=safeRead(CACHE_KEY);
      if(cache && sameLocation(cache.location,activeLocation) && num(cache.savedAt)!==null && Date.now()-cache.savedAt<18*HOUR && Date.now()>=cache.savedAt){state=cache;renderWeather(state,true);}
      load(activeLocation);
      // The page works immediately at the saved/default location; permission is requested only on a click.
      const use=$('#useLocationBtn');
      if(typeof win.requestUserLocation==='function')use.removeEventListener('click',win.requestUserLocation);
      use.addEventListener('click',()=>{
        if(!win.navigator.geolocation){setText('#newsLocationStatus','Using your selected forecast point. Search for another city below.');return;}
        setText('#newsLocationStatus','Finding your forecast point…');
        win.navigator.geolocation.getCurrentPosition(p=>load({latitude:p.coords.latitude,longitude:p.coords.longitude,locationName:'Your location',timeZone:activeLocation.timeZone}),()=>setText('#newsLocationStatus','Keeping your selected location. You can also search by city.'),{timeout:10000,maximumAge:300000});
      });
      $('#newsLocationForm').addEventListener('submit',async event=>{
        event.preventDefault();const name=$('#newsLocationInput').value.trim();if(!name)return;
        const button=$('#newsLocationForm button');button.disabled=true;
        setText('#newsLocationStatus','Searching places…');
        try{
          const result=await json(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({name,count:'6',language:'en',format:'json',countryCode:'US'})}`);
          const places=result.results || [];const list=$('#newsLocationResults');
          list.innerHTML=places.map((p,i)=>`<button type="button" data-place="${i}">${esc(p.name)}, ${esc(p.admin1 || p.country)} <small>${esc(p.country_code)}</small></button>`).join('');
          if(!places.length)setText('#newsLocationStatus','No match. Try a nearby city or ZIP code.');
          else setText('#newsLocationStatus','Choose your forecast location:');
          list.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{const p=places[Number(b.dataset.place)];list.replaceChildren();load({latitude:p.latitude,longitude:p.longitude,locationName:`${p.name}, ${p.admin1 || p.country}`,timeZone:p.timezone || DEFAULT_LOCATION.timeZone,customName:true});}));
        }catch{setText('#newsLocationStatus','Search is reconnecting. Your current forecast point is unchanged.');}finally{button.disabled=false;}
      });
      win.setInterval(()=>{if(!doc.hidden)load(activeLocation);},10*60000);
      doc.addEventListener('visibilitychange',()=>{if(!doc.hidden && Date.now()-lastAttempt>10*60000)load(activeLocation);});
      win.addEventListener('online',()=>load(activeLocation));
    }
    function setupAlerts(){
      const categories=ALERT_CATEGORIES;let selected='all',failed=false,expanded=false;
      const list=$('#alertsList'),tabs=$('.alerts-card .alert-tabs');
      const mobileAlerts=win.matchMedia('(max-width:768px)');
      win.getFilteredAlertsForCategory=category=>filteredAlerts(win.__ZACH_HOMEPAGE_ALERTS__ || [],category);
      tabs.innerHTML=categories.map(([key,label])=>`<button type="button" data-category="${key}" aria-pressed="${key==='all'}">${label}<span data-news-panel-count="${key}">…</span></button>`).join('');
      $('#newsAlertScore').innerHTML=`<a class="news-alert-label" href="live-alerts-test.html">Active alerts ↗</a><span class="news-alert-scope">Monitoring area</span>${categories.filter(([key])=>key!=='all').map(([key,label])=>`<button type="button" data-news-category="${key}">${label} <strong data-news-alert="${key}">…</strong></button>`).join('')}`;
      const status=doc.createElement('p');status.className='news-alert-status news-source';tabs.parentNode.insertAdjacentElement('afterend',status);
      function draw(){
        const ready=!!win.__ZACH_HOMEPAGE_ALERTS_UPDATED__;
        const all=win.getFilteredAlertsForCategory('all');
        const selectedAlerts=win.getFilteredAlertsForCategory(selected).sort((a,b)=>alertPriority(a)-alertPriority(b));
        for(const [key] of categories){const count=ready?win.getFilteredAlertsForCategory(key).length:'…';setText(`[data-news-panel-count="${key}"]`,count);setText(`[data-news-alert="${key}"]`,count);}
        tabs.querySelectorAll('button').forEach(b=>{b.classList.toggle('active',b.dataset.category===selected);b.setAttribute('aria-pressed',String(b.dataset.category===selected));});
        $('#newsAlertScore').dataset.urgent=String(all.some(a=>alertPriority(a)<3));
        const time=ready?new Date(win.__ZACH_HOMEPAGE_ALERTS_UPDATED__).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'';
        setText('.news-alert-scope',ready?`Monitoring area • ${time}`:'Monitoring area');
        status.textContent=ready?`${all.length} active products across the monitoring area • ${failed?'Saved snapshot':'Updated'} ${time} • not limited to your selected city`:'NWS monitoring area • checking current products';
        if(!ready){list.innerHTML=`<div class="news-alert-empty"><strong>${failed?'Continue with live monitoring':'Checking the monitoring area'}</strong><p>${failed?'The feed is reconnecting. Open the alert explorer or national alert map for the latest products.':'Warnings, watches and advisories will appear here as the feed arrives.'}</p><a href="live-alerts-test.html">Open alert explorer ↗</a></div>`;return;}
        if(!selectedAlerts.length){list.innerHTML=`<div class="news-alert-empty"><strong>No active ${selected==='all'?'':categories.find(([k])=>k===selected)[1].toLowerCase()+' '}products</strong><p>No matching products in the latest monitoring-area snapshot.</p><a href="live-alerts-test.html">Open all monitored alerts ↗</a></div>`;return;}
        const limit=mobileAlerts.matches&&!expanded?6:24;
        list.innerHTML=selectedAlerts.slice(0,limit).map(alert=>{
          const p=alert.properties;
          const color=typeof win.getAlertColor==='function'?win.getAlertColor(p.event):'#8bd9ef';
          const expires=Date.parse(p.ends || p.expires || '');
          const expireLabel=Number.isFinite(expires)?new Date(expires).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'}):'See bulletin for timing';
          const href=typeof win.homepageAlertDetailsUrl==='function'?win.homepageAlertDetailsUrl(alert):'live-alerts-test.html';
          return `<article class="news-alert-row" style="--alert-color:${esc(color)}"><div><strong>${esc(p.event)}</strong><p>${esc(p.areaDesc || p.headline || 'See official bulletin for affected areas')}</p><small>${Number.isFinite(expires)?'Until ':''}${esc(expireLabel)}</small></div><a href="${esc(href)}">Details ↗</a></article>`;
        }).join('')+(selectedAlerts.length>limit&&limit===6?`<button type="button" class="news-expand-alerts" aria-expanded="false">Show more alerts (${selectedAlerts.length-6}) ↓</button>`:'')+(selectedAlerts.length>24&&limit===24?`<a class="news-more-alerts" href="live-alerts-test.html">View all ${selectedAlerts.length} matching products ↗</a>`:'');
      }
      list.addEventListener('click',event=>{if(event.target.closest('.news-expand-alerts')){expanded=true;draw();}});
      mobileAlerts.addEventListener('change',()=>{expanded=false;draw();});
      win.renderCategory=()=>draw();
      tabs.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{selected=b.dataset.category;expanded=false;draw();}));
      $('#newsAlertScore').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{selected=b.dataset.newsCategory;expanded=false;draw();$('.alerts-card').scrollIntoView({behavior:'smooth',block:'start'});}));
      win.addEventListener('zacharologist-homepage-alerts-updated',()=>{failed=false;draw();});
      win.addEventListener('zacharologist-homepage-alerts-failed',()=>{failed=true;win.queueMicrotask(draw);});
      draw();
    }
    function setupCarousel(){
      let selection=dailyQuickHits(),slides=selection.slides;
      let slide=0, paused=false, hover=false, focused=false;
      const region=$('#newsQuickHits');
      function show(index){
        slide=(index+slides.length)%slides.length;const item=slides[slide];
        $('#newsQuickContent').innerHTML=`<p class="news-kicker">${esc(item.tag)}</p><h3>${esc(item.title)}</h3><p>${esc(item.text)}</p><a href="${esc(item.href)}" target="_blank" rel="noopener">Read more at ${esc(item.source)} ↗</a>`;
        setText('#newsSlideCount',`${String(slide+1).padStart(2,'0')} / ${String(slides.length).padStart(2,'0')}`);
        region.querySelectorAll('[data-news-slide]').forEach((b,i)=>b.setAttribute('aria-pressed',String(slide===i)));
      }
      function syncDaily(){
        const next=dailyQuickHits();if(next.key===selection.key)return false;
        selection=next;slides=next.slides;setText('#newsQuickDaily','Daily facts • '+selection.label);show(0);return true;
      }
      $('#newsQuickPrev').addEventListener('click',()=>{syncDaily();show(slide-1);});
      $('#newsQuickNext').addEventListener('click',()=>{syncDaily();show(slide+1);});
      region.querySelectorAll('[data-news-slide]').forEach((b,i)=>b.addEventListener('click',()=>{syncDaily();show(i);}));
      const pause=$('#newsQuickPause');pause.addEventListener('click',()=>{paused=!paused;pause.textContent=paused?'Resume rotation':'Pause rotation';pause.setAttribute('aria-pressed',String(paused));});
      region.addEventListener('mouseenter',()=>hover=true);region.addEventListener('mouseleave',()=>hover=false);
      region.addEventListener('focusin',()=>focused=true);region.addEventListener('focusout',e=>focused=region.contains(e.relatedTarget));
      doc.addEventListener('visibilitychange',()=>{if(!doc.hidden)syncDaily();});
      win.addEventListener('pageshow',syncDaily);
      win.setInterval(()=>{if(syncDaily())return;if(!paused && !hover && !focused && !doc.hidden && !win.matchMedia('(prefers-reduced-motion: reduce)').matches)show(slide+1);},14000);
      setText('#newsQuickDaily','Daily facts • '+selection.label);show(0);
    }
    function install(){
      const main=$('main.forecast-dashboard');if(!main || $('#weatherNewsroom'))return;
      doc.body.classList.add('newsroom-home');
      const brand=$('.brand-main');if(brand && !brand.querySelector('.news-wx'))brand.insertAdjacentHTML('beforeend',' <span class="news-wx">WX</span>');
      const root=doc.createElement('div');root.id='weatherNewsroom';root.className='newsroom';
      root.innerHTML=`
        <section class="news-scoreboard" aria-label="Selected location weather"><a href="#newsLocal"><span id="newsLocationName">Greensboro, NC</span><strong id="newsTickerTemp">Forecast desk</strong><small id="newsTickerDetail">Connecting weather feeds</small></a><a href="#newsLocal"><span>Wind / forecast</span><strong id="newsTickerWind">Local outlook</strong></a><a href="#newsWeekPanel"><span>Local forecast</span><strong>Your week ahead ↗</strong></a><a href="storm-reports.html"><span>Across the nation</span><strong>Storm reports ↗</strong></a><span class="news-season" id="newsSeason">Seasonal monitoring</span></section>
        <section class="news-alert-score" id="newsAlertScore" aria-label="Alerts across the monitoring area"></section>
        <div class="news-lead-grid"><section class="news-briefing" id="newsBriefing" aria-labelledby="newsLeadTitle"><p class="news-kicker">What I’m watching</p><h1 id="newsLeadTitle">The forecast.<br>The details.<br>The bigger picture.</h1><div id="newsDiscussion"></div><a class="news-discussion-link" href="wx-updates.html">Read my latest discussion ↗</a><p class="news-editor-note">Local forecasts. National awareness. Built for the Storm.</p></section><div id="newsRadarSlot"></div></div>
        <section class="news-local news-panel" id="newsLocal" aria-label="Local weather"><div id="newsConditionsSlot"></div><form id="newsLocationForm" class="news-location-form"><label for="newsLocationInput">Forecast location</label><input id="newsLocationInput" name="location" type="search" placeholder="City or ZIP code" autocomplete="off"><button type="submit">Find location</button><span id="newsLocationStatus" role="status">Using Greensboro unless you choose another location</span></form><div id="newsLocationResults" class="news-location-results"></div><p id="newsConditionsStatus" class="news-source"></p></section>
        <section class="news-panel news-season-stats" id="newsSeasonStats"><div class="news-panel-heading"><h2 id="newsStatsTitle">Local / Seasonal stats</h2><span id="newsStatsCoverage" class="news-source">Local forecast point</span></div><div id="newsStats" class="news-stats" aria-live="polite"></div></section>
        <section class="news-panel" id="newsWeekPanel"><div class="news-panel-heading"><h2 id="newsForecastTitle">Your week ahead</h2><a id="newsHourlyLink" href="https://forecast.weather.gov/">View hourly ↗</a></div><p class="news-mobile-forecast-hint">Swipe for all seven days →</p><div id="newsWeek" class="news-week" tabindex="0" aria-label="Daily forecast; scroll to see all days"></div><div class="news-forecast-footer"><span id="newsForecastStatus" class="news-source"></span><a id="newsOfficialLink" href="https://forecast.weather.gov/">Official local forecast ↗</a></div></section>
        <div class="news-analysis-grid"><section class="news-outlooks news-panel"><div class="news-panel-heading"><h2>Outlook center</h2><span class="news-source">National / regional</span></div><div class="news-outlook-tabs" aria-label="Official outlook products"><a href="maps.html#winter">Winter weather ↗</a><a href="maps.html#severe">SPC outlooks ↗</a><a href="maps.html#rainfall">Rainfall ↗</a><a href="wx-updates.html#nationalClimateOutlookSection">6–10 day ↗</a></div><div id="newsSpcSlot"></div></section><div id="newsAlertsSlot"></div></div>
        <section class="news-panel news-quick-hits" id="newsQuickHits" aria-roledescription="carousel" aria-label="National Quick Hits"><div class="news-panel-heading"><h2>National Quick Hits</h2><div class="news-carousel-controls"><span id="newsSlideCount">01 / 05</span><button id="newsQuickPrev" aria-label="Previous quick hit" type="button">‹</button><button id="newsQuickNext" aria-label="Next quick hit" type="button">›</button></div></div><div id="newsQuickContent"></div><div class="news-carousel-footer"><div class="news-dots">${[0,1,2,3,4].map(i=>`<button type="button" data-news-slide="${i}" aria-label="Show quick hit ${i+1}" aria-pressed="false"></button>`).join('')}</div><button type="button" id="newsQuickPause" aria-pressed="false">Pause rotation</button><span id="newsQuickDaily" class="news-source">Daily facts / coast to coast</span></div></section>
        <div class="news-panel-heading news-monitor-heading"><h2>National weather desk</h2><span class="news-source">Preliminary SPC reports • current SPC day & month • sun & moon • national monitoring</span></div>
        <footer class="news-footer">Zacharologist Wx / Built for the Storm <span>Weather: <a href="https://www.weather.gov/">NOAA / NWS</a> · Model estimates & place search: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>. Forecast ranges and sources are shown with each metric.</span></footer>`;
      main.insertBefore(root,main.firstChild);
      // Move existing elements, not copies: their data bindings, popups and iframe engine survive.
      const radar=$('.radar-card'),conditions=$('.ops-conditions-card'),spc=$('.spc-card'),alerts=$('.alerts-card');
      if(radar)$('#newsRadarSlot').appendChild(radar);
      $('#newsRadarSlot').setAttribute('aria-label','Live radar');
      if(spc)$('#newsSpcSlot').appendChild(spc);
      if(alerts)$('#newsAlertsSlot').appendChild(alerts);
      const mobileNav=doc.createElement('nav');mobileNav.className='news-mobile-nav';mobileNav.setAttribute('aria-label','Homepage sections');mobileNav.innerHTML='<a href="#newsLocal">Today</a><a href="#newsRadarSlot">Radar</a><a href="#newsAlertsSlot">Alerts</a><a href="#newsNationalAlerts">Alert map</a>';root.appendChild(mobileNav);
      if(conditions){
        $('#newsConditionsSlot').appendChild(conditions);
        const temp=$('#currentTemp');const existing=conditions.querySelector('.conditions-grid');
        const tile=doc.createElement('div');tile.setAttribute('data-news-condition','');tile.innerHTML='<span>Temperature</span>';tile.appendChild(temp);existing.prepend(tile);
        const additions=[['Feels like','currentFeelsLike'],['Gusts','currentGust'],['Visibility','currentVisibility']];
        for(const [label,id] of additions)existing.insertAdjacentHTML('beforeend',`<div data-news-condition><span>${label}</span><strong id="${id}">Connecting</strong></div>`);
        for(const el of existing.children){el.setAttribute('data-news-condition','');const value=el.querySelector('strong');if(value)value.dataset.metricLabel=el.querySelector('span')?.textContent || '';}
      }
      const oldDiscussion=$('.forecast-status-card p');if(oldDiscussion)$('#newsDiscussion').appendChild(oldDiscussion);
      const oldLayout=$('.ops-reference-layout');if(oldLayout){oldLayout.classList.add('news-monitor-grid');root.insertBefore(oldLayout,$('.news-footer'));}
      setupCarousel();setupAlerts();setupLocation();
      // Legacy weather-desk buttons must target the replacement GIS outlook panel.
      root.addEventListener('click',event=>{if(event.target.closest('[data-ops-reference-scroll="spc"]'))$('#newsSpcSlot')?.scrollIntoView({behavior:'smooth',block:'start'});});
      // Keep the dynamically inserted storm-report summary, including mobile, in the monitoring grid.
      const placeReports=()=>{const card=$('#mobile-home-storm-reports-card-panel-v2');if(card && oldLayout && card.parentNode!==oldLayout)oldLayout.appendChild(card);};
      placeReports();win.setTimeout(placeReports,1500);
    }
    if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',install,{once:true});else install();
  }
  return { DEFAULT_LOCATION, dailyQuickHits, num, quantity, windPeak, normalizeNwsForecast, normalizeObservation, normalizeModel, forecastUsable, chooseForecast, buildStats, sameLocation, coldSeason, dayKey, alertCategory, filteredAlerts, alertPriority, boot };
});

