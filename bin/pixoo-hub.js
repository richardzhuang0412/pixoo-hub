#!/usr/bin/env node
// Pixoo Hub: keeps the Pixoo-64 showing the right thing and serves the phone page + API.
//
//   node bin/pixoo-hub.js [--config FILE]     run
//   node bin/pixoo-hub.js --mock [--out DIR]  run against a fake Pixoo on this machine (no device needed)
//   node bin/pixoo-hub.js --discover          list Pixoo devices Divoom's cloud sees on this network

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, endpointFor, ConfigError } from "../src/config.js";
import { createLogger } from "../src/lib/log.js";
import { PixelFont } from "../src/lib/font.js";
import { PixooClient, discover } from "../src/lib/pixoo.js";
import { MockPixoo } from "../src/lib/mock-pixoo.js";
import { Store } from "../src/store.js";
import { WeatherCache } from "../src/weather.js";
import { Hub } from "../src/hub.js";
import { DivoomCompat } from "../src/divoom-compat.js";
import { createHubServer } from "../src/server.js";

const { values: a } = parseArgs({
  options: {
    config: { type: "string" }, mock: { type: "boolean" }, out: { type: "string" }, discover: { type: "boolean" },
    port: { type: "string" }, "log-level": { type: "string" }, help: { type: "boolean", short: "h" },
  },
});
if (a.help) {
  console.log("用法: node bin/pixoo-hub.js [--config 文件] [--mock [--out 目录]] [--discover] [--port 8787]");
  process.exit(0);
}

let cfg;
try { cfg = loadConfig({ file: a.config }); }
catch (e) { if (e instanceof ConfigError) { console.error(`配置有误：${e.message}`); process.exit(2); } throw e; }
if (a.port) cfg.port = Number(a.port);
const log = createLogger({ level: a["log-level"] ?? cfg.logLevel, secrets: [cfg.token] });

if (a.discover) {
  const list = await discover();
  if (!list.length) log.warn("Divoom 云端没有看到同一网络里的设备（要先在 Divoom App 里联网绑定）");
  for (const d of list) console.log(`${d.name}\t${d.ip}\tid=${d.id}`);
  process.exit(0);
}

if (!existsSync(cfg.fontFile)) { log.error(`找不到字体 ${cfg.fontFile}：先运行 npm run fetch-font`); process.exit(2); }
const font = PixelFont.load(cfg.fontFile);

let endpoint = endpointFor(cfg.pixoo);
let mock = null;
if (a.mock) {
  mock = await new MockPixoo().listen(0);
  endpoint = mock.url;
  log.info(`mock Pixoo on ${mock.url}`);
  let n = 0;
  mock.on("violation", (v) => log.warn(`mock pixoo: PROTOCOL VIOLATION ${v}`));
  mock.on("animation", (anim) => {
    n++;
    log.info(`mock pixoo: animation #${n} ${anim.frames.length} frames × ${anim.speed} ms`);
    if (a.out) {
      mkdirSync(a.out, { recursive: true });
      writeFileSync(join(a.out, `frame-${String(n).padStart(4, "0")}.rgb`), anim.frames[0]);
    }
  });
}

const device = new PixooClient({ endpoint, deviceName: cfg.pixoo.deviceName, log });
try { await device.ping(); log.info("pixoo: reachable"); }
catch (e) { log.warn(`pixoo: not reachable yet (${e.message}); will keep trying`); }

const store = new Store(cfg.dataDir, { log });
const weather = new WeatherCache({ log });
const hub = new Hub({ cfg, device, font, store, weather, log });
const compat = new DivoomCompat({ onAnimation: (anim) => hub.onLuluAnimation(anim), log });
const server = createHubServer({ cfg, hub, store, compat, font, log });

server.listen(cfg.port, cfg.host, () => {
  log.info(`Pixoo Hub on http://${cfg.host === "0.0.0.0" ? "<this-mac>" : cfg.host}:${cfg.port}  (timezone ${cfg.timezone}, data ${cfg.dataDir})`);
  if (!cfg.token) log.warn("没设 token：只有这台电脑自己能用 API 和网页");
});
hub.start();

const bye = () => { log.info("bye"); hub.stop(); server.close(); mock?.close(); process.exit(0); };
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
