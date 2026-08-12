/**
 * Format a moment as `YYYY-MM-DD` in a given timezone, defaulting to the
 * host's local zone.
 *
 * Every "now" stamp the server writes goes through here. The distinction
 * matters: `toISOString()` is always UTC, so on a host west of Greenwich an
 * evening write is stamped with tomorrow's date — a date that has not happened
 * yet locally — and east of Greenwich an early-morning write is stamped with
 * yesterday's. Both skews are silent and permanent once written to a note.
 *
 * `timeZone` exists so the behaviour can be tested across zones. Node caches
 * the host zone in V8 on first use, and under Jest's environment assigning
 * `process.env.TZ` mid-process does not invalidate that cache — so a test that
 * sets `TZ` and calls this would silently assert against the host's own zone
 * and pass for the wrong reason. Production callers omit it.
 *
 * Only applies to stamps generated from the current time. Dates already parsed
 * out of frontmatter must keep using `toISOString()`: js-yaml reads a bare
 * `2026-08-06` as UTC midnight, so converting those to local time would shift
 * them back a day in the opposite direction.
 */
export function todayLocal(now: Date = new Date(), timeZone?: string): string {
  // Assembled from parts rather than a formatted string so the output shape is
  // fixed by this code, not by the locale's date formatting conventions.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const get = (type: 'year' | 'month' | 'day'): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Could not format ${type} for timezone "${timeZone ?? 'host'}"`);
    return part.value;
  };

  return `${get('year')}-${get('month')}-${get('day')}`;
}
