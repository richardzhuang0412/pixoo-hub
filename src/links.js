// "How do I open it?" — the links (home Wi-Fi and Tailscale), QR codes and the Claude command, for `pixoo qr` and the
// end of setup.sh. Runs on the hub Mac (reads ~/PixooHub/config.json).

import { networkInterfaces } from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import QRCode from "qrcode";

const isTailscaleIP = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

export function lanIP() {
  const list = Object.values(networkInterfaces()).flat().filter((x) => x && x.family === "IPv4" && !x.internal);
  return list.find((x) => !isTailscaleIP(x.address))?.address ?? null;
}

const TAILSCALE_CLIS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"];

/** {name, ip} of this machine in Tailscale, or null when Tailscale is not installed / not logged in. */
export function tailscaleSelf() {
  for (const cli of TAILSCALE_CLIS) {
    if (cli.startsWith("/") && !existsSync(cli)) continue;
    try {
      const j = JSON.parse(execFileSync(cli, ["status", "--json"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }));
      if (j.BackendState !== "Running") return null;
      const ip = (j.Self?.TailscaleIPs ?? []).find((x) => x.includes("."));
      const name = (j.Self?.DNSName ?? "").replace(/\.$/, "");
      return ip ? { ip, name: name || null } : null;
    } catch { /* try the next one */ }
  }
  const ip = Object.values(networkInterfaces()).flat().find((x) => x?.family === "IPv4" && isTailscaleIP(x.address))?.address;
  return ip ? { ip, name: null } : null;
}

export async function printLinks(cfg, { out = console.log } = {}) {
  const lan = lanIP();
  const ts = tailscaleSelf();
  const q = (s) => QRCode.toString(s, { type: "terminal", small: true });
  const tok = encodeURIComponent(cfg.token);

  if (lan) {
    const home = `http://${lan}:${cfg.port}/?token=${tok}`;
    out("\n📱 在家里（连着同一个 Wi-Fi）：用手机相机扫这个码");
    out(await q(home));
    out(`   ${home}`);
  }
  if (ts) {
    const host = ts.name ?? ts.ip;
    const away = `http://${host}:${cfg.port}/?token=${tok}`;
    out("\n🌍 在外面（手机上也开着 Tailscale）：扫这个码");
    out(await q(away));
    out(`   ${away}`);
    out("\n🤖 让 Claude 控制它：在你自己的电脑上（开着 Tailscale）运行");
    out(`   claude mcp add --transport http pixoo http://${host}:${cfg.port}/mcp --header "Authorization: Bearer ${cfg.token}"`);
  } else {
    out("\n🌍 想在外面也能用、或者让 Claude 控制它？");
    out("   1. 在这台 Mac 上装 Tailscale（https://tailscale.com/download），登录");
    out("   2. 你的手机 / 电脑也装 Tailscale，登录同一个账号");
    out("   3. 在这台 Mac 上运行  pixoo qr  ，会多出「在外面」的二维码和 Claude 的设置命令");
  }
  out("\n打开以后：Safari「分享 → 添加到主屏幕」，就像一个 App。");
}
