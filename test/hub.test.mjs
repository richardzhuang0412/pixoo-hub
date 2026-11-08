import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { PixelFont } from "../src/lib/font.js";
import { HUB_DIR, DEFAULTS } from "../src/config.js";
import { Hub, inQuietHours } from "../src/hub.js";
import { Store } from "../src/store.js";
import { DivoomCompat } from "../src/divoom-compat.js";
import { normalizeSchedule } from "../src/schedule.js";
import { layoutText, countdownInfo } from "../src/render.js";
import { silentLogger as log } from "../src/lib/log.js";

const font = PixelFont.load(join(HUB_DIR, "fonts/fusion-pixel-10px-proportional-zh_hans.bdf"));
const TZ = "America/New_York";
const at = (iso) => Date.parse(iso);

function makeHub(startIso, cfgPatch = {}) {
  let t = at(startIso);
  const shown = [];
  const device = {
    stats: {},
    async playAnimation(frames, frameMs, label) { shown.push(label); return true; },
    async setScreen(on) { shown.push(on ? "SCREEN ON" : "SCREEN OFF"); },
    async setBrightness() {},
  };
  const cfg = { ...structuredClone(DEFAULTS), timezone: TZ, ...cfgPatch };
  const store = new Store(mkdtempSync(join(tmpdir(), "hub-")), { log });
  const hub = new Hub({ cfg, device, font, store, weather: { get: async () => null }, log, now: () => t });
  const step = async (ms = 0) => { t += ms; await hub.cycle(); };
  return { hub, shown, step, store, advance: (ms) => { t += ms; } };
}

const luluFrames = [new Uint8Array(64 * 64 * 3)];

test("one-off item shows, then the base screen comes back", async () => {
  const { hub, shown, step } = makeHub("2026-11-08T14:00:00-05:00");
  await step();
  assert.equal(shown.at(-1), "时钟");
  await hub.show({ type: "text", text: "晚安" }, { durationMs: 10_000 });
  await step();
  assert.equal(shown.at(-1), "文字「晚安」");
  await step(5_000);
  assert.equal(shown.filter((x) => x === "文字「晚安」").length, 1, "not re-sent while unchanged");
  await step(6_000);
  assert.equal(shown.at(-1), "时钟");
});

test("clock re-renders only when the minute changes", async () => {
  const { shown, step } = makeHub("2026-11-08T14:00:10-05:00");
  await step();
  await step(20_000);
  assert.equal(shown.filter((x) => x === "时钟").length, 1);
  await step(40_000);
  assert.equal(shown.filter((x) => x === "时钟").length, 2);
});

test("LuluPet: idle animations feed the lulupet base, messages interrupt any base", async () => {
  const { hub, shown, step } = makeHub("2026-11-08T14:00:00-05:00");
  await step();
  hub.onLuluAnimation({ frames: luluFrames, frameMs: 100, label: "idle:online:lulu:classic:x" });
  await step();
  assert.equal(shown.at(-1), "时钟", "idle does not replace a clock base");
  hub.onLuluAnimation({ frames: luluFrames, frameMs: 100, label: "poke" });
  await step();
  assert.equal(shown.at(-1), "噜噜：poke");
  hub.onLuluAnimation({ frames: luluFrames, frameMs: 100, label: "idle:online:lulu:classic:x" });
  await step();
  assert.equal(shown.at(-1), "时钟", "message ends when the bridge goes idle");
  await hub.setBase({ type: "lulupet" });
  await step();
  assert.equal(shown.at(-1), "噜噜");
});

test("LuluPet: messages can be turned off unless lulupet is the base", async () => {
  const { hub, shown, step } = makeHub("2026-11-08T14:00:00-05:00");
  await hub.updateSettings({ luluInterrupts: false });
  await step();
  hub.onLuluAnimation({ frames: luluFrames, frameMs: 100, label: "sticker:hug" });
  await step();
  assert.equal(shown.at(-1), "时钟");
});

test("quiet hours: screen off, one-offs wait for the morning", async () => {
  const { hub, shown, step } = makeHub("2026-11-08T23:30:00-05:00");
  await step();
  assert.ok(shown.includes("SCREEN OFF"));
  const r = await hub.show({ type: "text", text: "晚安" });
  assert.equal(r.deferred, true);
  await step(9 * 3600_000);   // 08:30
  assert.ok(shown.includes("SCREEN ON"));
  assert.equal(shown.at(-1), "文字「晚安」");
});

test("schedules fire once a day at their time", async () => {
  const { hub, shown, step, store } = makeHub("2026-11-09T08:59:00-05:00");   // Monday
  store.update((s) => { s.schedules.push(normalizeSchedule({ time: "09:00", days: [1], item: { type: "text", text: "早安" }, durationSec: 60 })); });
  await step();
  assert.equal(shown.at(-1), "时钟");
  await step(60_000);
  assert.equal(shown.at(-1), "文字「早安」");
  await step(2 * 60_000);
  await step(1000);
  assert.equal(shown.filter((x) => x === "文字「早安」").length, 1);
  void hub;
});

test("Divoom-compatible endpoint assembles animations", () => {
  const got = [];
  const c = new DivoomCompat({ onAnimation: (a) => got.push(a) });
  const frame = Buffer.alloc(64 * 64 * 3, 7).toString("base64");
  assert.equal(c.handle({ Command: "Draw/ResetHttpGifId" }).error_code, 0);
  for (let i = 0; i < 3; i++) c.handle({ Command: "Draw/SendHttpGif", PicNum: 3, PicWidth: 64, PicOffset: i, PicID: 1, PicSpeed: 120, PicData: frame }, "poke");
  assert.equal(got.length, 1);
  assert.equal(got[0].frames.length, 3);
  assert.equal(got[0].frameMs, 120);
  assert.equal(got[0].label, "poke");
  assert.equal(c.handle({ Command: "Draw/SendHttpGif", PicNum: 2, PicWidth: 64, PicOffset: 1, PicID: 1, PicSpeed: 1, PicData: frame }).error_code, 1, "out of order");
});

test("quiet hours across midnight", () => {
  const qh = { enabled: true, start: "23:00", end: "08:00" };
  assert.equal(inQuietHours(qh, TZ, at("2026-11-08T23:10:00-05:00")), true);
  assert.equal(inQuietHours(qh, TZ, at("2026-11-09T07:59:00-05:00")), true);
  assert.equal(inQuietHours(qh, TZ, at("2026-11-09T08:00:00-05:00")), false);
});

test("text layout: short text is big, punctuation never starts a line", () => {
  assert.equal(layoutText(font, "晚安").scale, 2);
  const { pages } = layoutText(font, "今天考试加油！晚上一起视频，等你下课～");
  for (const p of pages) for (const line of p.slice(1)) assert.ok(!"，。！～".includes(line[0]?.ch ?? ""));
});

test("countdown counts calendar days in the hub's time zone", () => {
  assert.equal(countdownInfo("2026-12-23", TZ, at("2026-11-08T23:59:00-05:00")).days, 45);
  assert.equal(countdownInfo("2026-11-08", TZ, at("2026-11-08T10:00:00-05:00")).days, 0);
});
