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

function getAnchorBusinessDate(
  baseDateISO?: string,
  timeZone: string = getDefaultBusinessTimeZone()
): string {
  return baseDateISO && isValidBusinessDate(baseDateISO)
    ? baseDateISO.trim()
    : getBusinessDateISO(timeZone);
}

/**
 * Returns full calendar-month start and end ISO dates shifted by `monthsDelta` relative
 * to the configured business date (safe across year boundaries and leap-year Feb).
 */
export function getShiftedBusinessMonthRange(
  monthsDelta: number,
  baseDateISO?: string,
  timeZone: string = getDefaultBusinessTimeZone()
): { fromDate: string; toDate: string } {
  const anchor = getAnchorBusinessDate(baseDateISO, timeZone);
  const [y, m] = anchor.split('-').map(Number);
  const totalMonths = y * 12 + (m - 1) + Math.trunc(monthsDelta);
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12 + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const ym = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
  return {
    fromDate: `${ym}-01`,
    toDate: `${ym}-${String(lastDay).padStart(2, '0')}`,
  };
}

export function getPreviousBusinessMonthRange(
  baseDateISO?: string,
  timeZone: string = getDefaultBusinessTimeZone()
): { fromDate: string; toDate: string } {
  return getShiftedBusinessMonthRange(-1, baseDateISO, timeZone);
}

/**
 * Computes Indian Financial Year bounds (April 1 to March 31) in business timezone.
 * - For fyOffset = 0 ("This FY"): Apr 1 of current FY through anchor business date.
 * - For fyOffset = -1 ("Previous FY"): Apr 1 to Mar 31 of the immediately preceding FY.
 */
export function getIndianFinancialYearRange(
  fyOffset = 0,
  baseDateISO?: string,
  timeZone: string = getDefaultBusinessTimeZone()
): { fromDate: string; toDate: string } {
  const anchor = getAnchorBusinessDate(baseDateISO, timeZone);
  const [year, month] = anchor.split('-').map(Number);
  const currentFyStartYear = month >= 4 ? year : year - 1;
  const targetStartYear = currentFyStartYear + Math.trunc(fyOffset);
  const fromDate = `${targetStartYear}-04-01`;
  const fyEndDate = `${targetStartYear + 1}-03-31`;

  if (fyOffset === 0) {
    return {
      fromDate,
      toDate: anchor < fyEndDate ? anchor : fyEndDate,
    };
  }

  return {
    fromDate,
    toDate: fyEndDate,
  };
}
