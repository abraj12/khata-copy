/**
 * Returns current business date in YYYY-MM-DD format for a given timezone (defaults to Asia/Kolkata)
 */
export function getBusinessDateISO(
  timeZone = 'Asia/Kolkata',
  now = new Date()
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Validates whether a string is a real calendar date in YYYY-MM-DD format.
 * Pure UTC-safe evaluation avoiding timezone shifting and leap year edge cases.
 */
export function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Checks if a given validity date string (YYYY-MM-DD) is strictly prior to today's business date.
 */
export function isBusinessDateExpired(
  validUntil: string | null | undefined,
  timeZone = 'Asia/Kolkata'
): boolean {
  if (!validUntil || !validUntil.trim()) return false;
  const todayIso = getBusinessDateISO(timeZone);
  return validUntil.trim() < todayIso;
}
