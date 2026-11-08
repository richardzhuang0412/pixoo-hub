// Weather from Open-Meteo (free, no key): current temperature + WMO weather code + today's high / low.
// Geocoding (place name → coordinates) uses Open-Meteo's geocoding API too.

const FORECAST = "https://api.open-meteo.com/v1/forecast";
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";

/** WMO weather code → our icon + a short Chinese word. */
export function describeCode(code) {
  if (code === 0) return { icon: "sun", text: "晴" };
  if (code === 1 || code === 2) return { icon: "partly", text: code === 1 ? "晴间多云" : "多云" };
  if (code === 3) return { icon: "cloud", text: "阴" };
  if (code === 45 || code === 48) return { icon: "fog", text: "雾" };
  if (code >= 51 && code <= 57) return { icon: "rain", text: "毛毛雨" };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { icon: "rain", text: code >= 65 && code !== 80 ? "大雨" : "雨" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: "snow", text: "雪" };
  if (code >= 95) return { icon: "storm", text: "雷雨" };
  return { icon: "cloud", text: "" };
}

export async function fetchWeather({ latitude, longitude, unit = "C", fetch: f = globalThis.fetch }) {
  const q = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude),
    current: "temperature_2m,weather_code",
    daily: "temperature_2m_max,temperature_2m_min",
    timezone: "auto", forecast_days: "1",
    temperature_unit: unit === "F" ? "fahrenheit" : "celsius",
  });
  const res = await f(`${FORECAST}?${q}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const j = await res.json();
  const code = j.current?.weather_code;
  return {
    temp: Math.round(j.current?.temperature_2m),
    code,
    hi: Math.round(j.daily?.temperature_2m_max?.[0]),
    lo: Math.round(j.daily?.temperature_2m_min?.[0]),
    unit,
    at: Date.now(),
    ...describeCode(code),
  };
}

export async function geocode(name, { fetch: f = globalThis.fetch } = {}) {
  const q = new URLSearchParams({ name, count: "5", language: "zh", format: "json" });
  const res = await f(`${GEOCODE}?${q}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`);
  const j = await res.json();
  return (j.results ?? []).map((r) => ({
    name: r.name, admin: r.admin1 ?? "", country: r.country ?? "", latitude: r.latitude, longitude: r.longitude, timezone: r.timezone,
  }));
}

/** Caches one location's weather for `ttlMs`; a failed refresh keeps the last good value. */
export class WeatherCache {
  constructor({ ttlMs = 15 * 60_000, fetchFn = fetchWeather, log } = {}) {
    this.ttlMs = ttlMs;
    this.fetchFn = fetchFn;
    this.log = log;
    this.entries = new Map();
  }

  async get(loc, unit = "C") {
    if (loc?.latitude == null || loc?.longitude == null) return null;
    const k = `${loc.latitude},${loc.longitude},${unit}`;
    const e = this.entries.get(k);
    if (e && Date.now() - e.at < this.ttlMs) return e;
    try {
      const w = await this.fetchFn({ latitude: loc.latitude, longitude: loc.longitude, unit });
      this.entries.set(k, w);
      return w;
    } catch (err) {
      this.log?.warn(`weather: ${err.message}`);
      return e ?? null;
    }
  }
}
