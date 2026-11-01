import { useState, useEffect, useRef, useCallback } from 'react';
import { useDebouncedValue } from './useDebouncedValue.js';

export interface RemoteSearchResult<T> {
  items: T[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface UseRemoteSearchOptions<T> {
  fetcher: (query: string, offset: number, signal: AbortSignal) => Promise<RemoteSearchResult<T>>;
  pageSize?: number;
  debounceMs?: number;
  enabled?: boolean;
}

export function useRemoteSearch<T>({
  fetcher,
  pageSize: _pageSize = 25,
  debounceMs = 280,
  enabled = true,
}: UseRemoteSearchOptions<T>) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, debounceMs);

  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isError, setIsError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const executeFetch = useCallback(
    async (searchQuery: string, offset = 0, isInitialOrSearchChange = true) => {
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
      } else {
        setIsLoadingMore(true);
      }

      try {
        const result = await fetcher(searchQuery, offset, controller.signal);

        // Guard against race conditions and stale responses
        if (currentRequestId !== requestIdRef.current) return;

        setItems((prev) => (isInitialOrSearchChange ? result.items : [...prev, ...result.items]));
        setHasMore(result.hasMore);
        setNextOffset(result.nextOffset);
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
    [enabled, fetcher]
  );

  // Trigger search when debounced query changes
  useEffect(() => {
    if (!enabled) return;
    void executeFetch(debouncedQuery, 0, true);
  }, [debouncedQuery, enabled, executeFetch]);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore || isLoading || nextOffset === null) return;
    void executeFetch(debouncedQuery, nextOffset, false);
  }, [hasMore, isLoadingMore, isLoading, nextOffset, executeFetch, debouncedQuery]);

  const retry = useCallback(() => {
    void executeFetch(debouncedQuery, 0, true);
  }, [executeFetch, debouncedQuery]);

  const reset = useCallback(() => {
    setQuery('');
    setItems([]);
    setHasMore(false);
    setNextOffset(null);
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
    loadMore,
    retry,
    reset,
  };
}
