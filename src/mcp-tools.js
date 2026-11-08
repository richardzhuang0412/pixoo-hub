// MCP tool definitions + handlers shared by the stdio server (bin/pixoo-mcp.js) and the hub's own HTTP endpoint (/mcp).
// `hub` is a HubClient (src/client.js).

import sharp from "sharp";
import { loadImage } from "./client.js";

export const SERVER_INFO = { name: "pixoo-hub", version: "0.1.0" };

/** Handles one JSON-RPC request object → response object, or null for a notification. */
export async function handleRpc(hub, msg) {
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null && method?.startsWith("notifications/")) return null;
  try {
    if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "tools/call") {
      try { return { jsonrpc: "2.0", id, result: { content: await callTool(hub, params?.name, params?.arguments ?? {}) } }; }
      catch (e) { return { jsonrpc: "2.0", id, result: { content: [text(`Error: ${e.message}`)], isError: true } }; }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } };
  }
}

const dur = { type: "integer", minimum: 3, maximum: 86400, description: "How many seconds to show it before going back to the base screen (default 30)." };
const keep = { type: "boolean", description: "Make it the always-on base screen instead of a one-off." };

export const TOOLS = [
  {
    name: "pixoo_show_text",
    description: "Show a short message on the Pixoo-64 (64×64 pixel screen). Chinese and English work; short text (≤ ~6 Chinese characters) is drawn big. A few emoji have colour icons: ❤️💧⏰🌙✨😊🍅.",
    inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 300 }, color: { type: "string", description: "Text colour, hex like #ff6f93." }, duration_seconds: dur, keep }, required: ["text"] },
  },
  {
    name: "pixoo_show_image",
    description: "Show a picture or animated GIF from a local file path or an http(s) URL. It is scaled to 64×64.",
    inputSchema: { type: "object", properties: { source: { type: "string", description: "File path or URL." }, fit: { type: "string", enum: ["cover", "contain"] }, duration_seconds: dur, keep }, required: ["source"] },
  },
  {
    name: "pixoo_show_pixel_art",
    description: "Draw pixel art: `rows` is a grid of characters (all rows the same length, at most 64×64), each character is looked up in `palette` (char → hex colour); characters not in the palette are black. The grid is scaled up by a whole number to fill the screen, so 16×16 or 32×32 grids look crisp.",
    inputSchema: {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 64 },
        palette: { type: "object", additionalProperties: { type: "string" } },
        bg: { type: "string", description: "Background colour (hex), default black." },
        duration_seconds: dur, keep,
      },
      required: ["rows", "palette"],
    },
  },
  {
    name: "pixoo_set_base",
    description: "Set the always-on base screen: clock, weather (for the hub's city), countdown (needs target date YYYY-MM-DD and an optional label), lulupet (the LuluPet desktop pet), or blank.",
    inputSchema: { type: "object", properties: { type: { type: "string", enum: ["clock", "weather", "countdown", "lulupet", "blank"] }, target: { type: "string" }, label: { type: "string" }, color: { type: "string" } }, required: ["type"] },
  },
  { name: "pixoo_clear", description: "End the current one-off item and go back to the base screen.", inputSchema: { type: "object", properties: {} } },
  { name: "pixoo_status", description: "What is on the screen now (with a picture of it), the base screen, brightness, quiet hours, LuluPet bridge state.", inputSchema: { type: "object", properties: {} } },
  {
    name: "pixoo_settings",
    description: "Change brightness (0–100), turn the screen on/off, or set the weather city (searched by name).",
    inputSchema: { type: "object", properties: { brightness: { type: "integer", minimum: 0, maximum: 100 }, screen_on: { type: "boolean" }, city: { type: "string" } } },
  },
  {
    name: "pixoo_schedule_add",
    description: "Add a daily schedule at HH:MM (hub's time zone). Either show `text` for duration_seconds, or switch the base screen to `base_type`. days: 0=Sunday … 6=Saturday; empty = every day.",
    inputSchema: {
      type: "object",
      properties: { time: { type: "string", pattern: "^\\d{2}:\\d{2}$" }, days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
        text: { type: "string" }, color: { type: "string" }, base_type: { type: "string", enum: ["clock", "weather", "lulupet", "blank"] }, duration_seconds: dur },
      required: ["time"],
    },
  },
  { name: "pixoo_schedule_list", description: "List the schedules.", inputSchema: { type: "object", properties: {} } },
  { name: "pixoo_schedule_remove", description: "Remove a schedule by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

async function screenshot(hub) {
  const n = await hub.now();
  if (!n.frames?.length) return null;
  const png = await sharp(Buffer.from(n.frames[0], "base64"), { raw: { width: 64, height: 64, channels: 3 } })
    .resize(256, 256, { kernel: "nearest" }).png().toBuffer();
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}

const text = (t) => ({ type: "text", text: t });

async function showResult(hub, item, a) {
  const r = await hub.show(item, { durationSec: a.duration_seconds, persist: !!a.keep, source: "claude" });
  const msg = a.keep ? "Set as the base screen." : r.deferred ? "Quiet hours: it will be shown in the morning." : r.skipped ? "Quiet hours: skipped." : `Showing until ${new Date(r.shownUntil).toLocaleTimeString()}.`;
  const shot = r.deferred || r.skipped ? null : await new Promise((res) => setTimeout(res, 300)).then(() => screenshot(hub)).catch(() => null);
  return [text(msg), ...(shot ? [shot] : [])];
}

export async function callTool(hub, name, a = {}) {
  switch (name) {
    case "pixoo_show_text": return showResult(hub, { type: "text", text: a.text, ...(a.color ? { color: a.color } : {}) }, a);
    case "pixoo_show_image": return showResult(hub, { type: "image", data: await loadImage(a.source), fit: a.fit ?? "cover" }, a);
    case "pixoo_show_pixel_art": return showResult(hub, { type: "art", rows: a.rows, palette: a.palette, ...(a.bg ? { bg: a.bg } : {}) }, a);
    case "pixoo_set_base": {
      const item = { type: a.type, ...(a.target ? { target: a.target } : {}), ...(a.label ? { label: a.label } : {}), ...(a.color ? { color: a.color } : {}) };
      await hub.base(item);
      const shot = await new Promise((res) => setTimeout(res, 400)).then(() => screenshot(hub)).catch(() => null);
      return [text(`Base screen is now ${a.type}.`), ...(shot ? [shot] : [])];
    }
    case "pixoo_clear": await hub.clear(); return [text("Back to the base screen.")];
    case "pixoo_status": {
      const s = await hub.status();
      const lines = [
        `On screen: ${s.shown?.label ?? "—"}${s.oneOff ? ` (one-off until ${new Date(s.oneOff.until).toLocaleTimeString()})` : ""}`,
        `Base: ${s.baseLabel}; brightness ${s.settings.brightness}; screen ${s.settings.screenOn ? "on" : "off"}${s.quiet ? "; quiet hours now" : ""}`,
        `Quiet hours ${s.quietHours.enabled ? `${s.quietHours.start}–${s.quietHours.end} (${s.timezone})` : "off"}; weather city: ${s.settings.location?.name || "not set"}`,
        `LuluPet bridge: ${s.lulupet.connected ? "connected" : "not connected"}; schedules: ${s.schedules}`,
      ];
      const shot = await screenshot(hub).catch(() => null);
      return [text(lines.join("\n")), ...(shot ? [shot] : [])];
    }
    case "pixoo_settings": {
      const patch = {};
      if (a.brightness != null) patch.brightness = a.brightness;
      if (a.screen_on != null) patch.screenOn = a.screen_on;
      if (a.city) {
        const { results } = await hub.geocode(a.city);
        if (!results.length) return [text(`No place found for "${a.city}".`)];
        const r = results[0];
        patch.location = { name: r.name, latitude: r.latitude, longitude: r.longitude };
      }
      await hub.settings(patch);
      return [text(`Updated: ${JSON.stringify(patch)}`)];
    }
    case "pixoo_schedule_add": {
      const isBase = !!a.base_type;
      if (!isBase && !a.text) return [text("Give either text or base_type.")];
      const r = await hub.addSchedule({
        time: a.time, days: a.days ?? [], action: isBase ? "base" : "show",
        item: isBase ? { type: a.base_type } : { type: "text", text: a.text, ...(a.color ? { color: a.color } : {}) },
        durationSec: a.duration_seconds,
      });
      return [text(`Added schedule ${r.schedule.id} at ${r.schedule.time}.`)];
    }
    case "pixoo_schedule_list": {
      const { schedules } = await hub.schedules();
      return [text(schedules.length ? schedules.map((s) => `${s.id} ${s.time} ${s.days.length ? `days ${s.days.join(",")}` : "daily"} ${s.action === "base" ? `base→${s.item.type}` : JSON.stringify(s.item.text ?? s.item.type)}`).join("\n") : "No schedules.")];
    }
    case "pixoo_schedule_remove": {
      const r = await hub.removeSchedule(a.id);
      return [text(r.ok ? "Removed." : "No schedule with that id.")];
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

