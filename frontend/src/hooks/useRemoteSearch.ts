import { useState, useEffect, useRef, useCallback } from 'react';
import { useDebouncedValue } from './useDebouncedValue.js';
import { mergeUniqueByKey } from '../types/pagination.js';

export interface RemoteSearchResult<T> {
  items: T[];
  hasMore: boolean;
  nextOffset: number | null;
  nextCursor?: string | null;
  total?: number | null;
  totalIsExact?: boolean;
}

export interface UseRemoteSearchOptions<T> {
  fetcher: (
    query: string,
    offset: number,
    limit: number,
    signal: AbortSignal,
    cursor?: string | null
  ) => Promise<RemoteSearchResult<T>>;
  pageSize?: number;
  debounceMs?: number;
  enabled?: boolean;
  getItemKey?: (item: T) => string | number;
}

export function useRemoteSearch<T>({
  fetcher,
  pageSize = 25,
  debounceMs = 280,
  enabled = true,
  getItemKey,
}: UseRemoteSearchOptions<T>) {
  const [query, setQueryState] = useState('');
  const debouncedQuery = useDebouncedValue(query, debounceMs);

  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isError, setIsError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  // Unmount cleanup: abort any in-flight request
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Immediate query change handler: clears stale results and resets cursors during debounce
  const setQuery = useCallback(
    (newQuery: string) => {
      setQueryState(newQuery);
      if (newQuery !== debouncedQuery) {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
        setItems([]);
        setHasMore(false);
        setNextOffset(null);
        setNextCursor(null);
        setIsLoading(true);
        setIsError(false);
        setErrorMessage(null);
      }
    },
    [debouncedQuery]
  );

  const executeFetch = useCallback(
    async (
      searchQuery: string,
      offset = 0,
      isInitialOrSearchChange = true,
      cursor: string | null = null
    ) => {
      if (!enabled) return;

      // Abort previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const currentRequestId = ++requestIdRef.current;

      if (isInitialOrSearchChange) {
        setIsLoading(true);
        setIsError(false);
        setErrorMessage(null);
        setItems([]); // Clear stale items from previous query immediately
      } else {
        setIsLoadingMore(true);
      }

      try {
        const result = await fetcher(searchQuery, offset, pageSize, controller.signal, cursor);

        // Guard against race conditions and stale responses
        if (currentRequestId !== requestIdRef.current) return;

        const keyExtractor =
          getItemKey ||
          ((item: T) => {
            if (item && typeof item === 'object' && 'id' in item) {
              return (item as { id: string | number }).id;
            }
            return Symbol() as unknown as string;
          });

        setItems((prev) =>
          isInitialOrSearchChange
            ? result.items
            : getItemKey || (result.items[0] && typeof result.items[0] === 'object' && 'id' in result.items[0])
              ? mergeUniqueByKey(prev, result.items, keyExtractor)
              : [...prev, ...result.items]
        );
        const pageHasMore = Boolean(result.hasMore);
        setHasMore(pageHasMore);
        setNextOffset(pageHasMore ? (result.nextOffset ?? null) : null);
        setNextCursor(pageHasMore ? (result.nextCursor ?? null) : null);
        setIsError(false);
        setErrorMessage(null);
      } catch (err) {
        if (currentRequestId !== requestIdRef.current) return;
        if ((err as Error).name === 'AbortError') return;

        setIsError(true);
        setErrorMessage((err as Error).message || 'Failed to fetch search results.');
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [enabled, fetcher, pageSize, getItemKey]
  );

  // Trigger search when debounced query changes
  useEffect(() => {
    if (!enabled) return;
    void executeFetch(debouncedQuery, 0, true, null);
  }, [debouncedQuery, enabled, executeFetch]);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore || isLoading) return;
    const useCursor = typeof nextCursor === 'string' && nextCursor.length > 0;
    if (!useCursor && nextOffset === null) return;
    void executeFetch(debouncedQuery, nextOffset ?? 0, false, useCursor ? nextCursor : null);
  }, [hasMore, isLoadingMore, isLoading, nextCursor, nextOffset, executeFetch, debouncedQuery]);

  const retry = useCallback(() => {
    void executeFetch(debouncedQuery, 0, true, null);
  }, [executeFetch, debouncedQuery]);

  const reset = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setQueryState('');
    setItems([]);
    setHasMore(false);
    setNextOffset(null);
    setNextCursor(null);
    setIsLoading(false);
    setIsLoadingMore(false);
    setIsError(false);
    setErrorMessage(null);
  }, []);

  return {
    query,
    setQuery,
    debouncedQuery,
    items,
    isLoading,
    isLoadingMore,
    isError,
    errorMessage,
    hasMore,
    nextOffset,
    nextCursor,
    loadMore,
    retry,
    reset,
  };
}
