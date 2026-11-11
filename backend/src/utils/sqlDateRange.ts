import { env } from '../config/env.js';

export interface SqlDateRangeFilter {
  clause: string;
  params: unknown[];
}

/**
 * Builds a sargable TIMESTAMPTZ range predicate for a timestamptz column
 * filtered by inclusive YYYY-MM-DD business calendar dates:
 *   col >= ($from::date::timestamp AT TIME ZONE $tz)
 *   AND col < (($to::date + 1)::timestamp AT TIME ZONE $tz)
 *
 * Returns `{ clause: 'TRUE', params: [] }` with ZERO unused parameters when
 * neither bound is supplied (preventing PostgreSQL 08P01 unused-bind errors).
 */
export function buildBusinessTimestampRangeFilter(
  columnSql: string,
  fromDate?: string | null,
  toDate?: string | null,
  timeZone: string = env.BUSINESS_TIME_ZONE || 'Asia/Kolkata',
  startParamIdx: number = 1,
  sharedTimeZoneParamIdx?: number
): SqlDateRangeFilter {
  const cleanFrom = fromDate?.trim() || undefined;
  const cleanTo = toDate?.trim() || undefined;
  if (!cleanFrom && !cleanTo) {
    return { clause: 'TRUE', params: [] };
  }

  const params: unknown[] = [];
  let tzIdx: number;
  let nextIdx = startParamIdx;

  if (sharedTimeZoneParamIdx !== undefined) {
    tzIdx = sharedTimeZoneParamIdx;
  } else {
    params.push(timeZone);
    tzIdx = nextIdx;
    nextIdx += 1;
  }

  const clauses: string[] = [];
  if (cleanFrom) {
    params.push(cleanFrom);
    clauses.push(`${columnSql} >= ($${nextIdx}::date::timestamp AT TIME ZONE $${tzIdx})`);
    nextIdx += 1;
  }
  if (cleanTo) {
    params.push(cleanTo);
    clauses.push(`${columnSql} < (($${nextIdx}::date + 1)::timestamp AT TIME ZONE $${tzIdx})`);
    nextIdx += 1;
  }

  return {
    clause: clauses.join(' AND '),
    params,
  };
}
