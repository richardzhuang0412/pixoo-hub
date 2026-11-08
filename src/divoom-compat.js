// A Divoom-compatible endpoint (POST /divoom/post) so the LuluPet bridge — or anything else that speaks the Pixoo
// local API — can draw through the hub instead of straight to the device. Point the bridge at it with
//   "pixoo": {"url": "http://127.0.0.1:8787/divoom/post"}
//
// Draw/SendHttpGif frames are collected into whole animations and handed to the hub; brightness / screen commands are
// acknowledged but ignored (the hub owns the screen). If the sender adds an `X-Pixoo-Label` header (URL-encoded, e.g.
// "idle:online:…" or "poke"), the hub can tell base animations from messages; without it the animations are only used
// when the base screen is "lulupet".

const FRAME_BYTES = 64 * 64 * 3;

export class DivoomCompat {
  constructor({ onAnimation, log }) {
    this.onAnimation = onAnimation;
    this.log = log;
    this.partial = null;
    this.stats = { commands: 0, animations: 0 };
  }

  /** `body` = parsed JSON; `label` = decoded X-Pixoo-Label or null. → the JSON reply. */
  handle(body, label) {
    this.stats.commands++;
    const cmd = body?.Command;
    switch (cmd) {
      case "Draw/ResetHttpGifId":
        this.partial = null;
        return { error_code: 0 };
      case "Draw/GetHttpGifId":
        return { error_code: 0, PicId: 1 };
      case "Channel/GetAllConf":
        return { error_code: 0, Brightness: 100, LightSwitch: 1 };
      case "Channel/SetBrightness":
      case "Channel/OnOffScreen":
        return { error_code: 0 };
      case "Draw/SendHttpGif": {
        const num = Number(body.PicNum), off = Number(body.PicOffset), speed = Number(body.PicSpeed);
        if (!(num > 0 && num < 60) || !(off >= 0 && off < num) || body.PicWidth !== 64) return { error_code: 1 };
        const data = Buffer.from(String(body.PicData ?? ""), "base64");
        if (data.length !== FRAME_BYTES) return { error_code: 1 };
        if (off === 0 || !this.partial || this.partial.num !== num) this.partial = { num, speed, frames: [], label };
        if (off !== this.partial.frames.length) { this.partial = null; return { error_code: 1 }; }
        this.partial.frames.push(new Uint8Array(data));
        if (this.partial.frames.length === num) {
          const done = this.partial;
          this.partial = null;
          this.stats.animations++;
          this.log?.info(`lulupet → ${done.label ?? "(no label)"} ${num} frames`);
          this.onAnimation({ frames: done.frames, frameMs: Math.max(20, speed || 100), label: done.label ?? null });
        }
        return { error_code: 0 };
      }
      default:
        return { error_code: 0 };
    }
  }
}
