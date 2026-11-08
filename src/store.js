// Persistent hub state (state.json in the data dir): the base screen, settings changed from the web page, schedules.
// Written atomically (tmp + rename) after every change.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const EMPTY_STATE = {
  base: { type: "clock" },
  settings: {
    brightness: null,        // null = config value
    screenOn: true,
    location: null,          // {name, latitude, longitude} — null = config value
    unit: "C",
    luluInterrupts: true,    // LuluPet messages interrupt whatever the base screen is
  },
  schedules: [],             // see schedule.js
};

export class Store {
  constructor(dir, { log } = {}) {
    this.dir = dir;
    this.path = join(dir, "state.json");
    this.log = log;
    this.state = structuredClone(EMPTY_STATE);
    if (existsSync(this.path)) {
      try {
        const s = JSON.parse(readFileSync(this.path, "utf8"));
        this.state = { ...this.state, ...s, settings: { ...this.state.settings, ...(s.settings ?? {}) } };
        if (!Array.isArray(this.state.schedules)) this.state.schedules = [];
      } catch (e) {
        log?.warn(`state.json 读不了，用默认值：${e.message}`);
      }
    }
  }

  get() { return this.state; }

  update(fn) {
    fn(this.state);
    this.save();
    return this.state;
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
