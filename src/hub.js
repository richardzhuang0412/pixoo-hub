// What is on the Pixoo right now, decided in one place so the web page, the CLI, Claude, schedules and LuluPet never
// fight over the screen.
//
// Layers, highest first:
//   1. quiet hours (screen off, or dimmed with the base screen)
//   2. one-off item ("show"): text / photo / drawing / … for durationMs, then back to the base. A newer one replaces it.
//      LuluPet messages are one-off items too (they end when the bridge goes back to its idle animation).
//   3. base screen: clock / countdown / weather / LuluPet idle / a picture … (persisted). Dynamic ones re-render on
//      their own schedule and are re-sent only when the picture changes.

import { render, describeItem, RenderError, partsIn } from "./render.js";
import { dueSchedules } from "./schedule.js";
import { newFrame } from "./lib/canvas.js";

const LULU_MSG_MAX_MS = 120_000;    // a LuluPet message never holds the screen longer than this without an idle

export function inQuietHours(qh, tz, now) {
  if (!qh?.enabled) return false;
  const t = partsIn(tz, now);
  const m = t.h * 60 + t.mi;
  const [sh, sm] = qh.start.split(":").map(Number);
  const [eh, em] = qh.end.split(":").map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em;
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

const isLuluIdle = (label) => typeof label === "string" && /^(idle|night)(:|$)/.test(label);

export class Hub {
  constructor({ cfg, device, font, store, weather, log, now = () => Date.now() }) {
    this.cfg = cfg;
    this.device = device;
    this.font = font;
    this.store = store;
    this.weather = weather;
    this.log = log;
    this.now = now;
    this.oneOff = null;        // {id, item, label, rendered, until, source}
    this.deferred = [];        // one-offs that arrived during quiet hours (shown in the morning)
    this.lulu = { idle: null, lastAt: 0, connected: false };
    this.baseRendered = null;  // {key, frames, frameMs, nextAt}
    this.pushedKey = null;
    this.shown = null;         // what the screen shows: {label, layer, frames, frameMs, at, until}
    this.quiet = null;         // last known quiet state
    this.screen = { on: null, brightness: null };
    this.busy = false;
    this.again = false;
    this.retryAt = 0;
    this.seq = 0;
    this.listeners = new Set();
  }

  // ---------- public API ----------

  get settings() { return this.store.get().settings; }
  get location() { return this.settings.location ?? this.cfg.location; }
  get brightness() { return this.settings.brightness ?? this.cfg.brightness; }

  start() {
    this.timer = setInterval(() => this.kick(), 1000);
    this.kick();
  }

  stop() { clearInterval(this.timer); }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Renders `item` (throws RenderError for bad input) and shows it for `durationMs` (default config), then the base. */
  async show(item, { durationMs, source = "api" } = {}) {
    const rendered = await this.renderItem(item);
    const dur = durationMs ?? this.cfg.defaultShowSec * 1000;
    const entry = { id: ++this.seq, item, label: describeItem(item), rendered, durationMs: dur, source };
    if (this.isQuiet() && source !== "manual-night") {
      const mode = this.cfg.quietHours.interrupts;
      if (mode === "skip") { this.log.info(`quiet hours: skip ${entry.label}`); return { deferred: false, skipped: true }; }
      if (mode === "morning") { this.deferred.push(entry); this.log.info(`quiet hours: ${entry.label} → morning`); return { deferred: true }; }
    }
    this.startOneOff(entry);
    return { shownUntil: this.oneOff.until };
  }

  /** Sets (and persists) the base screen. */
  async setBase(item) {
    if (item.type !== "lulupet" && item.type !== "blank") await this.renderItem(item);   // validate now
    this.store.update((s) => { s.base = item; });
    this.baseRendered = null;
    if (!this.oneOff) this.pushedKey = null;
    this.log.info(`base → ${describeItem(item)}`);
    this.kick();
    this.emit();
  }

  clear() {
    if (this.oneOff) this.log.info(`clear ${this.oneOff.label}`);
    this.oneOff = null;
    this.pushedKey = null;
    this.kick();
    this.emit();
  }

  async updateSettings(patch) {
    this.store.update((s) => {
      const st = s.settings;
      if (patch.brightness != null) st.brightness = Math.max(0, Math.min(100, Math.round(Number(patch.brightness))));
      if (patch.screenOn != null) st.screenOn = !!patch.screenOn;
      if (patch.unit === "C" || patch.unit === "F") st.unit = patch.unit;
      if (patch.luluInterrupts != null) st.luluInterrupts = !!patch.luluInterrupts;
      if (patch.location !== undefined) st.location = patch.location;
    });
    if (patch.location !== undefined || patch.unit) { this.baseRendered = null; this.pushedKey = null; }
    this.kick();
    this.emit();
    return this.settings;
  }

  /** One complete animation from the LuluPet bridge (via the Divoom-compatible endpoint). */
  onLuluAnimation({ frames, frameMs, label }) {
    this.lulu.lastAt = this.now();
    this.lulu.connected = true;
    const base = this.store.get().base;
    if (label == null) {
      // an old bridge that does not say what it sends: only usable as the base screen
      this.lulu.idle = { frames, frameMs, label: "lulupet" };
      if (base.type === "lulupet") { this.pushedKey = null; this.kick(); }
      return;
    }
    if (isLuluIdle(label)) {
      this.lulu.idle = { frames, frameMs, label };
      if (this.oneOff?.source === "lulupet") this.oneOff = null;
      if (base.type === "lulupet") this.pushedKey = null;
      this.kick();
      this.emit();
      return;
    }
    if (!this.settings.luluInterrupts && base.type !== "lulupet") { this.log.info(`lulupet: ${label} (interrupts off)`); return; }
    const entry = {
      id: ++this.seq, item: { type: "lulupet" }, label: `噜噜：${label}`, source: "lulupet",
      rendered: { frames, frameMs, key: `lulu:${this.seq}` }, durationMs: LULU_MSG_MAX_MS,
    };
    if (this.isQuiet()) {
      if (this.cfg.quietHours.interrupts === "morning") { entry.durationMs = 25_000; this.deferred.push(entry); }
      return;
    }
    this.startOneOff(entry);
  }

  /** Snapshot for the web page / CLI. */
  status() {
    const s = this.store.get();
    return {
      shown: this.shown && { label: this.shown.label, layer: this.shown.layer, at: this.shown.at, until: this.shown.until ?? null },
      oneOff: this.oneOff && { label: this.oneOff.label, source: this.oneOff.source, until: this.oneOff.until },
      base: s.base,
      baseLabel: describeItem(s.base),
      quiet: this.isQuiet(),
      deferred: this.deferred.length,
      settings: { ...s.settings, brightness: this.brightness, location: this.location },
      quietHours: this.cfg.quietHours,
      timezone: this.cfg.timezone,
      lulupet: { connected: this.lulu.connected, lastAt: this.lulu.lastAt || null, hasIdle: !!this.lulu.idle },
      device: this.device.stats ?? null,
      schedules: s.schedules.length,
    };
  }

  /** Frames on screen now (for the preview). */
  current() {
    if (!this.shown) return null;
    return { label: this.shown.label, layer: this.shown.layer, frameMs: this.shown.frameMs, frames: this.shown.frames };
  }

  // ---------- internals ----------

  emit() { for (const fn of this.listeners) { try { fn(); } catch { /* ignore */ } } }

  isQuiet() { return inQuietHours(this.cfg.quietHours, this.cfg.timezone, this.now()); }

  async renderItem(item) {
    const ctx = { font: this.font, tz: this.cfg.timezone, now: this.now(), location: this.location, weather: null };
    if (item.type === "weather") ctx.weather = await this.weather.get(this.location, this.settings.unit);
    if (item.type === "lulupet") {
      const idle = this.lulu.idle;
      if (idle) return { frames: idle.frames, frameMs: idle.frameMs, key: `lulu-idle:${idle.label}:${this.lulu.lastAt}` };
      return render({ type: "text", text: "等噜噜上线…", size: "small", color: "#8888aa" }, ctx).then((r) => ({ ...r, key: "lulu-wait", nextCheckMs: 5000 }));
    }
    if (item.type === "blank") return { frames: [newFrame().data], frameMs: 1000, key: "blank" };
    return render(item, ctx);
  }

  startOneOff(entry) {
    entry.until = this.now() + entry.durationMs;
    this.oneOff = entry;
    this.pushedKey = null;
    this.log.info(`show ${entry.label} (${Math.round(entry.durationMs / 1000)} s, from ${entry.source})`);
    this.kick();
    this.emit();
  }

  /** Runs `cycle` now, or right after the running one. */
  kick() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    (async () => {
      do {
        this.again = false;
        try { await this.cycle(); }
        catch (e) { this.log.warn(`hub: ${e.message}`); }
      } while (this.again);
      this.busy = false;
    })();
  }

  async cycle() {
    const now = this.now();

    // schedules
    const st = this.store.get();
    const due = dueSchedules(st.schedules, this.cfg.timezone, now);
    if (due.length) {
      this.store.save();
      for (const s of due) {
        this.log.info(`schedule ${s.id} ${s.time}: ${s.action} ${describeItem(s.item)}`);
        try {
          if (s.action === "base") await this.setBase(s.item);
          else await this.show(s.item, { durationMs: (s.durationSec ?? this.cfg.defaultShowSec) * 1000, source: "schedule" });
        } catch (e) { this.log.warn(`schedule ${s.id}: ${e.message}`); }
      }
    }

    // screen power / brightness (quiet hours, manual off)
    const quiet = this.isQuiet();
    if (quiet !== this.quiet) {
      this.log.info(quiet ? "quiet hours start" : "quiet hours end");
      this.quiet = quiet;
      this.pushedKey = null;
      if (!quiet && this.deferred.length) {
        const list = this.deferred; this.deferred = [];
        // show the newest now; the rest are dropped after a log line (a burst of night messages is not useful)
        const last = list[list.length - 1];
        if (list.length > 1) this.log.info(`morning: ${list.length} night items, showing the latest`);
        this.startOneOff({ ...last, durationMs: Math.max(last.durationMs, 60_000) });
      }
    }
    const wantOn = this.settings.screenOn && !(quiet && this.cfg.quietHours.mode === "off");
    const wantBrightness = quiet ? this.cfg.quietHours.dimBrightness : this.brightness;
    if (now < this.retryAt) return;
    try {
      if (this.screen.on !== wantOn) { await this.device.setScreen(wantOn); this.screen.on = wantOn; }
      if (wantOn && this.screen.brightness !== wantBrightness) { await this.device.setBrightness(wantBrightness); this.screen.brightness = wantBrightness; }
    } catch (e) {
      this.log.warn(`pixoo: ${e.message}`);
      this.retryAt = now + 10_000;
      this.screen = { on: null, brightness: null };
      return;
    }
    if (!wantOn) { this.shown = { label: quiet ? "夜间关屏" : "屏幕已关", layer: "off", frames: [newFrame().data], frameMs: 1000, at: now }; return; }

    // one-off item
    if (this.oneOff && now >= this.oneOff.until) {
      this.log.info(`done ${this.oneOff.label}`);
      this.oneOff = null;
      this.pushedKey = null;
      this.emit();
    }
    if (this.oneOff) {
      const o = this.oneOff;
      const key = `oneoff:${o.id}:${o.rendered.key}`;
      if (key !== this.pushedKey) await this.push(o.rendered, key, { label: o.label, layer: "oneOff", until: o.until });
      return;
    }

    // base screen
    const base = st.base;
    if (!this.baseRendered || now >= (this.baseRendered.nextAt ?? Infinity) || this.pushedKey == null) {
      try {
        const r = await this.renderItem(base);
        this.baseRendered = { ...r, nextAt: r.nextCheckMs ? now + r.nextCheckMs : Infinity };
      } catch (e) {
        this.log.warn(`base ${describeItem(base)}: ${e.message}`);
        const r = await render({ type: "text", text: `出错了：${e instanceof RenderError ? e.message : "画不出来"}`, size: "small", color: "#ff8888" },
          { font: this.font, tz: this.cfg.timezone, now });
        this.baseRendered = { ...r, key: `err:${e.message}`, nextAt: now + 60_000 };
      }
    }
    const key = `base:${this.baseRendered.key}`;
    if (key !== this.pushedKey) await this.push(this.baseRendered, key, { label: describeItem(base), layer: "base" });
  }

  async push(r, key, meta) {
    try {
      const ok = await this.device.playAnimation(r.frames, r.frameMs, meta.label);
      if (ok !== false) {
        this.pushedKey = key;
        this.shown = { ...meta, frames: r.frames, frameMs: r.frameMs, at: this.now() };
        this.emit();
      }
    } catch (e) {
      this.log.warn(`pixoo: could not show ${meta.label}: ${e.message}`);
      this.retryAt = this.now() + 10_000;
    }
  }
}
