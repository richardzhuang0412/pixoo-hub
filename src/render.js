// Content items → 64×64 RGB frames.
//
// Item types (all JSON):
//   {type: "text", text, color?, bg?, size?: "auto"|"big"|"small"}
//   {type: "image", data: <base64 of any image / GIF>, fit?: "cover"|"contain", pixelArt?: bool}
//   {type: "pixels", data: <base64 of 64*64*3 RGB bytes>}               (the drawing board)
//   {type: "art", rows: ["..##..", …], palette: {"#": "#ff0000", …}}     (small pixel art, scaled up; "." / " " = black)
//   {type: "clock", color?, seconds?: false}
//   {type: "countdown", target: "2026-12-23" | ISO time, label?, color?}
//   {type: "weather", color?}                                           (uses the hub's location)
//   {type: "lulupet"}                                                   (frames come from the LuluPet bridge)
//
// render(item, ctx) → {frames: [Uint8Array(12288)…], frameMs, key, nextCheckMs?}
//   key: changes exactly when the picture should change (dynamic items are re-rendered every nextCheckMs and only
//   re-sent when the key changed).

import sharp from "sharp";
import { newFrame, fillRect, setPx, SIZE } from "./lib/canvas.js";
import { tokenize, wrap, width, drawLine } from "./lib/font.js";
import { describeCode } from "./weather.js";

export const FRAME_BYTES = SIZE * SIZE * 3;
export const MAX_FRAMES = 40;
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

export class RenderError extends Error {}

export function parseColor(s, fallback = [255, 255, 255]) {
  if (Array.isArray(s) && s.length === 3) return s.map((v) => Math.max(0, Math.min(255, v | 0)));
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s ?? "").trim());
  if (!m) return fallback;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const WARM = [255, 236, 200];

// ---------- text ----------

/** Lines of text drawn into a 1× scratch frame, then copied `scale`× into `f` with the top-left at (x, y). */
function blitLines(f, font, lines, { x, y, scale = 1, color, align = "center", boxW = SIZE, lineGap = 2 }) {
  const lh = font.lineHeight + lineGap;
  const tmp = { w: SIZE * 2, h: SIZE, data: new Uint8Array(SIZE * 2 * SIZE * 3) };
  let cy = 0;
  for (const line of lines) {
    const w = width(line);
    const lx = align === "center" ? Math.round((boxW / scale - w) / 2) : 0;
    drawLine(tmp, font, line, Math.max(0, lx), cy + font.ascent, [255, 255, 254]);
    cy += lh;
  }
  // copy: pure (255,255,254) = text in `color`; anything else non-black = an icon in its own colour
  for (let ty = 0; ty < Math.min(tmp.h, cy); ty++) {
    for (let tx = 0; tx < tmp.w; tx++) {
      const o = (ty * tmp.w + tx) * 3;
      const r = tmp.data[o], g = tmp.data[o + 1], b = tmp.data[o + 2];
      if (!r && !g && !b) continue;
      const c = r === 255 && g === 255 && b === 254 ? color : [r, g, b];
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) setPx(f, x + tx * scale + dx, y + ty * scale + dy, c);
    }
  }
  return cy * scale;
}

/** Text height in px for `n` lines at `scale`. */
const textH = (font, n, scale, gap = 2) => (n * (font.lineHeight + gap) - gap) * scale;

// closing punctuation never starts a line (禁则): the character before it moves down with it
const NO_START = new Set([..."，。、；：？！）」』》〉】,.;:?!)]}~～…—"]);
const startsBad = (line) => line.length > 0 && line[0].type === "glyph" && NO_START.has(line[0].ch);

