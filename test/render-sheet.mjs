// Renders sample items to one PNG contact sheet (dev aid):  node test/render-sheet.mjs OUT.png
import sharp from "sharp";
import { join } from "node:path";
import { PixelFont } from "../src/lib/font.js";
import { render } from "../src/render.js";
import { HUB_DIR } from "../src/config.js";

const font = PixelFont.load(join(HUB_DIR, "fonts/fusion-pixel-10px-proportional-zh_hans.bdf"));
const now = Date.parse("2026-11-08T14:42:00-05:00");
const tz = "America/New_York";
const weather = { temp: 9, code: 2, hi: 12, lo: 3 };
const location = { name: "Grafton" };
const items = [
  { type: "text", text: "晚安" },
  { type: "text", text: "想你啦 ❤️" },
  { type: "text", text: "今天考试加油！晚上一起视频，等你下课～" },
  { type: "text", text: "Good morning!", color: "#88ddff" },
  { type: "clock" },
  { type: "countdown", target: "2026-12-23", label: "见面" },
  { type: "countdown", target: "2026-11-09T09:00:00-05:00", label: "考试" },
  { type: "weather" },
  { type: "art", rows: [".##.##.", "#######", "#######", ".#####.", "..###..", "...#..."], palette: { "#": "#ff4466" } },
];
const S = 4, G = 6;
const tiles = [];
for (const it of items) {
  const r = await render(it, { font, tz, now, weather, location });
  const f = r.frames[0];
  tiles.push(await sharp(Buffer.from(f), { raw: { width: 64, height: 64, channels: 3 } }).resize(64 * S, 64 * S, { kernel: "nearest" }).png().toBuffer());
}
const cols = 3, rows = Math.ceil(tiles.length / cols);
await sharp({ create: { width: cols * (64 * S + G) + G, height: rows * (64 * S + G) + G, channels: 3, background: "#333" } })
  .composite(tiles.map((input, i) => ({ input, left: G + (i % cols) * (64 * S + G), top: G + Math.floor(i / cols) * (64 * S + G) })))
  .png().toFile(process.argv[2] ?? "sheet.png");
console.log("ok");
