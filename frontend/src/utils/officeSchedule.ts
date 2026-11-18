/**
 * The smart queue's office schedule: the hours someone is in to start prints
 * and clear plates. Stored server-side as the `office_schedule` setting, a JSON
 * string (see backend/app/services/smart_queue.py, which plans with it).
 *
 * Days are numbered Monday = 0 to Sunday = 6, as Python's `weekday()` does.
 */

export interface OfficeSchedule {
  days: number[];
  /** "HH:MM", 24-hour. */
  start: string;
  end: string;
  /** IANA timezone the hours are read in. */
  timezone: string;
}

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultOfficeSchedule(): OfficeSchedule {
  return { days: [0, 1, 2, 3, 4], start: '09:00', end: '17:00', timezone: browserTimezone() };
}

/** Why `schedule` can't be saved, or null when it can. Mirrors the backend. */
export function officeScheduleError(schedule: OfficeSchedule): 'noDays' | 'badTime' | 'endBeforeStart' | null {
  if (schedule.days.length === 0) return 'noDays';
  if (!HHMM.test(schedule.start) || !HHMM.test(schedule.end)) return 'badTime';
  if (schedule.end <= schedule.start) return 'endBeforeStart';
  return null;
}

/** The setting's value as a schedule; null when unset or unreadable. */
export function parseOfficeSchedule(raw: string | null | undefined): OfficeSchedule | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<OfficeSchedule>;
    if (!Array.isArray(data.days) || typeof data.start !== 'string' || typeof data.end !== 'string') return null;
    const schedule: OfficeSchedule = {
      days: data.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      start: data.start,
      end: data.end,
      timezone: typeof data.timezone === 'string' && data.timezone ? data.timezone : 'UTC',
    };
    return officeScheduleError(schedule) ? null : schedule;
  } catch {
    return null;
  }
}

export function serializeOfficeSchedule(schedule: OfficeSchedule): string {
  return JSON.stringify({
    days: [...new Set(schedule.days)].sort((a, b) => a - b),
    start: schedule.start,
    end: schedule.end,
    timezone: schedule.timezone,
  });
}

/** Wall-clock fields of `utcMs` in `timeZone`. */
function zonedParts(utcMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

/** The UTC instant at which `timeZone`'s clock reads the given wall time. */
function zonedWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const p = zonedParts(guess, timeZone);
  const offset = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - guess;
  return guess - offset;
}

/** Office-hours windows overlapping [fromMs, toMs), for shading the timeline. */
export function officeWindowsBetween(schedule: OfficeSchedule, fromMs: number, toMs: number): TimeWindow[] {
  const [startH, startM] = schedule.start.split(':').map(Number);
  const [endH, endM] = schedule.end.split(':').map(Number);
  const windows: TimeWindow[] = [];
  const seen = new Set<string>();
  let timeZone = schedule.timezone;
  try {
    zonedParts(fromMs, timeZone);
  } catch {
    timeZone = 'UTC';
  }
  for (let t = fromMs - DAY_MS; t <= toMs + DAY_MS; t += DAY_MS / 2) {
    const { year, month, day } = zonedParts(t, timeZone);
    const key = `${year}-${month}-${day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const weekday = (new Date(Date.UTC(year, month, day)).getUTCDay() + 6) % 7;
    if (!schedule.days.includes(weekday)) continue;
    const startMs = zonedWallTimeToUtc(year, month, day, startH, startM, timeZone);
    const endMs = zonedWallTimeToUtc(year, month, day, endH, endM, timeZone);
    if (endMs > fromMs && startMs < toMs) windows.push({ startMs, endMs });
  }
  return windows.sort((a, b) => a.startMs - b.startMs);
}

/** `t` if the office is open then, else the next opening. Starts are allowed
 *  from opening up to (not including) closing, as the planner allows them. */
export function nextOfficeMoment(schedule: OfficeSchedule, t: number): number {
  const window = officeWindowsBetween(schedule, t, t + 8 * DAY_MS).find((w) => w.endMs > t);
  return window ? Math.max(window.startMs, t) : t;
}

/** `t` if the office is open then, else the last `stepMs` slot before the
 *  most recent closing (for moving a start earlier). */
export function previousOfficeMoment(schedule: OfficeSchedule, t: number, stepMs: number): number {
  const windows = officeWindowsBetween(schedule, t - 8 * DAY_MS, t + 1).filter((w) => w.startMs <= t);
  const last = windows[windows.length - 1];
  if (!last) return t;
  if (t < last.endMs) return t;
  return Math.max(last.startMs, Math.floor((last.endMs - 1) / stepMs) * stepMs);
}