export function wrapText(items, maxWidth) {
  let lines = wrap(items, maxWidth);
  const isWordCh = (it) => it?.type === "glyph" && /^[A-Za-z0-9'’]$/.test(it.ch ?? "");
  /** Where the tail to move down starts: the last character, or the start of the latin word it ends. */
  const cut = (line) => {
    let j = line.length - 1;
    while (j > 0 && isWordCh(line[j]) && isWordCh(line[j - 1])) j--;
    return j;
  };
  for (let guard = 0; guard < 50; guard++) {
    const i = lines.findIndex((l, k) => k > 0 && startsBad(l) && cut(lines[k - 1]) > 0);
    if (i < 0) break;
    const j = cut(lines[i - 1]);
    const prev = lines[i - 1].slice(0, j);
    const rest = [...lines[i - 1].slice(j), ...lines.slice(i).flat()];
    lines = [...lines.slice(0, i - 1), prev, ...wrap(rest, maxWidth)];
  }
  return lines;
}

export function layoutText(font, text, size = "auto") {
  const items = tokenize(font, text);
  const tryScale = (scale, maxLines) => {
    const lines = wrapText(items, Math.floor(62 / scale));
    return lines.length <= maxLines ? { scale, lines } : null;
  };
  if (size === "big" || size === "auto") {
    const big = tryScale(2, 2);
    if (big) return { pages: [big.lines], scale: 2 };
    if (size === "big") return { pages: [wrapText(items, 31).slice(0, 2)], scale: 2 };
  }
  const lines = wrapText(items, 62);
  const per = 5;
  const pages = [];
  for (let i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per));
  if (!pages.length) pages.push([[]]);
  return { pages: pages.slice(0, MAX_FRAMES), scale: 1 };
}

function renderText(item, { font }) {
  const color = parseColor(item.color, WARM);
  const bg = parseColor(item.bg, [0, 0, 0]);
  const { pages, scale } = layoutText(font, String(item.text ?? ""), item.size ?? "auto");
  const frames = pages.map((lines) => {
    const f = newFrame();
    if (bg.some(Boolean)) fillRect(f, 0, 0, SIZE, SIZE, bg);
    const h = textH(font, lines.length, scale);
    blitLines(f, font, lines, { x: 0, y: Math.max(0, Math.floor((SIZE - h) / 2)), scale, color });
    return f.data;
  });
  return { frames, frameMs: pages.length > 1 ? 3000 : 1000, key: `text:${item.text}:${item.color}:${item.bg}` };
}

/** Small helper: one line of text centred in a box. */
function centred(f, font, text, y, color, scale = 1) {
  const lines = [tokenize(font, text)];
  blitLines(f, font, lines, { x: 0, y, scale, color });
}

// ---------- images ----------

async function renderImage(item) {
  if (typeof item.data !== "string" || !item.data) throw new RenderError("image 需要 data（base64）");
  const buf = Buffer.from(item.data.replace(/^data:[^,]*,/, ""), "base64");
  if (buf.length > 20 * 1024 * 1024) throw new RenderError("图片太大（最多 20 MB）");
  let meta;
  try { meta = await sharp(buf, { animated: true, limitInputPixels: 4e8 }).metadata(); }
  catch { throw new RenderError("看不懂这个图片格式"); }
  const pages = meta.pages ?? 1;
  const small = Math.max(meta.width ?? 0, meta.pageHeight ?? meta.height ?? 0) <= 64;
  const pixelArt = item.pixelArt ?? small;
  const fit = item.fit === "contain" ? "contain" : "cover";
  const pick = [];
  const n = Math.min(pages, MAX_FRAMES);
  for (let i = 0; i < n; i++) pick.push(Math.floor((i * pages) / n));
  const frames = [];
  for (const p of pick) {
    const raw = await sharp(buf, { page: p, pages: 1, limitInputPixels: 4e8 })
      .rotate()
      .resize(SIZE, SIZE, { fit, kernel: pixelArt ? "nearest" : "lanczos3", background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .removeAlpha()
      .raw()
      .toBuffer();
    frames.push(new Uint8Array(raw));
  }
  const delays = (meta.delay ?? []).filter((d) => d > 0);
  const avg = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : 100;
  // when frames were dropped, each kept frame stands for several
  const frameMs = pages > 1 ? Math.max(50, Math.min(2000, Math.round(avg * (pages / n)))) : 1000;
  return { frames, frameMs, key: `image:${buf.length}:${pages}` };
}

function renderPixels(item) {
  const buf = Buffer.from(String(item.data ?? ""), "base64");
  if (buf.length !== FRAME_BYTES) throw new RenderError(`pixels 需要 ${FRAME_BYTES} 字节（64×64 RGB），收到 ${buf.length}`);
  return { frames: [new Uint8Array(buf)], frameMs: 1000, key: `pixels:${buf.toString("base64").slice(0, 64)}` };
}

function renderArt(item) {
  const rows = Array.isArray(item.rows) ? item.rows.map(String) : [];
  if (!rows.length) throw new RenderError("art 需要 rows");
  const h = rows.length, w = Math.max(...rows.map((r) => [...r].length));
  if (w > SIZE || h > SIZE) throw new RenderError("art 最大 64×64");
  const palette = {};
  for (const [k, v] of Object.entries(item.palette ?? {})) palette[k] = parseColor(v, null);
  const scale = Math.max(1, Math.floor(SIZE / Math.max(w, h)));
  const ox = Math.floor((SIZE - w * scale) / 2), oy = Math.floor((SIZE - h * scale) / 2);
  const f = newFrame();
  if (item.bg) fillRect(f, 0, 0, SIZE, SIZE, parseColor(item.bg, [0, 0, 0]));
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const c = palette[ch];
    if (!c) return;
    fillRect(f, ox + x * scale, oy + y * scale, scale, scale, c);
  }));
  return { frames: [f.data], frameMs: 1000, key: `art:${JSON.stringify(item).length}:${rows.join("|").slice(0, 200)}` };
}

