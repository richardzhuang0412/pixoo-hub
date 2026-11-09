#!/bin/bash
# Pixoo Hub 安装脚本（macOS）。一般不用直接运行它：用 README 里那一行 curl 命令（install.sh）安装 / 更新。
# 也可以手动：
#   bash setup.sh              安装 / 重新配置
#   bash setup.sh --update     只更新程序，保留配置
#   bash setup.sh --uninstall  删掉后台服务，恢复睡眠设置
#
# 做的事：
#   1. 下载 Node.js 22（只放在 ~/PixooHub 里，不动系统）
#   2. 把 Hub 装到 ~/PixooHub/app，装依赖、下载像素字体
#   3. 问 Pixoo 的 IP、所在城市，生成一个 token，写好配置（只有你能读）
#   4. （可选）装噜噜桌宠的 Pixoo 桥接，让它通过 Hub 显示
#   5. 装成开机自启的系统服务（不用登录也会跑，挂了自动重启）
#   6. 插电时不睡眠；可选：合上盖子也不睡

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HOME/PixooHub"
APP="$ROOT/app"
NODE_DIR="$ROOT/node"
CONFIG="$ROOT/config.json"
HUB_LABEL="com.pixoohub.hub"
HUB_PLIST="/Library/LaunchDaemons/$HUB_LABEL.plist"
LULU_LABEL="com.lulupet.pixoo-bridge"
LULU_PLIST="/Library/LaunchDaemons/$LULU_LABEL.plist"
LULU_DIR="$ROOT/lulupet"
LULU_CONFIG="$ROOT/lulupet-config.json"
OLD_LULU="$HOME/LuluPixoo"           # the earlier LuluPet-only install (setup-pixoo-mac.sh)
PORT=8787

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { local __v; read -r -p "$1" __v; local rc=$?; printf '%s' "$__v"; return $rc; }

[ "$(uname -s)" = "Darwin" ] || die "这个脚本只给 macOS 用"
[ -f "$HERE/bin/pixoo-hub.js" ] || die "请在 pixoo-hub 文件夹里运行（找不到 bin/pixoo-hub.js）"
MODE="${1:-}"

unload() { sudo launchctl bootout system "$1" 2>/dev/null || true; sudo rm -f "$1"; }

if [ "$MODE" = "--uninstall" ]; then
  say "删掉后台服务（需要输入这台 Mac 的登录密码）"
  unload "$HUB_PLIST"; unload "$LULU_PLIST"
  sudo rm -f /usr/local/bin/pixoo
  sudo pmset -a disablesleep 0
  ok "服务删掉了，睡眠设置恢复了。配置和程序还在 ${ROOT}，不要了可以拖进废纸篓"
  exit 0
fi

mkdir -p "$ROOT/logs" "$ROOT/data"

# ---------- 1. Node.js ----------
if [ ! -x "$NODE_DIR/bin/node" ]; then
  arch="$(uname -m)"; [ "$arch" = "x86_64" ] && arch="x64"
  say "下载 Node.js 22（${arch}）"
  base="https://nodejs.org/dist/latest-v22.x"
  line="$(curl -fsSL "$base/SHASUMS256.txt" | grep "darwin-$arch.tar.gz$")" || die "找不到 Node 下载地址，检查网络"
  sha="${line%% *}"; file="${line##* }"
  curl -fL --progress-bar "$base/$file" -o "$ROOT/$file"
  echo "$sha  $ROOT/$file" | shasum -a 256 -c - >/dev/null || die "Node 文件校验失败，重跑一次"
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  tar -xzf "$ROOT/$file" -C "$NODE_DIR" --strip-components 1
  rm -f "$ROOT/$file"
fi
export PATH="$NODE_DIR/bin:$PATH"
ok "Node $(node --version)"

# ---------- 2. Hub 程序 ----------
say "安装 Pixoo Hub"
if [ "$HERE" != "$APP" ]; then
  keepfonts=""
  [ -d "$APP/fonts" ] && { mv "$APP/fonts" "$ROOT/.fonts.keep"; keepfonts=1; }
  rm -rf "$APP"; mkdir -p "$APP"
  ( cd "$HERE" && tar --exclude node_modules --exclude fonts --exclude .git -cf - . ) | ( cd "$APP" && tar -xf - )
  [ -n "$keepfonts" ] && mv "$ROOT/.fonts.keep" "$APP/fonts"
fi
( cd "$APP" && npm ci --omit=dev --no-audit --no-fund --loglevel=error )
( cd "$APP" && npm run --silent fetch-font )
ok "程序在 $APP"

