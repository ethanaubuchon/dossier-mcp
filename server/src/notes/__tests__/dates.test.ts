import { todayLocal } from '../dates.js';

// The timezone is passed explicitly rather than set via process.env.TZ. Node
// caches the host zone in V8 on first use and Jest's environment does not
// invalidate that cache on assignment, so a TZ-mutating test silently asserts
// against the host's own zone — passing or failing for reasons unrelated to the
// code. Passing the zone in keeps these assertions true on any CI machine.
describe('todayLocal', () => {
  test('west of UTC: an evening write is stamped with the local day, not tomorrow', () => {
    // 21:30 on Aug 6 in Eastern is already Aug 7 in UTC — the reported bug.
    const now = new Date('2026-08-07T01:30:00Z');

    expect(todayLocal(now, 'US/Eastern')).toBe('2026-08-06');
    expect(now.toISOString().split('T')[0]).toBe('2026-08-07'); // what it used to produce
  });

  test('east of UTC: an early-morning write is stamped with the local day, not yesterday', () => {
    // 00:30 on Aug 7 in Tokyo is still Aug 6 in UTC — the same bug, mirrored.
    const now = new Date('2026-08-06T15:30:00Z');

    expect(todayLocal(now, 'Asia/Tokyo')).toBe('2026-08-07');
    expect(now.toISOString().split('T')[0]).toBe('2026-08-06'); // what it used to produce
  });

  test('at UTC the result is unchanged from the previous behaviour', () => {
    const now = new Date('2026-08-06T21:30:00Z');

    expect(todayLocal(now, 'UTC')).toBe('2026-08-06');
    expect(todayLocal(now, 'UTC')).toBe(now.toISOString().split('T')[0]);
  });

  test('pads single-digit months and days to YYYY-MM-DD', () => {
    expect(todayLocal(new Date('2026-01-02T12:00:00Z'), 'UTC')).toBe('2026-01-02');
    expect(todayLocal(new Date('2026-12-31T12:00:00Z'), 'UTC')).toBe('2026-12-31');
  });

  test('handles a zone whose offset is not a whole hour', () => {
    // 00:15 on Aug 7 in Kolkata (UTC+05:30) is 18:45 Aug 6 in UTC.
    expect(todayLocal(new Date('2026-08-06T18:45:00Z'), 'Asia/Kolkata')).toBe('2026-08-07');
  });

  test('rolls the year over at local midnight, not UTC midnight', () => {
    // 20:00 on Dec 31 in Eastern is already Jan 1 in UTC.
    expect(todayLocal(new Date('2027-01-01T01:00:00Z'), 'US/Eastern')).toBe('2026-12-31');
  });

  test('uses the host zone and returns YYYY-MM-DD when no zone is given', () => {
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Host-zone default must agree with naming that zone explicitly.
    const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date('2026-08-07T01:30:00Z');
    expect(todayLocal(now)).toBe(todayLocal(now, hostZone));
  });
});
