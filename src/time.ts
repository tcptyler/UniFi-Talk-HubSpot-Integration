// Time zone helpers built on Intl, so "3 pm" means 3 pm where the business is, daylight saving included.

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(instant: number, timeZone: string): Record<string, number> {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(instant))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Minutes the zone is ahead of UTC at that instant (New York in winter: -300). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const t = Math.floor(instant.getTime() / 1000) * 1000;
  const p = parts(t, timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((asUtc - t) / 60_000);
}

/** The instant when the wall clock in `timeZone` shows the given date and time. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - zoneOffsetMinutes(new Date(wall), timeZone) * 60_000;
  // Check the offset at the result too, in case a daylight saving change sits between the two.
  const second = wall - zoneOffsetMinutes(new Date(first), timeZone) * 60_000;
  return new Date(second);
}