# ---------- 3. 配置 ----------
if [ "$MODE" = "--update" ] && [ -f "$CONFIG" ]; then
  ok "保留原来的配置 $CONFIG"
else
  say "找 Pixoo"
  LIST="$( cd "$APP" && node bin/pixoo-hub.js --discover 2>/dev/null | grep -E $'\t[0-9.:]+\t' || true )"
  N="$(printf '%s' "$LIST" | grep -c . || true)"
  IP=""
  if [ "$N" = "1" ]; then
    IP="$(printf '%s' "$LIST" | cut -f2)"; ok "找到了：$(printf '%s' "$LIST" | cut -f1)（${IP}）"
  elif [ "$N" -gt 1 ] 2>/dev/null; then
    echo "找到好几个 Divoom 设备："; printf '%s\n' "$LIST" | awk -F'\t' '{printf "  %d) %s  %s\n", NR, $1, $2}'
    pick="$(ask "选哪个？输入数字 [1]: ")"; pick="${pick:-1}"
    IP="$(printf '%s\n' "$LIST" | sed -n "${pick}p" | cut -f2)"
  else
    warn "没自动找到 Pixoo。先确认：Pixoo 插着电、在 Divoom App 里连上了 Wi-Fi、和这台 Mac 是同一个 Wi-Fi。"
    echo "   IP 可以在 Divoom App 的设备设置里看到，长得像 192.168.1.50"
  fi
  PIXOO_OK=""
  for _ in 1 2 3 4 5; do
    if [ -z "$IP" ]; then IP="$(ask "Pixoo 的 IP（直接回车 = 先跳过）: ")" || break; [ -z "$IP" ] && break; fi
    if curl -s -m 5 -X POST "http://$IP/post" -d '{"Command":"Channel/GetAllConf"}' 2>/dev/null | grep -q error_code; then
      ok "连上 Pixoo 了"; PIXOO_OK=1; break
    fi
    warn "连不上 ${IP}。如果弹出「允许查找本地网络设备」，点允许。"
    again="$(ask "重新输入 IP（直接回车 = 再试一次，输入 skip = 先跳过）: ")" || break
    [ "$again" = "skip" ] && break
    [ -n "$again" ] && IP="$again"
  done
  [ -z "$PIXOO_OK" ] && warn "先跳过 Pixoo：Hub 会自己去找它；也可以之后重跑安装命令"
  TZ_IN="$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"
  CITY="$(ask "天气用哪个城市？（比如 Boston，直接回车 = 先不设）: ")"
  OLD_TOKEN=""
  [ -f "$CONFIG" ] && OLD_TOKEN="$(node -e 'try{process.stdout.write(require(process.argv[1]).token||"")}catch{}' "$CONFIG")"
  IP="$IP" TZV="$TZ_IN" CITY="$CITY" OLD_TOKEN="$OLD_TOKEN" CONFIG="$CONFIG" ROOT="$ROOT" PORT="$PORT" node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    import { randomBytes } from "node:crypto";
    const e = process.env;
    let location = { name: "", latitude: null, longitude: null };
    if (e.CITY.trim()) {
      try {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(e.CITY.trim())}&count=1&language=zh`).then((x) => x.json());
        const g = r.results?.[0];
        if (g) { location = { name: g.name, latitude: g.latitude, longitude: g.longitude }; console.log(`  天气城市：${g.name}, ${g.admin1 ?? ""} ${g.country ?? ""}`); }
        else console.log("  没找到这个城市，之后可以在网页「常驻 → 天气」里再选");
      } catch { console.log("  查城市失败，之后可以在网页里再选"); }
    }
    const c = {
      port: Number(e.PORT), host: "0.0.0.0",
      token: e.OLD_TOKEN || randomBytes(12).toString("base64url"),
      pixoo: { ip: e.IP.trim(), url: "", deviceName: "" },
      brightness: 60, timezone: e.TZV, location,
      quietHours: { enabled: true, start: "23:00", end: "08:00", mode: "off", dimBrightness: 5, interrupts: "morning" },
      defaultShowSec: 30, dataDir: e.ROOT + "/data", logLevel: "info",
    };
    writeFileSync(e.CONFIG, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  '
  chmod 600 "$CONFIG"
  ok "配置写在 ${CONFIG}（只有你能读）"
fi
TOKEN="$(node -e 'process.stdout.write(require(process.argv[1]).token)' "$CONFIG")"

# ---------- 4. 噜噜桌宠（可选） ----------
WANT_LULU=""
if [ -f "$LULU_CONFIG" ]; then WANT_LULU=y
elif [ "$MODE" != "--update" ]; then
  if [ -f "$OLD_LULU/config.json" ]; then WANT_LULU=y; ok "检测到之前装过噜噜，一起接上"
  else WANT_LULU="$(ask "要接上噜噜桌宠吗？（没用过噜噜就直接回车）[y/N] ")"; fi
fi
if [ "$WANT_LULU" = "y" ] || [ "$WANT_LULU" = "Y" ]; then
  say "安装噜噜桌宠的 Pixoo 桥接"
  tmp="$ROOT/.lulu.download"; rm -rf "$tmp"; mkdir -p "$tmp"
  NEEDED="tools/pixoo-bridge web/js web/assets"
  if xcode-select -p >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
    git clone -q --depth 1 --filter=blob:none --sparse https://github.com/richardzhuang0412/LuluPet.git "$tmp/LuluPet"
    # shellcheck disable=SC2086
    git -C "$tmp/LuluPet" sparse-checkout set $NEEDED
    rm -rf "$tmp/LuluPet/.git"
  else
    echo "（没有 git：下载整包约 1 GB，只解压需要的部分）"
    pats=(); for p in $NEEDED; do pats+=("*/$p/*"); done
    curl -fL --progress-bar "https://codeload.github.com/richardzhuang0412/LuluPet/tar.gz/refs/heads/main" | tar -xzf - -C "$tmp" "${pats[@]}"
  fi
  src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
  BR="$LULU_DIR/tools/pixoo-bridge"
  [ -d "$BR/fonts" ] && mv "$BR/fonts" "$tmp/fonts.keep"
  rm -rf "$LULU_DIR"; mv "$src" "$LULU_DIR"
  [ -d "$tmp/fonts.keep" ] && mv "$tmp/fonts.keep" "$BR/fonts"
  rm -rf "$tmp"
  # Until LuluPet's bridge sends X-Pixoo-Label itself, add it here (3 lines) so its messages can interrupt the clock.
  if ! grep -q "X-Pixoo-Label" "$BR/src/pixoo.js"; then
    node -e '
      const fs = require("fs"); const p = process.argv[1]; let s = fs.readFileSync(p, "utf8");
      s = s.replace("async rawCommand(body) {", "async rawCommand(body, label = null) {")
           .replace("headers: { \"Content-Type\": \"application/json\" },", "headers: { \"Content-Type\": \"application/json\", ...(label ? { \"X-Pixoo-Label\": encodeURIComponent(label) } : {}) },")
           .replace("await this.rawCommand(p);", "await this.rawCommand(p, label);");
      fs.writeFileSync(p, s);' "$BR/src/pixoo.js"
    grep -q "X-Pixoo-Label" "$BR/src/pixoo.js" && ok "给噜噜桥接加上了画面标签（消息可以插播）" || warn "没加上画面标签：噜噜只在「常驻噜噜」时显示"
  fi
  ( cd "$BR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error && npm run --silent fetch-font )

  if [ ! -f "$LULU_CONFIG" ]; then
    DB=""; CODE=""; SEAT="lulu"
    if [ -f "$OLD_LULU/config.json" ]; then
      DB="$(node -e 'process.stdout.write(require(process.argv[1]).databaseURL||"")' "$OLD_LULU/config.json")"
      CODE="$(node -e 'process.stdout.write(require(process.argv[1]).pairCode||"")' "$OLD_LULU/config.json")"
      SEAT="$(node -e 'process.stdout.write(require(process.argv[1]).watchSeat||"lulu")' "$OLD_LULU/config.json")"
      [ -n "$DB" ] && ok "用之前装噜噜时填的数据库地址和配对码"
    fi
    [ -z "$DB" ] && DB="$(ask "Firebase 数据库地址（LuluPet 设置 →「通用」里）: ")"
    if [ -z "$CODE" ]; then CODE="$(ask "24 位配对码: ")"; CODE="$(printf '%s' "$CODE" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"; fi
    if [ ! -f "$OLD_LULU/config.json" ]; then S2="$(ask "显示谁发的消息？lulu 还是 lumei [lulu]: ")"; SEAT="${S2:-lulu}"; fi
    DB="$DB" CODE="$CODE" SEAT="$SEAT" OUT="$LULU_CONFIG" ROOT="$ROOT" PORT="$PORT" node -e '
      const e = process.env;
      require("fs").writeFileSync(e.OUT, JSON.stringify({
        databaseURL: e.DB.trim().replace(/\/+$/, ""), pairCode: e.CODE, watchSeat: e.SEAT,
        pixoo: { ip: "", url: `http://127.0.0.1:${e.PORT}/divoom/post`, deviceName: "" },
        quietHours: { enabled: false },
        cacheDir: e.ROOT + "/lulupet-cache", stateFile: e.ROOT + "/data/lulupet-cursor.json", logLevel: "info",
      }, null, 2) + "\n", { mode: 0o600 });'
    chmod 600 "$LULU_CONFIG"
  fi
  ok "噜噜桥接装好了（夜间模式由 Hub 统一管）"
