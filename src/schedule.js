// Daily schedules: at HH:MM on the chosen weekdays, show an item for a while or switch the base screen.
//
//   {id, time: "08:00", days: [0..6] (0 = Sunday; empty = every day), action: "show" | "base", item, durationSec?,
//    enabled: true, lastRun?: "2026-11-08"}

import { randomUUID } from "node:crypto";
import { partsIn } from "./render.js";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ScheduleError extends Error {}

export function normalizeSchedule(s) {
  if (!HHMM.test(String(s?.time ?? ""))) throw new ScheduleError("time 要写成 HH:MM，比如 08:00");
  const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [];
  if (!["show", "base"].includes(s.action ?? "show")) throw new ScheduleError('action 只能是 "show" 或 "base"');
  if (!s.item || typeof s.item !== "object" || !s.item.type) throw new ScheduleError("缺少 item");
  return {
    id: s.id || randomUUID().slice(0, 8),
    time: s.time,
    days,
    action: s.action ?? "show",
    item: s.item,
    durationSec: s.durationSec ? Math.max(5, Math.min(24 * 3600, Number(s.durationSec))) : undefined,
    enabled: s.enabled !== false,
    note: s.note ? String(s.note).slice(0, 60) : undefined,
    lastRun: s.lastRun,
  };
}

/**
 * Schedules due at `now` (in `tz`): enabled, today's weekday, time already reached within the last `graceMin` minutes,
 * not run today yet. Marks them (lastRun = today's date) — the caller saves.
 */
export function dueSchedules(schedules, tz, now, graceMin = 10) {
  const t = partsIn(tz, now);
  const today = `${t.y}-${String(t.mo).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
  const mins = t.h * 60 + t.mi;
  const due = [];
  for (const s of schedules) {
    if (!s.enabled || s.lastRun === today) continue;
    if (s.days.length && !s.days.includes(t.wd)) continue;
    const [h, m] = s.time.split(":").map(Number);
    const at = h * 60 + m;
    if (mins >= at && mins - at <= graceMin) {
      s.lastRun = today;
      due.push(s);
    }
  }
  return due;
}
