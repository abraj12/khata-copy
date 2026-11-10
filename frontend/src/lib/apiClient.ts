/**
 * Central Credentialed API Client
 * - All requests use credentials: 'include' (cookies sent automatically)
 * - Strict timeout-aware fetch helper with AbortController
 * - In-memory CSRF token handling for state-changing requests
 * - No auth tokens or session IDs saved in localStorage / sessionStorage
 */

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? '' : 'https://erp-api.algions.in');

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const AUTH_CHECK_TIMEOUT_MS = 75_000;
export const CSRF_REQUEST_TIMEOUT_MS = 45_000;

export class ApiClientError extends Error {
  status?: number;
  code: string;
  payload?: unknown;

  constructor(
    message: string,
    options: {
      status?: number;
      code: string;
      payload?: unknown;
    }
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = options.status;
    this.code = options.code;
    this.payload = options.payload;
  }
}

export interface TimedFetchResult {
  response: Response;
  text: string;
}

export async function fetchTextWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<TimedFetchResult> {
  const controller = new AbortController();
  let didTimeout = false;

  const externalSignal = options.signal;
  const abortFromExternalSignal = () => {
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: options.cache ?? 'no-store',
    });

    const text = await response.text();

    return {
      response,
      text,
    };
  } catch (error) {
    if (didTimeout) {
      throw new ApiClientError('The Khata server took too long to respond. Please retry.', {
        code: 'REQUEST_TIMEOUT',
      });
    }

    if (externalSignal?.aborted) {
      throw new ApiClientError('The request was cancelled.', {
        code: 'REQUEST_ABORTED',
      });
    }

    if (error instanceof ApiClientError) {
      throw error;
    }

    console.error('[API CLIENT] Network request failed:', error);

    throw new ApiClientError('Unable to connect to the Khata server. Check your internet connection and retry.', {
      code: 'NETWORK_ERROR',
    });
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternalSignal);
    }
  }
}

let inMemoryCsrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  inMemoryCsrfToken = token;
}

export function getCsrfToken(): string | null {
  return inMemoryCsrfToken;
}

export async function fetchCsrfToken(): Promise<string | null> {
  try {
    const { response, text } = await fetchTextWithTimeout(
      `${API_BASE_URL}/api/v1/auth/csrf-token`,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
        },
      },
      CSRF_REQUEST_TIMEOUT_MS
    );

    if (response.ok) {
      const data = text ? JSON.parse(text) : {};
      inMemoryCsrfToken = data.csrfToken || null;
      return inMemoryCsrfToken;
    }
  } catch (err) {
    console.warn('[API CLIENT] Unable to fetch CSRF token:', err);
  }
  return null;
}

export interface ApiClientOptions extends RequestInit {
  timeoutMs?: number;
  _isCsrfRetry?: boolean;
}

export async function apiClient<T = unknown>(
  endpoint: string,
  options: ApiClientOptions = {}
): Promise<{ data: T; status: number }> {
  const url = `${API_BASE_URL}${endpoint}`;
  const method = (options.method || 'GET').toUpperCase();

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  // If payload is provided and Content-Type not set, default to JSON
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  // Determine appropriate timeout
  let timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!options.timeoutMs) {
    if (endpoint.startsWith('/api/v1/auth/me')) {
      timeoutMs = AUTH_CHECK_TIMEOUT_MS;
    } else if (endpoint.startsWith('/api/v1/auth/csrf-token')) {
      timeoutMs = CSRF_REQUEST_TIMEOUT_MS;
    }
  }

  // Attach in-memory CSRF token on state-changing methods
  // CRITICAL: Do NOT fetch CSRF token before login, because /auth/login is deliberately exempt from CSRF
  const isLoginEndpoint = endpoint === '/api/v1/auth/login';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !isLoginEndpoint) {
    if (!inMemoryCsrfToken) {
      await fetchCsrfToken();
    }
    if (inMemoryCsrfToken) {
      headers['X-CSRF-Token'] = inMemoryCsrfToken;
    }
  }

  const { response, text } = await fetchTextWithTimeout(
    url,
    {
      ...options,
      credentials: 'include', // ALWAYS include credentials (HttpOnly cookie)
      headers,
    },
    timeoutMs
  );

  let data: T;
  try {
    data = text ? JSON.parse(text) : ({} as T);
  } catch {
    data = { rawText: text } as unknown as T;
  }

  if (!response.ok) {
    const errorPayload = (typeof data === 'object' && data !== null ? data : {}) as {
      message?: string;
      code?: string;
      isLocked?: boolean;
      remainingMs?: number;
    };

    // Auto-refresh CSRF token and retry once if token became stale or session refreshed
    if (
      response.status === 403 &&
      errorPayload.message?.includes('CSRF token') &&
      !options._isCsrfRetry
    ) {
      const refreshedToken = await fetchCsrfToken();
      if (refreshedToken) {
        return apiClient<T>(endpoint, {
          ...options,
          headers: {
            ...headers,
            'X-CSRF-Token': refreshedToken,
          },
          _isCsrfRetry: true,
        });
      }
    }

    const errorCode =
      errorPayload.code ||
      (response.status === 401
        ? 'UNAUTHORIZED'
        : response.status === 403
        ? 'FORBIDDEN'
        : response.status === 429
        ? 'TOO_MANY_REQUESTS'
        : response.status >= 500
        ? 'SERVER_ERROR'
        : 'API_ERROR');

    const err = new ApiClientError(
      errorPayload.message || `Request failed with status ${response.status}`,
      {
        status: response.status,
        code: errorCode,
        payload: errorPayload,
      }
    );
    throw err;
  }

  return { data, status: response.status };
}