// ---------- time ----------

/** Wall-clock parts in `tz`. */
export function partsIn(tz, now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd };
}

const pad = (n) => String(n).padStart(2, "0");
const msToNextMinute = (now) => 60_000 - (now % 60_000) + 50;

function renderClock(item, { font, tz, now }) {
  const color = parseColor(item.color, WARM);
  const t = partsIn(tz, now);
  const f = newFrame();
  const hhmm = `${pad(t.h)}:${pad(t.mi)}`;
  centred(f, font, hhmm, 14, color, 2);
  centred(f, font, `${t.mo}月${t.d}日 周${WEEK[t.wd]}`, 42, [150, 150, 170]);
  return { frames: [f.data], frameMs: 1000, key: `clock:${hhmm}:${t.d}:${item.color}`, nextCheckMs: msToNextMinute(now) };
}

/** Days from today (in tz) to the target's calendar date; plus the exact ms left for a timed target. */
export function countdownInfo(target, tz, now) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(target));
  const t = partsIn(tz, now);
  const today = Date.UTC(t.y, t.mo - 1, t.d);
  let day;
  let msLeft = null;
  if (dateOnly) {
    const [Y, M, D] = target.split("-").map(Number);
    day = Date.UTC(Y, M - 1, D);
  } else {
    const at = Date.parse(target);
    if (!Number.isFinite(at)) throw new RenderError(`看不懂的日期：${target}`);
    const p = partsIn(tz, at);
    day = Date.UTC(p.y, p.mo - 1, p.d);
    msLeft = at - now;
  }
  return { days: Math.round((day - today) / 86_400_000), msLeft };
}

function renderCountdown(item, { font, tz, now }) {
  const color = parseColor(item.color, [255, 170, 190]);
  const { days, msLeft } = countdownInfo(item.target, tz, now);
  const label = String(item.label ?? "").trim();
  const f = newFrame();
  let big, small;
  if (msLeft != null && msLeft > 0 && msLeft < 86_400_000) {
    const h = Math.floor(msLeft / 3_600_000), m = Math.floor((msLeft % 3_600_000) / 60_000);
    if (h > 0) { big = String(h); small = `小时 ${m} 分`; } else { big = String(Math.max(1, m)); small = "分钟"; }
  } else if (days > 0) { big = String(days); small = "天"; }
  else if (days === 0) { big = "今天"; small = "就是今天！"; }
  else { big = String(-days); small = "天前"; }
  if (label) centred(f, font, label.length > 12 ? label.slice(0, 12) : `${days >= 0 ? "距离" : ""}${label}`, 4, [200, 200, 210]);
  centred(f, font, big, 20, color, 2);
  centred(f, font, small, 48, [200, 200, 210]);
  const key = `countdown:${item.target}:${label}:${big}:${small}`;
  return { frames: [f.data], frameMs: 1000, key, nextCheckMs: msLeft != null && msLeft > 0 && msLeft < 86_400_000 ? msToNextMinute(now) : 10 * 60_000 };
}

// ---------- weather ----------

const ICON_COL = { sun: [255, 200, 40], cloud: [190, 196, 210], dark: [120, 126, 140], rain: [80, 160, 255], snow: [235, 245, 255], bolt: [255, 220, 60] };

