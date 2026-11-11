import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../../lib/apiClient.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { CATALOGUE_PAGE_SIZE } from '../../utils/billingLimits.js';

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
}

interface UsePaginatedCatalogueConfig<T extends { id: number }> {
  fetchPage: (
    query: string,
    offset: number,
    signal: AbortSignal
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
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery, 300);

  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<CataloguePaginationMeta>({
    hasMore: false,
    nextOffset: null,
  });

  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeQueryRef = useRef('');

  const runFetch = useCallback(
    async (rawQuery: string, offset: number, append: boolean) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const requestId = ++requestIdRef.current;
      const trimmedQuery = rawQuery.trim();
      activeQueryRef.current = trimmedQuery;

      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      try {
        const result = await fetchPage(trimmedQuery, offset, controller.signal);
        if (controller.signal.aborted || requestId !== requestIdRef.current) {
          return;
        }

        setItems((prev) => {
          if (!append) {
            return result.items;
          }
          const seenIds = new Set(prev.map((row) => Number(row.id)));
          const uniqueNext = result.items.filter((row) => !seenIds.has(Number(row.id)));
          return [...prev, ...uniqueNext];
        });
        setPagination({
          hasMore: Boolean(result.pagination?.hasMore),
          nextOffset: result.pagination?.hasMore ? result.pagination.nextOffset ?? null : null,
        });
      } catch (err: any) {
        if (controller.signal.aborted || err?.name === 'AbortError' || err?.code === 'ABORTED') {
          return;
        }
        if (requestId !== requestIdRef.current) {
          return;
        }
        setError(err?.message || errorFallbackMessage);
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [fetchPage, errorFallbackMessage]
  );

  useEffect(() => {
    void runFetch(debouncedSearch, 0, false);
    return () => {
      abortControllerRef.current?.abort();
      requestIdRef.current += 1;
    };
  }, [debouncedSearch, runFetch]);

  const loadMore = useCallback(() => {
    if (!pagination.hasMore || pagination.nextOffset === null || isLoading || isLoadingMore) {
      return;
    }
    void runFetch(activeQueryRef.current, pagination.nextOffset, true);
  }, [pagination.hasMore, pagination.nextOffset, isLoading, isLoadingMore, runFetch]);

  const prependItem = useCallback((created: T) => {
    setItems((prev) => {
      const withoutDup = prev.filter((row) => Number(row.id) !== Number(created.id));
      return [created, ...withoutDup];
    });
  }, []);

  const refresh = useCallback(() => {
    void runFetch(searchQuery, 0, false);
  }, [runFetch, searchQuery]);

  return {
    items,
    searchQuery,
    setSearchQuery,
    isLoading,
    isLoadingMore,
    error,
    hasMore: pagination.hasMore,
    nextOffset: pagination.nextOffset,
    loadMore,
    prependItem,
    refresh,
  };
}

export function usePaginatedProductSearch() {
  const fetchPage = useCallback(async (query: string, offset: number, signal: AbortSignal) => {
    const qs = new URLSearchParams({
      limit: String(CATALOGUE_PAGE_SIZE),
      offset: String(offset),
    });
    if (query) {
      qs.set('search', query);
    }

    const res = await apiClient<{
      success: boolean;
      data?: ProductCatalogOption[];
      products?: ProductCatalogOption[];
      pagination?: { hasMore?: boolean; nextOffset?: number | null };
    }>(`/api/v1/products?${qs.toString()}`, { signal });

    const list = res.data?.data || res.data?.products || [];
    const hasMore = Boolean(res.data?.pagination?.hasMore);
    return {
      items: Array.isArray(list) ? list : [],
      pagination: {
        hasMore,
        nextOffset: res.data?.pagination?.nextOffset ?? (hasMore ? offset + CATALOGUE_PAGE_SIZE : null),
      },
    };
  }, []);

  return usePaginatedCatalogue<ProductCatalogOption>({
    fetchPage,
    errorFallbackMessage: 'Failed to search product catalogue.',
  });
}

export function usePaginatedCustomerSearch() {
  const fetchPage = useCallback(async (query: string, offset: number, signal: AbortSignal) => {
    const qs = new URLSearchParams({
      limit: String(CATALOGUE_PAGE_SIZE),
      offset: String(offset),
    });
    if (query) {
      qs.set('search', query);
    }

    const res = await apiClient<{
      success: boolean;
      customers?: CustomerCatalogOption[];
      data?: CustomerCatalogOption[];
      pagination?: { hasMore?: boolean; nextOffset?: number | null };
    }>(`/api/v1/khata/customers?${qs.toString()}`, { signal });

    const list = res.data?.customers || res.data?.data || [];
    const hasMore = Boolean(res.data?.pagination?.hasMore);
    return {
      items: Array.isArray(list) ? list : [],
      pagination: {
        hasMore,
        nextOffset: res.data?.pagination?.nextOffset ?? (hasMore ? offset + CATALOGUE_PAGE_SIZE : null),
      },
    };
  }, []);

  return usePaginatedCatalogue<CustomerCatalogOption>({
    fetchPage,
    errorFallbackMessage: 'Failed to search customers.',
  });
}
