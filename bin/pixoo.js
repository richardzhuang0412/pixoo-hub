#!/usr/bin/env node
// pixoo — command line for the Pixoo Hub.  Run `pixoo help`.

import { parseArgs } from "node:util";
import { HubClient, clientConfig, saveClientConfig, parseDuration, loadImage, CLIENT_FILE } from "../src/client.js";

const HELP = `pixoo — 控制 Pixoo Hub

  pixoo text "晚安 ❤️" [--color #ff6f93] [--for 5m] [--keep]   发一句话（--keep = 设为常驻）
  pixoo image 照片.jpg|https://…gif [--fit contain] [--for 5m] [--keep]
  pixoo clock | weather | lulu | blank                       换常驻画面
  pixoo countdown 2026-12-23 [见面]                           常驻倒计时
  pixoo clear                                                结束插播，回到常驻画面
  pixoo status
  pixoo brightness 40
  pixoo screen on|off
  pixoo schedule list
  pixoo schedule add 08:00 "早安" [--days 1-5] [--for 30m]     每天定时发一句话（days: 0=周日 … 6=周六）
  pixoo schedule add 23:00 --base clock                       定时换常驻画面
  pixoo schedule rm <id>
  pixoo qr                                                   （在 Hub 那台 Mac 上）显示手机扫码链接和 Claude 设置命令
  pixoo login http://<hub>:8787 <token>                       记住 Hub 地址和 token（存在 ${CLIENT_FILE}）

Hub 地址也可以用环境变量 PIXOO_HUB_URL / PIXOO_HUB_TOKEN。`;

function days(spec) {
  if (!spec) return [];
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const m = /^(\d)(?:-(\d))?$/.exec(part.trim());
    if (!m) throw new Error(`--days 写法：1-5 或 0,6`);
    const a = Number(m[1]), b = m[2] != null ? Number(m[2]) : a;
    for (let d = a; d <= b; d++) if (d >= 0 && d <= 6) out.add(d);
  }
  return [...out];
}

async function main() {
  const { values: o, positionals: p } = parseArgs({
    allowPositionals: true,
    options: { color: { type: "string" }, for: { type: "string" }, keep: { type: "boolean" }, fit: { type: "string" },
      days: { type: "string" }, base: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [cmd, ...args] = p;
  if (!cmd || cmd === "help" || o.help) { console.log(HELP); return; }
  const hub = new HubClient(clientConfig());
  const dur = parseDuration(o.for);
  const showOrKeep = async (item) => {
    const r = await hub.show(item, { durationSec: dur ?? undefined, persist: !!o.keep });
    console.log(o.keep ? "✓ 设为常驻" : r.deferred ? "✓ 夜间模式，早上再放" : r.skipped ? "· 夜间模式，跳过了" : `✓ 显示到 ${new Date(r.shownUntil).toLocaleTimeString()}`);
  };

  switch (cmd) {
    case "text": {
      const text = args.join(" ").trim();
      if (!text) throw new Error('用法：pixoo text "要说的话"');
      return showOrKeep({ type: "text", text, ...(o.color ? { color: o.color } : {}) });
    }
    case "image": case "img": case "gif": {
      if (!args[0]) throw new Error("用法：pixoo image 文件或网址");
      return showOrKeep({ type: "image", data: await loadImage(args[0]), fit: o.fit === "contain" ? "contain" : "cover" });
    }
    case "clock": case "weather": case "blank":
      await hub.base({ type: cmd }); return console.log(`✓ 常驻：${cmd}`);
    case "lulu": case "lulupet":
      await hub.base({ type: "lulupet" }); return console.log("✓ 常驻：噜噜");
    case "countdown": {
      if (!args[0]) throw new Error("用法：pixoo countdown 2026-12-23 [名字]");
      await hub.base({ type: "countdown", target: args[0], label: args.slice(1).join(" ") });
      return console.log("✓ 常驻：倒计时");
    }
    case "clear": await hub.clear(); return console.log("✓ 回到常驻画面");
    case "status": {
      const s = await hub.status();
      console.log(`屏幕上：${s.shown?.label ?? "—"}${s.oneOff ? `（插播到 ${new Date(s.oneOff.until).toLocaleTimeString()}）` : ""}`);
      console.log(`常驻：${s.baseLabel}   亮度：${s.settings.brightness}   屏幕：${s.settings.screenOn ? "开" : "关"}${s.quiet ? "   夜间模式中" : ""}`);
      console.log(`噜噜桥接：${s.lulupet.connected ? "在线" : "没连"}   定时：${s.schedules} 个   已发画面：${s.device?.animations ?? 0}`);
      return;
    }
    case "brightness": {
      const v = Number(args[0]);
      if (!(v >= 0 && v <= 100)) throw new Error("亮度 0–100");
      await hub.settings({ brightness: v }); return console.log(`✓ 亮度 ${v}`);
    }
    case "screen": {
      if (!["on", "off"].includes(args[0])) throw new Error("用法：pixoo screen on|off");
      await hub.settings({ screenOn: args[0] === "on" }); return console.log(`✓ 屏幕${args[0] === "on" ? "开" : "关"}`);
    }
    case "schedule": case "sched": {
      const sub = args[0];
      if (sub === "list" || !sub) {
        const { schedules } = await hub.schedules();
        if (!schedules.length) return console.log("（没有定时）");
        for (const s of schedules) {
          const what = s.action === "base" ? `常驻→${s.item.type}` : s.item.text ? `「${s.item.text}」` : s.item.type;
          console.log(`${s.id}  ${s.time}  ${s.days.length ? `周${s.days.join(",")}` : "每天"}  ${what}${s.enabled ? "" : "（停用）"}`);
        }
        return;
      }
      if (sub === "add") {
        const time = args[1];
        const item = o.base ? { type: o.base === "lulu" ? "lulupet" : o.base } : { type: "text", text: args.slice(2).join(" "), ...(o.color ? { color: o.color } : {}) };
        if (!o.base && !item.text) throw new Error('用法：pixoo schedule add 08:00 "早安"');
        const r = await hub.addSchedule({ time, days: days(o.days), action: o.base ? "base" : "show", item, durationSec: dur ?? undefined });
        return console.log(`✓ 加好了（id ${r.schedule.id}）`);
      }
      if (sub === "rm" || sub === "remove" || sub === "del") {
        const r = await hub.removeSchedule(args[1]);
        return console.log(r.ok ? "✓ 删掉了" : "没找到这个 id");
      }
      throw new Error("schedule list | add | rm");
    }
    case "qr": case "link": case "links": {
      const { loadConfig } = await import("../src/config.js");
      const { printLinks } = await import("../src/links.js");
      const cfg = loadConfig();
      if (!cfg.token) throw new Error("这台电脑上没有装 Hub（找不到 ~/PixooHub/config.json）");
      return printLinks(cfg);
    }
    case "login": {
      if (!args[0]) throw new Error("用法：pixoo login http://<hub>:8787 <token>");
      saveClientConfig({ url: args[0].replace(/\/+$/, ""), token: args[1] ?? "" });
      const s = await new HubClient(clientConfig()).status();
      return console.log(`✓ 连上了，屏幕上：${s.shown?.label ?? "—"}`);
    }
    default:
      throw new Error(`不认识的命令：${cmd}（pixoo help 看用法）`);
  }
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
