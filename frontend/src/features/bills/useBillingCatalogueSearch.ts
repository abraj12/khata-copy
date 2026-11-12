import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../../lib/apiClient.js';
import { CATALOGUE_PAGE_SIZE } from '../../utils/billingLimits.js';
import {
  buildPaginatedSearchParams,
  mergeUniqueById,
} from '../../types/pagination.js';

export interface ProductCatalogOption {
  id: number;
  name: string;
  buying_price: string;
  hsn_code?: string | null;
  barcode?: string | null;
}

export interface CustomerCatalogOption {
  id: number;
  name: string;
  phone: string | null;
  address?: string | null;
  gstin?: string | null;
  state?: string | null;
  state_code?: string | null;
}

export interface CataloguePaginationMeta {
  hasMore: boolean;
  nextOffset: number | null;
  nextCursor?: string | null;
  total?: number | null;
  totalIsExact?: boolean;
}

interface UsePaginatedCatalogueConfig<T extends { id: number }> {
  fetchPage: (
    query: string,
    offset: number,
    signal: AbortSignal,
    cursor?: string | null
  ) => Promise<{
    items: T[];
    pagination: CataloguePaginationMeta;
  }>;
  errorFallbackMessage: string;
}

/**
 * Shared server-side search and pagination hook for large catalogues (products, customers).
 * Guarded by both AbortController and monotonic request IDs so rapid queries or late
 * responses can never overwrite newer results or duplicate appended records.
 */
