import { describe, expect, it } from 'vitest';
import {
  officeScheduleError,
  officeWindowsBetween,
  parseOfficeSchedule,
  serializeOfficeSchedule,
  type OfficeSchedule,
} from '../../utils/officeSchedule';

const weekdays: OfficeSchedule = { days: [0, 1, 2, 3, 4], start: '09:00', end: '17:00', timezone: 'UTC' };

describe('office schedule', () => {
  it('round-trips through the setting', () => {
    expect(parseOfficeSchedule(serializeOfficeSchedule(weekdays))).toEqual(weekdays);
  });

  it('reads an empty or broken setting as not configured', () => {
    expect(parseOfficeSchedule('')).toBeNull();
    expect(parseOfficeSchedule(undefined)).toBeNull();
    expect(parseOfficeSchedule('{nope')).toBeNull();
    expect(parseOfficeSchedule(JSON.stringify({ ...weekdays, end: '08:00' }))).toBeNull();
  });

  it('explains what is wrong with a schedule it cannot save', () => {
    expect(officeScheduleError(weekdays)).toBeNull();
    expect(officeScheduleError({ ...weekdays, days: [] })).toBe('noDays');
    expect(officeScheduleError({ ...weekdays, start: '9' })).toBe('badTime');
    expect(officeScheduleError({ ...weekdays, start: '17:00', end: '09:00' })).toBe('endBeforeStart');
  });

  it('lists the office windows in a range, skipping days off', () => {
    // Friday 2026-11-20 00:00 UTC to Tuesday 2026-11-24 00:00 UTC.
    const from = Date.UTC(2026, 10, 20);
    const to = Date.UTC(2026, 10, 24);
    const windows = officeWindowsBetween(weekdays, from, to);
    expect(windows.map((w) => new Date(w.startMs).toISOString())).toEqual([
      '2026-11-20T09:00:00.000Z',
      '2026-11-23T09:00:00.000Z',
    ]);
    expect(windows[0].endMs - windows[0].startMs).toBe(8 * 3600 * 1000);
  });

  it('reads hours in the schedule timezone', () => {
    const toronto = { ...weekdays, timezone: 'America/Toronto' };
    // Monday 2026-11-16: 09:00 EST is 14:00 UTC.
    const windows = officeWindowsBetween(toronto, Date.UTC(2026, 10, 16, 12), Date.UTC(2026, 10, 16, 23));
    expect(new Date(windows[0].startMs).toISOString()).toBe('2026-11-16T14:00:00.000Z');
  });
});
