# Pixoo Hub

让一台一直开着的 Mac 管着 Divoom Pixoo-64：手机网页、命令行、HTTP API、Claude 都往它发东西，由它决定屏幕上显示什么，
所以几样东西同时用也不会抢屏幕。噜噜桌宠是其中一个来源。

```
 手机网页 ─┐
 pixoo 命令 ─┤                         ┌─ 常驻画面：时钟 / 天气 / 倒计时 / 噜噜 / 图片 / 黑屏
 Claude ────┼─→ Pixoo Hub（闲置的 Mac）─┤─ 插播：文字、照片、GIF、画板、像素画（到时间自动回到常驻）
 定时任务 ──┤     :8787                 └─ 夜间：23:00–08:00 关屏，夜里来的东西早上再放
 噜噜桌宠 ──┘                                    │
                                                 └──→ Pixoo-64（同一个 Wi-Fi）
```

## 能做什么

| | |
|---|---|
| 发一句话 | 中英文都行，短的自动放大；❤️💧⏰🌙✨😊🍅 有彩色小图标 |
| 发照片 / GIF | 自动缩成 64×64，动图会动（最多 40 帧） |
| 像素画板 | 手机上 64×64 画板，可以「实时同步」：你画一笔，屏幕上就多一笔 |
| 常驻画面 | 时钟、天气（Open-Meteo，不用 key）、倒计时（「距离见面 45 天」）、噜噜、图片、黑屏 |
| 定时 | 每天几点发一句话，或者换常驻画面（比如 08:00「早安」，周一到周五） |
| 夜间模式 | 默认 23:00–08:00 关屏；夜里发的东西早上再放 |
| Claude | 内置 MCP：「在 Pixoo 上画一只猫」「每天早上 8 点给她发早安」 |

## 安装（10 分钟）

### 1. Pixoo

用手机装 **Divoom** App，添加 Pixoo-64，连上家里的 Wi-Fi（要选 **2.4GHz** 的那个）。

### 2. 那台一直开着的 Mac

插上电，连**同一个 Wi-Fi**，打开「终端」，粘贴这一行，回车：

```bash
curl -fsSL https://raw.githubusercontent.com/richardzhuang0412/pixoo-hub/main/install.sh | bash
```

它会自己找到 Pixoo，只问你几件事：

| 问题 | 怎么答 |
|---|---|
| 天气用哪个城市 | 比如 `Boston`，或直接回车 |
| 要接上噜噜桌宠吗 | 没用过噜噜就直接回车 |
| 密码 | 这台 Mac 的开机密码（输入时不显示，正常） |
| 合上盖子也继续跑吗 | 直接回车（推荐） |

装完屏幕上会出现一个**二维码**：用手机相机扫一下就打开了，然后 Safari「分享 → 添加到主屏幕」。

- 以后想再看二维码：在那台 Mac 上运行 `pixoo qr`
- 更新：再粘贴一次上面那一行（设置都保留）
- 卸载：`bash ~/PixooHub/app/setup.sh --uninstall`

装好的东西都在 `~/PixooHub`。两个后台服务开机自启、挂了自动重启：`com.pixoohub.hub`，接了噜噜的话还有
`com.lulupet.pixoo-bridge`。

## 在外面用：Tailscale