function drawSun(f, cx, cy, r) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) setPx(f, cx + x, cy + y, ICON_COL.sun);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    for (let d = r + 2; d <= r + 4; d++) setPx(f, Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d), ICON_COL.sun);
  }
}
function drawCloud(f, x, y, c) {
  const blobs = [[x + 5, y + 6, 4], [x + 10, y + 4, 5], [x + 15, y + 7, 4]];
  for (const [cx, cy, r] of blobs) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) setPx(f, cx + dx, cy + dy, c);
  fillRect(f, x + 2, y + 7, 17, 4, c);
}
export function drawWeatherIcon(f, icon, x, y) {
  switch (icon) {
    case "sun": drawSun(f, x + 10, y + 10, 5); break;
    case "partly": drawSun(f, x + 7, y + 7, 4); drawCloud(f, x + 1, y + 7, ICON_COL.cloud); break;
    case "fog": for (let i = 0; i < 4; i++) fillRect(f, x + 1 + (i % 2) * 2, y + 4 + i * 4, 17, 2, ICON_COL.cloud); break;
    case "rain": drawCloud(f, x + 1, y + 1, ICON_COL.dark); for (let i = 0; i < 4; i++) { setPx(f, x + 4 + i * 4, y + 15, ICON_COL.rain); setPx(f, x + 3 + i * 4, y + 17, ICON_COL.rain); } break;
    case "snow": drawCloud(f, x + 1, y + 1, ICON_COL.cloud); for (let i = 0; i < 4; i++) { const sx = x + 4 + i * 4, sy = y + 16 + (i % 2) * 2; setPx(f, sx, sy, ICON_COL.snow); setPx(f, sx - 1, sy, ICON_COL.snow); setPx(f, sx + 1, sy, ICON_COL.snow); setPx(f, sx, sy - 1, ICON_COL.snow); setPx(f, sx, sy + 1, ICON_COL.snow); } break;
    case "storm": drawCloud(f, x + 1, y + 1, ICON_COL.dark); for (const [dx, dy] of [[10, 13], [9, 14], [8, 15], [10, 15], [11, 15], [10, 16], [9, 17]]) setPx(f, x + dx, y + dy, ICON_COL.bolt); break;
    default: drawCloud(f, x + 1, y + 4, ICON_COL.cloud);
  }
}

async function renderWeather(item, { font, tz, now, weather, location }) {
  const color = parseColor(item.color, WARM);
  const t = partsIn(tz, now);
  const f = newFrame();
  const hhmm = `${pad(t.h)}:${pad(t.mi)}`;
  if (!weather) {
    centred(f, font, hhmm, 10, color, 2);
    centred(f, font, location?.latitude == null ? "还没设置城市" : "天气加载中…", 42, [150, 150, 170]);
    return { frames: [f.data], frameMs: 1000, key: `weather:none:${hhmm}`, nextCheckMs: Math.min(msToNextMinute(now), 30_000) };
  }
  const d = describeCode(weather.code);
  drawWeatherIcon(f, d.icon, 1, 1);
  const deg = `${weather.temp}°`;
  blitLines(f, font, [tokenize(font, deg)], { x: 25, y: 1, scale: 2, color, align: "left" });
  centred(f, font, `${d.text} ${weather.lo}~${weather.hi}°`, 25, [170, 200, 255]);
  centred(f, font, hhmm, 38, color);
  if (location?.name) centred(f, font, location.name.slice(0, 10), 51, [120, 120, 140]);
  return { frames: [f.data], frameMs: 1000, key: `weather:${weather.temp}:${weather.code}:${weather.hi}:${weather.lo}:${hhmm}`, nextCheckMs: msToNextMinute(now) };
}

// ---------- entry ----------

export async function render(item, ctx) {
  if (!item || typeof item !== "object") throw new RenderError("缺少内容");
  switch (item.type) {
    case "text": return renderText(item, ctx);
    case "image": return renderImage(item, ctx);
    case "pixels": return renderPixels(item, ctx);
    case "art": return renderArt(item, ctx);
    case "clock": return renderClock(item, ctx);
    case "countdown": return renderCountdown(item, ctx);
    case "weather": return renderWeather(item, ctx);
    default: throw new RenderError(`不认识的类型：${item.type}`);
  }
}

export const STATIC_TYPES = new Set(["text", "image", "pixels", "art"]);
export const BASE_TYPES = new Set(["clock", "countdown", "weather", "lulupet", "text", "image", "pixels", "art", "blank"]);

/** A short human label for logs / the web page. */
export function describeItem(item) {
  switch (item?.type) {
    case "text": return `文字「${String(item.text ?? "").slice(0, 20)}」`;
    case "image": return "图片";
    case "pixels": return "画板";
    case "art": return "像素画";
    case "clock": return "时钟";
    case "countdown": return `倒计时 ${item.label ?? ""} ${item.target ?? ""}`.trim();
    case "weather": return "天气";
    case "lulupet": return "噜噜";
    case "blank": return "黑屏";
    default: return String(item?.type ?? "?");
  }
}
