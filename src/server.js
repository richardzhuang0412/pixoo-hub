// HTTP server: the phone web page (web/), the JSON API (/api/*) and the Divoom-compatible endpoint (/divoom/post).
//
// Auth: requests from this machine (loopback) are trusted. Everything else needs the token from the config, as
// `Authorization: Bearer <token>`, `X-Pixoo-Token: <token>` or `?token=<token>`. The web page asks for it once.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { HUB_DIR } from "./config.js";
import { render, RenderError, BASE_TYPES, describeItem } from "./render.js";
import { normalizeSchedule, ScheduleError } from "./schedule.js";
import { geocode } from "./weather.js";
import { HubClient } from "./client.js";
import { handleRpc } from "./mcp-tools.js";

const WEB_DIR = join(HUB_DIR, "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
const MAX_BODY = 25 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const isLoopback = (addr) => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

function tokenOk(req, url, token) {
  if (!token) return false;
  const h = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? req.headers["x-pixoo-token"] ?? url.searchParams.get("token") ?? "";
  const a = Buffer.from(String(h)), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJSON(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw new HttpError(413, "内容太大（最多 25 MB）");
    chunks.push(c);
  }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "不是合法的 JSON"); }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function checkItem(item) {
  if (!item || typeof item !== "object" || typeof item.type !== "string") throw new HttpError(400, "缺少 item（比如 {\"type\":\"text\",\"text\":\"你好\"}）");
}

const framesOut = (r) => ({ frameMs: r.frameMs, frames: r.frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.length).toString("base64")) });

export function createHubServer({ cfg, hub, store, compat, font, log }) {
  // MCP tools call this hub's own API over loopback (trusted), so they behave exactly like the CLI
  const mcpHub = new HubClient({ url: `http://127.0.0.1:${cfg.port}`, token: "" });
  const routes = {
    "GET /api/status": async () => hub.status(),

    "GET /api/now": async () => {
      const c = hub.current();
      return c ? { label: c.label, layer: c.layer, ...framesOut(c) } : { label: null, frames: [] };
    },

    // {item, durationSec?, persist?}  persist = make it the base screen
    "POST /api/show": async (_req, body) => {
      checkItem(body.item);
      if (body.persist) {
        if (!BASE_TYPES.has(body.item.type)) throw new HttpError(400, `${body.item.type} 不能当常驻画面`);
        await hub.setBase(body.item);
        return { ok: true, base: describeItem(body.item) };
      }
      const durationMs = body.durationSec != null ? Math.max(3, Math.min(24 * 3600, Number(body.durationSec))) * 1000 : undefined;
      return { ok: true, ...(await hub.show(body.item, { durationMs, source: body.source ?? "api" })) };
    },

    "POST /api/base": async (_req, body) => {
      checkItem(body.item);
      if (!BASE_TYPES.has(body.item.type)) throw new HttpError(400, `${body.item.type} 不能当常驻画面`);
      await hub.setBase(body.item);
      return { ok: true, base: describeItem(body.item) };
    },

    "POST /api/clear": async () => { hub.clear(); return { ok: true }; },

    // render without showing (web page preview)
    "POST /api/preview": async (_req, body) => {
      checkItem(body.item);
      const r = await hub.renderItem(body.item);
      return framesOut(r);
    },

    "POST /api/settings": async (_req, body) => ({ ok: true, settings: await hub.updateSettings(body) }),

    "GET /api/geocode": async (_req, _b, url) => {
      const q = url.searchParams.get("q")?.trim();
      if (!q) throw new HttpError(400, "缺少 q");
      return { results: await geocode(q) };
    },

    "GET /api/schedules": async () => ({ schedules: store.get().schedules }),

    "POST /api/schedules": async (_req, body) => {
      let s;
      try { s = normalizeSchedule(body); } catch (e) { throw new HttpError(400, e.message); }
      if (s.action === "base" && !BASE_TYPES.has(s.item.type)) throw new HttpError(400, `${s.item.type} 不能当常驻画面`);
      if (!["lulupet", "blank", "weather"].includes(s.item.type)) {
        await render(s.item, { font, tz: cfg.timezone, now: Date.now(), weather: null, location: hub.location }).catch((e) => {
          throw e instanceof RenderError ? new HttpError(400, e.message) : e;
        });
      }
      store.update((st) => {
        const i = st.schedules.findIndex((x) => x.id === s.id);
        if (i >= 0) st.schedules[i] = { ...s, lastRun: st.schedules[i].lastRun };
        else st.schedules.push(s);
      });
      return { ok: true, schedule: s };
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://hub");
    const local = isLoopback(req.socket.remoteAddress);
    try {
      // Divoom-compatible endpoint (LuluPet bridge on this machine)
      if (url.pathname === "/divoom/post" && req.method === "POST") {
        if (!local && !tokenOk(req, url, cfg.token)) throw new HttpError(401, "需要 token");
        const body = await readJSON(req);
        let label = req.headers["x-pixoo-label"];
        try { label = label != null ? decodeURIComponent(String(label)) : null; } catch { label = String(label); }
        return send(res, 200, compat.handle(body, label));
      }

      // MCP (Streamable HTTP, JSON responses) so a Claude app can connect by URL: http://<hub>:8787/mcp
      if (url.pathname === "/mcp") {
        if (!local && !tokenOk(req, url, cfg.token)) throw new HttpError(401, "需要 token");
        if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }
        const body = await readJSON(req);
        const msgs = Array.isArray(body) ? body : [body];
        const replies = (await Promise.all(msgs.map((m) => handleRpc(mcpHub, m)))).filter(Boolean);
        if (!replies.length) { res.writeHead(202); return res.end(); }
        return send(res, 200, Array.isArray(body) ? replies : replies[0]);
      }

      if (url.pathname.startsWith("/api/")) {
        if (!local && !tokenOk(req, url, cfg.token)) throw new HttpError(401, cfg.token ? "token 不对" : "这个 hub 没设 token，只能在本机访问");
        const del = /^\/api\/schedules\/([\w-]{1,40})$/.exec(url.pathname);
        if (del && req.method === "DELETE") {
          let found = false;
          store.update((st) => { const n = st.schedules.length; st.schedules = st.schedules.filter((x) => x.id !== del[1]); found = st.schedules.length !== n; });
          return send(res, found ? 200 : 404, { ok: found });
        }
        const h = routes[`${req.method} ${url.pathname}`];
        if (!h) throw new HttpError(404, "没有这个接口");
        const body = req.method === "POST" ? await readJSON(req) : {};
        return send(res, 200, await h(req, body, url));
      }

      // static web page
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
      let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      if (p === "/" || p === "") p = "/index.html";
      const file = join(WEB_DIR, p);
      if (!file.startsWith(WEB_DIR)) throw new HttpError(404, "not found");
      let data;
      try { data = await readFile(file); } catch { throw new HttpError(404, "not found"); }
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      return res.end(data);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof RenderError ? 400 : 500;
      if (status >= 500) log.warn(`${req.method} ${url.pathname}: ${e.stack ?? e.message}`);
      return send(res, status, { ok: false, error: e.message });
    }
  });
  return server;
}
