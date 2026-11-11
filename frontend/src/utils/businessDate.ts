export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Kolkata';

export function getDefaultBusinessTimeZone(): string {
  const configured =
    typeof import.meta !== 'undefined' && (import.meta as any)?.env?.VITE_BUSINESS_TIME_ZONE
      ? String((import.meta as any).env.VITE_BUSINESS_TIME_ZONE).trim()
      : '';
  return configured || DEFAULT_BUSINESS_TIMEZONE;
}

/**
 * Returns YYYY-MM-DD in the configured shop business timezone (defaults to Asia/Kolkata).
 * Never uses UTC toISOString().slice(0, 10), avoiding midnight rollover bugs between IST and UTC.
 */
export function getBusinessDateISO(
  timeZone: string = getDefaultBusinessTimeZone(),
  now: Date = new Date()
): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to format business date in timezone ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

export function isValidBusinessDate(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

/**
 * Adds integer calendar days relative to a YYYY-MM-DD business date without local timezone shifts.
 */
export function addBusinessCalendarDays(
  days: number,
  baseDateISO?: string,
  timeZone: string = getDefaultBusinessTimeZone()
): string {
  const anchor = baseDateISO && isValidBusinessDate(baseDateISO)
    ? baseDateISO.trim()
    : getBusinessDateISO(timeZone);
  const [y, m, d] = anchor.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + Math.trunc(days)));
  const sy = shifted.getUTCFullYear();
  const sm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const sd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${sy}-${sm}-${sd}`;
}
