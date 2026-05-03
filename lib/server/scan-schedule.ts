/**
 * Schedule evaluator for per-reader auto-pause windows.
 *
 * Schedule JSON shape (stored in `devices.scan_schedule`):
 *   {
 *     "timezone": "America/New_York",
 *     "windows": [
 *       { "days": [0,1,2,3,4,5,6], "from": "22:00", "to": "06:00" }
 *     ]
 *   }
 *
 * Days: 0=Sunday..6=Saturday (matches JS getDay()).
 * Windows that cross midnight are supported (`to < from` means
 * "from N until N+1 midnight on the listed days").
 *
 * No date-library dependency — uses Node's `Intl.DateTimeFormat` with
 * the `timeZone` option, which is built into modern Node and correctly
 * handles DST transitions for IANA zone names.
 */

export type ScheduleWindow = {
  days: number[];
  from: string; // "HH:MM"
  to: string;   // "HH:MM"
};

export type ScanSchedule = {
  timezone: string;
  windows: ScheduleWindow[];
};

/**
 * Allowed US timezones — restricted set per operator preference. UI only
 * lets operators pick from this list; server validates against it before
 * saving.
 */
export const US_TIMEZONES = [
  "America/New_York",     // Eastern (default)
  "America/Chicago",      // Central
  "America/Denver",       // Mountain
  "America/Phoenix",      // Mountain (Arizona, no DST)
  "America/Los_Angeles",  // Pacific
  "America/Anchorage",    // Alaska
  "Pacific/Honolulu",     // Hawaii (no DST)
] as const;

export type UsTimezone = (typeof US_TIMEZONES)[number];

export const DEFAULT_TIMEZONE: UsTimezone = "America/New_York";

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseHHMM(s: string): number | null {
  const m = HHMM_RE.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Validate a schedule payload coming from the operator. Returns the
 * normalized schedule or throws an Error with a BAD_REQUEST: prefix.
 */
export function validateSchedule(input: unknown): ScanSchedule {
  if (input === null || typeof input !== "object") {
    throw new Error("BAD_REQUEST:Invalid schedule payload");
  }
  const obj = input as Record<string, unknown>;
  const tz = obj.timezone;
  if (typeof tz !== "string" || !US_TIMEZONES.includes(tz as UsTimezone)) {
    throw new Error("BAD_REQUEST:Invalid timezone (must be one of the US zones)");
  }
  const windows = obj.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error("BAD_REQUEST:Schedule must have at least one window");
  }
  if (windows.length > 14) {
    throw new Error("BAD_REQUEST:Schedule may have at most 14 windows");
  }
  const out: ScheduleWindow[] = [];
  for (const w of windows) {
    if (!w || typeof w !== "object") {
      throw new Error("BAD_REQUEST:Invalid window entry");
    }
    const ww = w as Record<string, unknown>;
    if (!Array.isArray(ww.days) || ww.days.length === 0) {
      throw new Error("BAD_REQUEST:Window must include at least one day");
    }
    const days: number[] = [];
    for (const d of ww.days) {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 0 || n > 6 || days.includes(n)) {
        throw new Error("BAD_REQUEST:Day must be 0..6 (Sun..Sat) and unique");
      }
      days.push(n);
    }
    if (typeof ww.from !== "string" || parseHHMM(ww.from) === null) {
      throw new Error('BAD_REQUEST:"from" must be HH:MM (24h)');
    }
    if (typeof ww.to !== "string" || parseHHMM(ww.to) === null) {
      throw new Error('BAD_REQUEST:"to" must be HH:MM (24h)');
    }
    if (ww.from === ww.to) {
      throw new Error('BAD_REQUEST:"from" and "to" must differ');
    }
    out.push({ days: days.sort((a, b) => a - b), from: ww.from, to: ww.to });
  }
  return { timezone: tz, windows: out };
}

/**
 * Returns the current local day-of-week (0..6) and minutes-since-midnight
 * (0..1439) for the given IANA timezone. Uses the host's `Intl` data
 * which Node 20+ ships with.
 */
function nowInZone(tz: string, now: Date = new Date()): { dow: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  // formatToParts is the only stable way to extract these as numbers.
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dow = dowMap[wd] ?? 0;
  // Hour can come back as "24" at midnight in some locales — normalize.
  const h = Number(hour) % 24;
  const m = Number(minute);
  return { dow, minutes: h * 60 + m };
}

/**
 * Is `now` inside any window of this schedule? Cross-midnight windows
 * (where `to < from`) span TWO days: the "from" minute on the listed day
 * up to 23:59, and 00:00 to the "to" minute on the *next* day.
 *
 * For "22:00..06:00 on weekdays Mon..Fri":
 *   - Mon 22:00..23:59 is in pause
 *   - Tue 00:00..05:59 is in pause (carry from Mon's Mon-listed window)
 *   - Tue 22:00..23:59 is in pause
 *   - Wed 00:00..05:59 is in pause (carry from Tue)
 *   - ...
 *   - Sat 00:00..05:59 is in pause (carry from Fri)
 *   - Sat 06:00..23:59 NOT paused
 *   - Sun NOT paused
 */
export function isInPauseWindow(
  schedule: ScanSchedule,
  now: Date = new Date(),
): boolean {
  const { dow, minutes } = nowInZone(schedule.timezone, now);
  const yesterday = (dow + 6) % 7;
  for (const w of schedule.windows) {
    const from = parseHHMM(w.from);
    const to = parseHHMM(w.to);
    if (from === null || to === null) continue;
    if (from < to) {
      // Same-day window. Inclusive of `from`, exclusive of `to`.
      if (w.days.includes(dow) && minutes >= from && minutes < to) return true;
    } else {
      // Cross-midnight window. Two halves to check.
      // Half 1: today is a listed day, time >= from (until 23:59).
      if (w.days.includes(dow) && minutes >= from) return true;
      // Half 2: yesterday was a listed day, time < to (we're carrying over).
      if (w.days.includes(yesterday) && minutes < to) return true;
    }
  }
  return false;
}

/**
 * Final pause decision for a reader. Manual-pause beats schedule (which
 * matches user's mental model: "I'm explicitly pausing this one, ignore
 * the schedule"). If neither says paused, the reader scans (subject to
 * the live-scan master gate evaluated elsewhere).
 */
export function isReaderEffectivelyPaused(
  scanPausedAt: Date | string | null,
  schedule: ScanSchedule | null,
  now: Date = new Date(),
): boolean {
  if (scanPausedAt) return true;
  if (schedule) return isInPauseWindow(schedule, now);
  return false;
}
