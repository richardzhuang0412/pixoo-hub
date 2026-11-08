// Talks to a running hub (used by the CLI and the MCP server).
// Where the hub is: env PIXOO_HUB_URL / PIXOO_HUB_TOKEN, else ~/.config/pixoo-hub/client.json {url, token},
// else http://127.0.0.1:8787 with no token (fine on the hub machine itself).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const CLIENT_FILE = join(homedir(), ".config", "pixoo-hub", "client.json");

export function clientConfig(env = process.env) {
  let file = {};
  if (existsSync(CLIENT_FILE)) { try { file = JSON.parse(readFileSync(CLIENT_FILE, "utf8")); } catch { /* ignore */ } }
  const url = (env.PIXOO_HUB_URL || file.url || "http://127.0.0.1:8787").replace(/\/+$/, "");
  return { url, token: env.PIXOO_HUB_TOKEN || file.token || "" };
}

export function saveClientConfig({ url, token }) {
  mkdirSync(dirname(CLIENT_FILE), { recursive: true });
  writeFileSync(CLIENT_FILE, JSON.stringify({ url, token }, null, 2) + "\n", { mode: 0o600 });
}

export class HubClient {
  constructor({ url, token } = clientConfig()) { this.url = url; this.token = token; }

  async call(path, { method = "GET", body } = {}) {
    let res;
    try {
      res = await fetch(this.url + path, {
        method,
        headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new Error(`连不上 Pixoo Hub（${this.url}）：${e.cause?.code ?? e.message}`);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }

  status() { return this.call("/api/status"); }
  now() { return this.call("/api/now"); }
  show(item, { durationSec, persist = false, source = "cli" } = {}) { return this.call("/api/show", { method: "POST", body: { item, durationSec, persist, source } }); }
  base(item) { return this.call("/api/base", { method: "POST", body: { item } }); }
  clear() { return this.call("/api/clear", { method: "POST" }); }
  settings(patch) { return this.call("/api/settings", { method: "POST", body: patch }); }
  schedules() { return this.call("/api/schedules"); }
  addSchedule(s) { return this.call("/api/schedules", { method: "POST", body: s }); }
  removeSchedule(id) { return this.call(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  geocode(q) { return this.call(`/api/geocode?q=${encodeURIComponent(q)}`); }
}

/** "30s" / "5m" / "1h" / "90" (seconds) → seconds; null when empty. */
export function parseDuration(s) {
  if (s == null || s === "") return null;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(String(s).trim());
  if (!m) throw new Error(`看不懂的时长：${s}（比如 30s、5m、1h）`);
  return Math.round(Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[(m[2] ?? "s").toLowerCase()]));
}

/** Image from a local path or an http(s) URL → base64. */
export async function loadImage(src) {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  }
  return readFileSync(src.replace(/^~(?=\/)/, homedir())).toString("base64");
}
