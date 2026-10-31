// Current conditions from a free weather service (no API key).
const ICONS = [
  [[0], 'sun', 'moon', 'Clear'],
  [[1, 2], 'cloud-sun', 'cloud-moon', 'Partly cloudy'],
  [[3], 'cloud', 'cloud', 'Cloudy'],
  [[45, 48], 'cloud-fog', 'cloud-fog', 'Fog'],
  [[51, 53, 55, 56, 57], 'cloud-drizzle', 'cloud-drizzle', 'Drizzle'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'cloud-rain', 'cloud-rain', 'Rain'],
  [[71, 73, 75, 77, 85, 86], 'cloud-snow', 'cloud-snow', 'Snow'],
  [[95, 96, 99], 'cloud-lightning', 'cloud-lightning', 'Storm'],
];

function describe(code, isDay) {
  const row = ICONS.find((r) => r[0].includes(code)) || ICONS[2];
  return { icon: isDay ? row[1] : row[2], text: row[3] };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'PocketDeck' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchCurrent(location, unit = 'C') {
  const u = unit === 'F' ? 'fahrenheit' : 'celsius';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lon}` +
    `&current=temperature_2m,weather_code,is_day` +
    `&temperature_unit=${u}&timezone=auto`;
  const data = await getJson(url);
  const c = data.current || {};
  const d = describe(c.weather_code, c.is_day);
  return {
    temp: Math.round(c.temperature_2m),
    unit,
    icon: d.icon,
    text: d.text,
    place: location.name,
    updated: Date.now(),
  };
}

async function geocode(q) {
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=${encodeURIComponent(q)}`);
  return (data.results || []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

// Fetches a website's own icon directly from that website (no third-party icon services).
async function favicon(siteUrl) {
  let base;
  try { base = new URL(/^[a-z]+:/i.test(siteUrl) ? siteUrl : 'https://' + siteUrl); } catch { throw new Error('Not a valid address'); }
  const origin = base.origin;
  const candidates = [];
  try {
    const res = await fetch(origin + '/', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'PocketDeck' } });
    const html = (await res.text()).slice(0, 200000);
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    const scored = [];
    for (const tag of links) {
      const rel = (/rel\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '';
      if (!/icon/i.test(rel)) continue;
      const href = (/href\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
      if (!href) continue;
      const sizes = Number(((/sizes\s*=\s*["'](\d+)x\d+/i.exec(tag)) || [])[1] || (/apple-touch/i.test(rel) ? 180 : 32));
      scored.push({ url: new URL(href, res.url || origin).href, score: sizes + (/\.svg(\?|$)/i.test(href) ? 500 : 0) });
    }
    scored.sort((a, b) => b.score - a.score);
    candidates.push(...scored.map((x) => x.url));
  } catch { /* fall back to the usual locations */ }
  candidates.push(origin + '/apple-touch-icon.png', origin + '/favicon.ico');
  for (const src of candidates) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'PocketDeck' } });
      if (!res.ok) continue;
      const type = (res.headers.get('content-type') || '').split(';')[0] || 'image/png';
      if (!/^image\//.test(type) && !/\.ico(\?|$)/i.test(src)) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100 || buf.length > 2 * 1024 * 1024) continue;
      return `data:${type};base64,${buf.toString('base64')}`;
    } catch { /* try next */ }
  }
  throw new Error('Could not get an icon from that website');
}

module.exports = { fetchCurrent, geocode, favicon };