Hub 只在家里的 Wi-Fi 里能直接访问。用 [Tailscale](https://tailscale.com)（免费）把你的设备连成一个私有网络，在哪都能用，
而且只有你自己的设备能访问：

1. 在**那台 Mac** 上装 Tailscale（官网或 Mac App Store），登录；在 Tailscale 设置里勾上开机启动。
2. 在**你的手机 / 电脑**上装 Tailscale，登录**同一个账号**。
3. 在那台 Mac 上运行 `pixoo qr`：会多出一个「在外面」的二维码，扫它。

> Tailscale 的 Mac App 要有人登录了才会运行。那台 Mac 重启后要么有人登录一下，要么在「系统设置 → 用户与群组」里打开
> 自动登录（开着 FileVault 时不能自动登录）。

她在家里直接用 Wi-Fi 链接就行，不用装 Tailscale。

## 让 Claude 来控制

Hub 自带 MCP。装好 Tailscale 以后，在那台 Mac 上运行 `pixoo qr`，最后一行就是填好地址和 token 的命令，复制到你自己的电脑上
（也开着 Tailscale）运行：

```bash
claude mcp add --transport http pixoo http://<那台 Mac>:8787/mcp --header "Authorization: Bearer <token>"
```

然后在 Claude Code 里直接说：「在 Pixoo 上显示晚安」「画一个 16×16 的小猫」「把常驻换成倒计时，12 月 23 号见面」
「每个工作日早上 8 点发早安」「现在屏幕上是什么」（会回一张截图）。

工具：`pixoo_show_text`、`pixoo_show_image`、`pixoo_show_pixel_art`、`pixoo_set_base`、`pixoo_clear`、`pixoo_status`、
`pixoo_settings`、`pixoo_schedule_add / list / remove`。

> claude.ai 网页里的「自定义连接器」是从 Anthropic 的服务器连过来的，连不到 Tailscale 里的私有地址，所以用 Claude Code。
> 也可以用 stdio 版：`claude mcp add pixoo -- node /path/to/pixoo-hub/bin/pixoo-mcp.js`（需要本机有这个文件夹，并先 `pixoo login`）。

## 命令行

那台 Mac 上直接有 `pixoo` 命令；别的电脑上用 `node bin/pixoo.js`（先 `npm ci`），第一次先 `login`：

```bash
pixoo login http://<Hub 地址>:8787 <token>
pixoo text "晚安 ❤️" --for 10m
pixoo image ~/Pictures/cat.gif
pixoo countdown 2026-12-23 见面
pixoo clock | weather | lulu | blank
pixoo schedule add 08:00 "早安 ☀" --days 1-5 --for 30m
pixoo status
```

## HTTP API

本机（127.0.0.1）不用 token；其他地方加 `Authorization: Bearer <token>`。

| | |
|---|---|
| `POST /api/show` | `{item, durationSec?, persist?}` 插播（`persist: true` = 设为常驻） |
| `POST /api/base` | `{item}` 换常驻画面 |
| `POST /api/clear` | 结束插播 |
| `GET /api/status` / `GET /api/now` | 状态 / 屏幕上的帧（base64 RGB） |
| `POST /api/preview` | `{item}` 只渲染不显示 |
| `POST /api/settings` | `{brightness?, screenOn?, unit?, luluInterrupts?, location?}` |
| `GET/POST /api/schedules`、`DELETE /api/schedules/:id` | 定时 |
| `POST /mcp` | MCP |
| `POST /divoom/post` | 和 Pixoo 一样的接口（给噜噜桥接用） |

`item` 的类型：

```jsonc
{"type": "text", "text": "晚安", "color": "#ff6f93"}
{"type": "image", "data": "<base64>", "fit": "cover" | "contain"}
{"type": "pixels", "data": "<base64 的 64×64×3 RGB>"}
{"type": "art", "rows": ["..#..", ".###."], "palette": {"#": "#ff0000"}}
{"type": "clock"} {"type": "weather"} {"type": "countdown", "target": "2026-12-23", "label": "见面"}
{"type": "lulupet"} {"type": "blank"}
```

```bash
curl -X POST http://<hub>:8787/api/show -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"item":{"type":"text","text":"下班啦"},"durationSec":300}'
```

## 噜噜桌宠

安装时选「接上噜噜」，噜噜的 Pixoo 桥接会装在同一台 Mac 上，画面发给 Hub 而不是直接发给 Pixoo：

- 常驻选「噜噜」：平时就是噜噜（在线动、勿扰安静、离线睡觉）。
- 常驻是别的（时钟、天气…）：噜噜的消息（戳一下、文字、表情、串门、喝水提醒）会插播，放完回到常驻；可以在设置里关掉。

插播要靠桥接在每段画面上带一个 `X-Pixoo-Label`（这段是待机还是消息）。LuluPet 仓库里的桥接还没有这个，安装脚本会在本机
给它补上 3 行；合进 LuluPet 以后就不需要了。

## 常见问题

| 现象 | 看看这里 |
|---|---|
| 网页打不开 | 手机和 Mac 在不在同一个 Wi-Fi / 都开着 Tailscale；`tail -f ~/PixooHub/logs/hub.log` |
| 网页说 token 不对 | 用安装时打印的链接打开一次；token 在 `~/PixooHub/config.json` |
| `pixoo ✗ … timeout` | Pixoo 的 IP 变了或不在同一网络：改 `config.json` 里的 `pixoo.ip`，`sudo launchctl kickstart -k system/com.pixoohub.hub` |
| 弹出「允许查找本地网络设备」 | 点允许 |
| 屏幕停在 Pixoo 自己的表盘 | Pixoo 重启过：Hub 下次换画面时会重新接管；或者在网页上随便发一句 |
| 天气说「还没设置城市」 | 网页「常驻 → 天气」里搜城市 |
| 夜里没关屏 / 时间不对 | `config.json` 里的 `timezone`、`quietHours` |

## 开发

```bash
npm ci && npm run fetch-font
node bin/pixoo-hub.js --mock          # 本机假 Pixoo，打开 http://127.0.0.1:8787
node --test test/hub.test.mjs
node test/render-sheet.mjs out.png    # 各种画面的总览图
```

`src/lib/` 里的 Pixoo 客户端、点阵字体、图标是从 LuluPet `tools/pixoo-bridge` 拷来的（同一个作者，MIT）。
字体：Fusion Pixel Font（SIL OFL 1.1），`npm run fetch-font` 下载，不放在仓库里。