fi

# ---------- 5. 系统服务 ----------
say "装成开机自启的服务（需要输入这台 Mac 的登录密码）"
USER_NAME="$(id -un)"
plist() { # label workdir logname args...
  local label="$1" wd="$2" logname="$3"; shift 3
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'
  printf '  <key>Label</key><string>%s</string>\n  <key>UserName</key><string>%s</string>\n  <key>WorkingDirectory</key><string>%s</string>\n' "$label" "$USER_NAME" "$wd"
  printf '  <key>ProgramArguments</key><array>\n'; for x in "$@"; do printf '    <string>%s</string>\n' "$x"; done; printf '  </array>\n'
  printf '  <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>\n'
  printf '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>\n'
  printf '  <key>StandardOutPath</key><string>%s</string>\n  <key>StandardErrorPath</key><string>%s</string>\n</dict></plist>\n' "$ROOT/logs/$logname.log" "$ROOT/logs/$logname.log"
}
install_daemon() { # label plistpath tmpfile
  unload "$2"
  sudo cp "$3" "$2"; sudo chown root:wheel "$2"; sudo chmod 644 "$2"
  sudo launchctl bootstrap system "$2"
}
# the earlier LuluPet-only service drew straight to the Pixoo: replace it
if [ -f "$LULU_PLIST" ] && grep -q "$OLD_LULU" "$LULU_PLIST" 2>/dev/null; then warn "停掉之前直连 Pixoo 的噜噜服务"; unload "$LULU_PLIST"; fi

