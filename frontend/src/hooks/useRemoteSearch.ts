import { useState, useEffect, useRef, useCallback } from 'react';
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
  const [debouncedState, setDebouncedState] = useState<{ query: string; nonce: number }>({
    query: '',
    nonce: 0,
  });

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
  const isLoadingMoreRef = useRef(false);
  const activeQueryRef = useRef('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needsRefetchOnRestoreRef = useRef(false);
  const suppressNextResetEffectRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const getItemKeyRef = useRef(getItemKey);
  getItemKeyRef.current = getItemKey;

  const abortAndInvalidate = useCallback(() => {
    requestIdRef.current += 1;
    isLoadingMoreRef.current = false;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  // Unmount cleanup: clear pending debounce and invalidate any in-flight request
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      abortAndInvalidate();
    };
  }, [abortAndInvalidate]);

  // Immediate query change handler: clears stale results and resets cursors during debounce
  const setQuery = useCallback(
    (newQuery: string) => {
      setQueryState(newQuery);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      if (newQuery !== debouncedState.query) {
        needsRefetchOnRestoreRef.current = true;
        abortAndInvalidate();
        setItems([]);
        setHasMore(false);
        setNextOffset(null);
        setNextCursor(null);
        setIsLoading(enabledRef.current);
        setIsLoadingMore(false);
        setIsError(false);
        setErrorMessage(null);
      }

      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        setDebouncedState((prev) => {
          if (newQuery === prev.query && !needsRefetchOnRestoreRef.current) {
            return prev;
          }
          needsRefetchOnRestoreRef.current = false;
          return { query: newQuery, nonce: prev.nonce + 1 };
        });
      }, debounceMs);
    },
    [debouncedState.query, debounceMs, abortAndInvalidate]
  );

  const executeFetch = useCallback(
    async (
      searchQuery: string,
      offset = 0,
      isInitialOrSearchChange = true,
      cursor: string | null = null
    ) => {
      if (!enabled) return;

      abortAndInvalidate();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const currentRequestId = requestIdRef.current;

      if (isInitialOrSearchChange) {
        activeQueryRef.current = searchQuery;
        isLoadingMoreRef.current = false;
        setItems([]); // Clear stale items from previous query immediately
        setHasMore(false);
        setNextOffset(null);
        setNextCursor(null);
        setIsLoading(true);
        setIsLoadingMore(false);
        setIsError(false);
        setErrorMessage(null);
      } else {
        isLoadingMoreRef.current = true;
        setIsLoadingMore(true);
      }

      try {
        const result = await fetcherRef.current(searchQuery, offset, pageSize, controller.signal, cursor);

        // Guard against race conditions, ignored abort signals, and stale responses
        if (controller.signal.aborted || currentRequestId !== requestIdRef.current) {
          return;
        }

        const currentGetItemKey = getItemKeyRef.current;
        const keyExtractor =
          currentGetItemKey ||
          ((item: T) => {
            if (item && typeof item === 'object' && 'id' in item) {
              return (item as { id: string | number }).id;
            }
            return Symbol() as unknown as string;
          });

        const useKeyDedup = Boolean(
          currentGetItemKey || (result.items[0] && typeof result.items[0] === 'object' && 'id' in result.items[0])
        );

        setItems((prev) =>
          isInitialOrSearchChange
            ? useKeyDedup
              ? mergeUniqueByKey([], result.items, keyExtractor)
              : result.items
            : useKeyDedup
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
        if (controller.signal.aborted || currentRequestId !== requestIdRef.current) {
          return;
        }
        if ((err as Error)?.name === 'AbortError' || (err as { code?: string })?.code === 'ABORTED') {
          return;
        }

        setIsError(true);
        setErrorMessage((err as Error)?.message || 'Failed to fetch search results.');
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (!controller.signal.aborted && currentRequestId === requestIdRef.current) {
          isLoadingMoreRef.current = false;
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [enabled, pageSize, abortAndInvalidate]
  );

  // Trigger search when enabled and debounced query changes; invalidate immediately if disabled
  useEffect(() => {
    if (!enabled) {
      suppressNextResetEffectRef.current = false;
      abortAndInvalidate();
      setIsLoading(false);
      setIsLoadingMore(false);
      return;
    }
    if (suppressNextResetEffectRef.current) {
      suppressNextResetEffectRef.current = false;
      return;
    }
    needsRefetchOnRestoreRef.current = false;
    void executeFetch(debouncedState.query, 0, true, null);
  }, [debouncedState, enabled, executeFetch, abortAndInvalidate]);

  const loadMore = useCallback(() => {
    if (
      !enabled ||
      !hasMore ||
      isLoadingMore ||
      isLoading ||
      isLoadingMoreRef.current ||
      query !== activeQueryRef.current
    ) {
      return;
    }
    const useCursor = typeof nextCursor === 'string' && nextCursor.length > 0;
    if (!useCursor && nextOffset === null) return;
    isLoadingMoreRef.current = true;
    void executeFetch(activeQueryRef.current, nextOffset ?? 0, false, useCursor ? nextCursor : null);
  }, [enabled, hasMore, isLoadingMore, isLoading, query, nextCursor, nextOffset, executeFetch]);

  const retry = useCallback(() => {
    if (!enabled) return;
    needsRefetchOnRestoreRef.current = false;
    void executeFetch(query, 0, true, null);
  }, [enabled, executeFetch, query]);

  const reset = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    needsRefetchOnRestoreRef.current = false;
    abortAndInvalidate();
    setQueryState('');
    setDebouncedState((prev) => {
      if (prev.query === '') {
        return prev;
      }
      if (enabledRef.current) {
        suppressNextResetEffectRef.current = true;
      }
      return { query: '', nonce: prev.nonce };
    });
    activeQueryRef.current = '';
    setItems([]);
    setHasMore(false);
    setNextOffset(null);
    setNextCursor(null);
    setIsLoading(false);
    setIsLoadingMore(false);
    setIsError(false);
    setErrorMessage(null);
  }, [abortAndInvalidate]);

  return {
    query,
    setQuery,
    debouncedQuery: debouncedState.query,
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