function usePaginatedCatalogue<T extends { id: number }>({
  fetchPage,
  errorFallbackMessage,
}: UsePaginatedCatalogueConfig<T>) {
  const [searchQuery, setSearchQueryState] = useState('');
  const [debouncedState, setDebouncedState] = useState<{ query: string; nonce: number }>({
    query: '',
    nonce: 0,
  });

  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isServiceUnavailable, setIsServiceUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<CataloguePaginationMeta>({
    hasMore: false,
    nextOffset: null,
    nextCursor: null,
    total: null,
    totalIsExact: false,
  });

  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isLoadingMoreRef = useRef(false);
  const activeQueryRef = useRef('');
  const debouncedQueryRef = useRef('');
  debouncedQueryRef.current = debouncedState.query;
  const fetchPageRef = useRef(fetchPage);
  fetchPageRef.current = fetchPage;
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needsRefetchOnRestoreRef = useRef(false);

  const abortAndInvalidate = useCallback(() => {
    requestIdRef.current += 1;
    isLoadingMoreRef.current = false;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      abortAndInvalidate();
    };
  }, [abortAndInvalidate]);

  const setSearchQuery = useCallback(
    (nextQuery: string) => {
      setSearchQueryState(nextQuery);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      const trimmedNext = nextQuery.trim();
      if (trimmedNext !== debouncedQueryRef.current.trim()) {
        needsRefetchOnRestoreRef.current = true;
        abortAndInvalidate();
        setItems([]);
        setPagination({
          hasMore: false,
          nextOffset: null,
          nextCursor: null,
          total: null,
          totalIsExact: false,
        });
        setIsLoading(true);
        setIsLoadingMore(false);
        setError(null);
      }

      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        setDebouncedState((prev) => {
          if (trimmedNext === prev.query.trim() && !needsRefetchOnRestoreRef.current) {
            return prev;
          }
          needsRefetchOnRestoreRef.current = false;
          return { query: trimmedNext, nonce: prev.nonce + 1 };
        });
      }, 300);
    },
    [abortAndInvalidate]
  );

  const runFetch = useCallback(
    async (rawQuery: string, offset: number, append: boolean, cursor: string | null = null) => {
      abortAndInvalidate();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const requestId = requestIdRef.current;
      const trimmedQuery = rawQuery.trim();
      activeQueryRef.current = trimmedQuery;

      if (append) {
        isLoadingMoreRef.current = true;
        setIsLoadingMore(true);
      } else {
        isLoadingMoreRef.current = false;
        setPagination({
          hasMore: false,
          nextOffset: null,
          nextCursor: null,
          total: null,
          totalIsExact: false,
        });
        setIsLoading(true);
        setIsLoadingMore(false);
      }
      setError(null);

      try {
        const result = await fetchPageRef.current(trimmedQuery, offset, controller.signal, cursor);
        if (controller.signal.aborted || requestId !== requestIdRef.current) {
          return;
        }

        setIsServiceUnavailable(false);
        setItems((prev) => (append ? mergeUniqueById(prev, result.items) : mergeUniqueById([], result.items)));
        const pageHasMore = Boolean(result.pagination?.hasMore);
        setPagination({
          hasMore: pageHasMore,
          nextOffset: pageHasMore ? (result.pagination?.nextOffset ?? null) : null,
          nextCursor: pageHasMore ? (result.pagination?.nextCursor ?? null) : null,
          total: result.pagination?.total ?? null,
          totalIsExact: result.pagination?.totalIsExact,
        });
      } catch (err: any) {
        if (controller.signal.aborted || err?.name === 'AbortError' || err?.code === 'ABORTED') {
          return;
        }
        if (requestId !== requestIdRef.current) {
          return;
        }
        const isUnavailable =
          err?.status === 503 ||
          err?.code === 'MANDATORY_SERVICE_UNAVAILABLE' ||
          err?.code === 'READ_MODEL_UNAVAILABLE' ||
          err?.code === 'SERVICE_UNAVAILABLE';
        setIsServiceUnavailable(isUnavailable);
        setError(
          isUnavailable
            ? 'Catalogue service is temporarily unavailable. Data updates will resume automatically.'
            : (err?.message || errorFallbackMessage)
        );
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (!controller.signal.aborted && requestId === requestIdRef.current) {
          isLoadingMoreRef.current = false;
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [errorFallbackMessage, abortAndInvalidate]
  );

  useEffect(() => {
    needsRefetchOnRestoreRef.current = false;
    void runFetch(debouncedState.query, 0, false, null);
    return () => {
      abortAndInvalidate();
    };
  }, [debouncedState, runFetch, abortAndInvalidate]);

  const loadMore = useCallback(() => {
    if (
      !pagination.hasMore ||
      isLoading ||
      isLoadingMore ||
      isLoadingMoreRef.current ||
      searchQuery.trim() !== activeQueryRef.current
    ) {
      return;
    }
    const useCursor = typeof pagination.nextCursor === 'string' && pagination.nextCursor.length > 0;
    if (!useCursor && pagination.nextOffset === null) {
      return;
    }
    isLoadingMoreRef.current = true;
    void runFetch(activeQueryRef.current, pagination.nextOffset ?? 0, true, useCursor ? pagination.nextCursor : null);
  }, [pagination.hasMore, pagination.nextCursor, pagination.nextOffset, isLoading, isLoadingMore, searchQuery, runFetch]);

  const prependItem = useCallback((created: T) => {
    setItems((prev) => {
      const withoutDup = prev.filter((row) => Number(row.id) !== Number(created.id));
      return [created, ...withoutDup];
    });
  }, []);

  const refresh = useCallback(() => {
    void runFetch(searchQuery.trim(), 0, false, null);
  }, [runFetch, searchQuery]);

  return {
    items,
    searchQuery,
    setSearchQuery,
    isLoading,
    isLoadingMore,
    isServiceUnavailable,
    error,
    hasMore: pagination.hasMore,
    nextOffset: pagination.nextOffset,
    nextCursor: pagination.nextCursor ?? null,
    total: pagination.total ?? null,
    totalIsExact: pagination.totalIsExact ?? false,
    loadMore,
    prependItem,
    refresh,
  };
}

export function usePaginatedProductSearch() {
  const fetchPage = useCallback(
    async (query: string, offset: number, signal: AbortSignal, cursor: string | null = null) => {
      const qs = buildPaginatedSearchParams({
        search: query,
        limit: CATALOGUE_PAGE_SIZE,
        offset,
        cursor,
      });

      const res = await apiClient<{
        success: boolean;
        data?: ProductCatalogOption[];
        products?: ProductCatalogOption[];
        pagination?: CataloguePaginationMeta;
      }>(`/api/v1/products?${qs.toString()}`, { signal });

      const list = res.data?.data || res.data?.products || [];
      const hasMore = Boolean(res.data?.pagination?.hasMore);
      const nextCursor = hasMore ? (res.data?.pagination?.nextCursor ?? null) : null;
      return {
        items: Array.isArray(list) ? list : [],
        pagination: {
          hasMore,
          nextOffset: hasMore
            ? (res.data?.pagination?.nextOffset ?? (!nextCursor ? offset + CATALOGUE_PAGE_SIZE : null))
            : null,
          nextCursor,
          total: res.data?.pagination?.total ?? null,
          totalIsExact: res.data?.pagination?.totalIsExact,
        },
      };
    },
    []
  );

  return usePaginatedCatalogue<ProductCatalogOption>({
    fetchPage,
    errorFallbackMessage: 'Failed to search product catalogue.',
  });
}

export function usePaginatedCustomerSearch() {
  const fetchPage = useCallback(
    async (query: string, offset: number, signal: AbortSignal, cursor: string | null = null) => {
      const qs = buildPaginatedSearchParams({
        search: query,
        limit: CATALOGUE_PAGE_SIZE,
        offset,
        cursor,
      });

      const res = await apiClient<{
        success: boolean;
        customers?: CustomerCatalogOption[];
        data?: CustomerCatalogOption[];
        pagination?: CataloguePaginationMeta;
      }>(`/api/v1/khata/customers?${qs.toString()}`, { signal });

      const list = res.data?.customers || res.data?.data || [];
      const hasMore = Boolean(res.data?.pagination?.hasMore);
      const nextCursor = hasMore ? (res.data?.pagination?.nextCursor ?? null) : null;
      return {
        items: Array.isArray(list) ? list : [],
        pagination: {
          hasMore,
          nextOffset: hasMore
            ? (res.data?.pagination?.nextOffset ?? (!nextCursor ? offset + CATALOGUE_PAGE_SIZE : null))
            : null,
          nextCursor,
          total: res.data?.pagination?.total ?? null,
          totalIsExact: res.data?.pagination?.totalIsExact,
        },
      };
    },
    []
  );

  return usePaginatedCatalogue<CustomerCatalogOption>({
    fetchPage,
    errorFallbackMessage: 'Failed to search customers.',
  });
}