plist "$HUB_LABEL" "$APP" hub "$NODE_DIR/bin/node" bin/pixoo-hub.js --config "$CONFIG" > "$ROOT/$HUB_LABEL.plist"
install_daemon "$HUB_LABEL" "$HUB_PLIST" "$ROOT/$HUB_LABEL.plist"
ok "Hub 在后台跑起来了"
if [ -f "$LULU_CONFIG" ]; then
  plist "$LULU_LABEL" "$LULU_DIR/tools/pixoo-bridge" lulupet "$NODE_DIR/bin/node" bin/pixoo-bridge.js --config "$LULU_CONFIG" > "$ROOT/$LULU_LABEL.plist"
  install_daemon "$LULU_LABEL" "$LULU_PLIST" "$ROOT/$LULU_LABEL.plist"
  ok "噜噜桥接在后台跑起来了"
fi

# `pixoo` command for this Mac
sudo mkdir -p /usr/local/bin
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_DIR/bin/node" "$APP/bin/pixoo.js" | sudo tee /usr/local/bin/pixoo >/dev/null
sudo chmod 755 /usr/local/bin/pixoo

# ---------- 6. 电源 ----------
say "电源设置"
sudo pmset -c sleep 0 disksleep 0 displaysleep 5 womp 1 autorestart 1 >/dev/null
ok "插电时不睡眠（屏幕 5 分钟后照常熄灭），停电恢复后自动开机"
if [ "$MODE" != "--update" ]; then
  lid="$(ask "合上盖子也让它继续跑吗？（推荐；这台 Mac 会完全不睡眠）[Y/n] ")"
  if [ "$lid" = "n" ] || [ "$lid" = "N" ]; then warn "盖子要一直开着"; else sudo pmset -a disablesleep 1; ok "合上盖子也会继续跑"; fi
fi

# ---------- done ----------
sleep 2
echo
printf '\033[1;32m全部装好了 🎉\033[0m\n'
"$NODE_DIR/bin/node" "$APP/bin/pixoo.js" qr || true
cat <<EOF

以后有用的：
  再显示一次上面的二维码：     pixoo qr
  在这台 Mac 上直接发一句话：  pixoo text "晚安"
  更新到最新版：               再运行一次安装那一行命令
  卸载：                       bash ~/PixooHub/app/setup.sh --uninstall
  出问题时看日志：             tail -f ~/PixooHub/logs/hub.log
EOF
