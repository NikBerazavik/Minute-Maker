import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Timezone handling (carried over from Friday). Netlify functions and cron run
// in UTC; everything user-facing here is computed in the configured local
// timezone instead.
// ---------------------------------------------------------------------------

const OFFSET = config.utcOffset;

/** Today's date in local time, as "YYYY-MM-DD". */
export function today(tz = config.timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Current local wall-clock time as "YYYY-MM-DD HH:MM", for system prompts. */
export function nowLocal(tz = config.timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date())
    .replace(",", "");
}

/** Local day of week, e.g. "Wednesday". */
export function weekdayLocal(tz = config.timezone) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date());
}

/** Add N days to a "YYYY-MM-DD" string. Uses UTC math to avoid DST drift. */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Start-of-day instant for a local date, e.g. "2026-08-19T00:00:00+07:00". */
export function startOfDay(dateStr) {
  return `${dateStr}T00:00:00${OFFSET}`;
}

/**
 * Human label for a stub page, derived from an epoch-ms timestamp:
 * "Meeting — Sep 1, 14:15" (local time). Used until the real title is known.
 */
export function timestampLabel(epochMs, tz = config.timezone) {
  const d = new Date(Number(epochMs));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `Meeting — ${get("month")} ${get("day")}, ${get("hour")}:${get("minute")}`;
}

/** Epoch ms -> ISO 8601 with the local offset, which Notion accepts for a Date property. */
export function epochToLocalIso(epochMs, tz = config.timezone) {
  const d = new Date(Number(epochMs));
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type) => p.find((x) => x.type === type)?.value;
  // hourCycle "h23" is what makes this safe: the h24 cycle renders local
  // midnight as "24:00" against the PREVIOUS day, which would date every
  // midnight meeting a day early.
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${OFFSET}`;
}

/** Seconds -> "m:ss" or "h:mm:ss" for transcript timestamps. */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

