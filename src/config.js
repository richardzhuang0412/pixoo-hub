// Hub configuration: a JSON file (default ~/PixooHub/config.json, or --config / PIXOO_HUB_CONFIG) with env overrides.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const HUB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_HOME = join(homedir(), "PixooHub");

export const DEFAULTS = {
  port: 8787,
  host: "0.0.0.0",
  token: "",                       // required for /api/* unless empty (then only localhost may call the API)
  pixoo: { ip: "", url: "", deviceName: "" },
  brightness: 60,
  timezone: "",                    // IANA; empty = system
  location: { name: "", latitude: null, longitude: null },   // for the weather screen
  quietHours: { enabled: true, start: "23:00", end: "08:00", mode: "off", dimBrightness: 5, interrupts: "morning" },
  defaultShowSec: 30,              // how long a one-off item stays before going back to the base screen
  dataDir: "",                     // state.json lives here; default = the config file's folder
  fontFile: "./fonts/fusion-pixel-10px-proportional-zh_hans.bdf",
  logLevel: "info",
};

export class ConfigError extends Error {}

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    if (k.startsWith("_")) continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v;
  }
  return out;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function loadConfig({ file, env = process.env } = {}) {
  const path = resolve(file || env.PIXOO_HUB_CONFIG || join(DEFAULT_HOME, "config.json"));
  let raw = {};
  if (existsSync(path)) {
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { throw new ConfigError(`${path} 不是合法的 JSON：${e.message}`); }
  }
  const c = merge(DEFAULTS, raw);
  if (env.PIXOO_IP) c.pixoo.ip = env.PIXOO_IP;
  if (env.PIXOO_URL) c.pixoo.url = env.PIXOO_URL;
  if (env.PIXOO_HUB_PORT) c.port = Number(env.PIXOO_HUB_PORT);
  if (env.PIXOO_HUB_TOKEN) c.token = env.PIXOO_HUB_TOKEN;
  if (env.PIXOO_HUB_DATA_DIR) c.dataDir = env.PIXOO_HUB_DATA_DIR;

  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new ConfigError(`port 不对：${c.port}`);
  for (const k of ["start", "end"]) if (!HHMM.test(c.quietHours[k])) throw new ConfigError(`quietHours.${k} 要写成 HH:MM`);
  if (!["off", "dim"].includes(c.quietHours.mode)) throw new ConfigError('quietHours.mode 只能是 "off" 或 "dim"');
  if (!["morning", "skip", "show"].includes(c.quietHours.interrupts)) throw new ConfigError('quietHours.interrupts 只能是 "morning" / "skip" / "show"');
  if (c.timezone) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: c.timezone }); } catch { throw new ConfigError(`timezone 不认识：${c.timezone}`); }
  } else c.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  c.configPath = path;
  c.dataDir = resolve(c.dataDir || dirname(path));
  c.fontFile = isAbsolute(c.fontFile) ? c.fontFile : resolve(HUB_DIR, c.fontFile);
  return c;
}

/** The Pixoo endpoint from the config, or null = auto-discover. */
export function endpointFor(pixoo) {
  if (pixoo.url) return pixoo.url;
  if (pixoo.ip) return `http://${pixoo.ip}/post`;
  return null;
}
