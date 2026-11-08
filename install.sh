#!/bin/bash
# Pixoo Hub 一行安装（macOS）：
#
#   curl -fsSL https://raw.githubusercontent.com/richardzhuang0412/pixoo-hub/main/install.sh | bash
#
# 第一次运行 = 安装；以后再运行 = 更新到最新版（保留所有设置）。
# 想重新回答一遍设置问题：  … | bash -s -- --reconfigure

set -euo pipefail
REPO="richardzhuang0412/pixoo-hub"
ROOT="$HOME/PixooHub"
SRC="$ROOT/src"

[ "$(uname -s)" = "Darwin" ] || { echo "Pixoo Hub 的安装脚本只支持 macOS"; exit 1; }
mkdir -p "$ROOT"

echo "⬇️  下载 Pixoo Hub…"
tmp="$(mktemp -d)"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xzf - -C "$tmp"
rm -rf "$SRC"
mv "$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)" "$SRC"
rm -rf "$tmp"

args=()
if [ "${1:-}" = "--reconfigure" ]; then
  args=()
elif [ $# -gt 0 ]; then
  args=("$@")
elif [ -f "$ROOT/config.json" ]; then
  echo "👍 已经装过了：更新到最新版，设置都保留。"
  args=(--update)
fi

# questions are read from the terminal even though this script came in through a pipe
exec bash "$SRC/setup.sh" ${args[@]+"${args[@]}"} </dev/tty
