import { useState, useEffect, useRef, useCallback } from 'react';
import { useDebouncedValue } from './useDebouncedValue.js';

export interface RemoteSearchResult<T> {
  items: T[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface UseRemoteSearchOptions<T> {
  fetcher: (query: string, offset: number, limit: number, signal: AbortSignal) => Promise<RemoteSearchResult<T>>;
  pageSize?: number;
  debounceMs?: number;
  enabled?: boolean;
}

export function useRemoteSearch<T>({
  fetcher,
  pageSize = 25,
  debounceMs = 280,
  enabled = true,
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

  // Immediate query change handler: clears stale results and shows loading immediately during debounce
  const setQuery = useCallback(
    (newQuery: string) => {
      setQueryState(newQuery);
      if (newQuery !== debouncedQuery) {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
        setItems([]);
        setIsLoading(true);
        setIsError(false);
        setErrorMessage(null);
      }
    },
    [debouncedQuery]
  );

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
        setItems([]); // Clear stale items from previous query immediately
      } else {
        setIsLoadingMore(true);
      }

      try {
        const result = await fetcher(searchQuery, offset, pageSize, controller.signal);

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
    [enabled, fetcher, pageSize]
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
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setQueryState('');
    setItems([]);
    setHasMore(false);
    setNextOffset(null);
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
    loadMore,
    retry,
    reset,
  };
}
