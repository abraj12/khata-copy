export interface CursorPaginationMeta {
  limit?: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  nextCursor?: string | null;
  total?: number | null;
  totalIsExact?: boolean;
}

/**
 * Deduplicates paginated rows by entity ID while preserving server sort order.
 */
export function mergeUniqueById<T extends { id: number | string }>(prev: T[], next: T[]): T[] {
  if (next.length === 0) return prev;
  const seen = new Set(prev.map((item) => String(item.id)));
  const merged = [...prev];
  for (const item of next) {
    const key = String(item.id);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Deduplicates arbitrary remote search items when a key extractor is provided.
 */
export function mergeUniqueByKey<T>(
  prev: T[],
  next: T[],
  getKey?: (item: T) => string | number
): T[] {
  if (!getKey) {
    return [...prev, ...next];
  }
  const seen = new Set(prev.map((item) => String(getKey(item))));
  const merged = [...prev];
  for (const item of next) {
    const key = String(getKey(item));
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Builds search query params preferring opaque keyset cursor over offset when available.
 */
export function buildPaginatedSearchParams(params: {
  search?: string;
  limit: number;
  offset?: number;
  cursor?: string | null;
}): URLSearchParams {
  const qs = new URLSearchParams();
  if (params.search !== undefined && params.search !== '') {
    qs.set('search', params.search);
  }
  qs.set('limit', String(params.limit));
  if (params.cursor && params.cursor.trim().length > 0) {
    qs.set('cursor', params.cursor.trim());
  } else {
    qs.set('offset', String(Math.max(0, params.offset ?? 0)));
  }
  return qs;
}
