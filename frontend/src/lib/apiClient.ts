/**
 * Central Credentialed API Client
 * - All requests use credentials: 'include' (cookies sent automatically)
 * - In-memory CSRF token handling for state-changing requests
 * - No auth tokens or session IDs saved in localStorage / sessionStorage
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? '' : 'https://api-khata.algions.in');

let inMemoryCsrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  inMemoryCsrfToken = token;
}

export function getCsrfToken(): string | null {
  return inMemoryCsrfToken;
}

export async function fetchCsrfToken(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/auth/csrf-token`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (res.ok) {
      const data = await res.json();
      inMemoryCsrfToken = data.csrfToken;
      return data.csrfToken;
    }
  } catch (err) {
    console.warn('[API CLIENT] Unable to fetch CSRF token:', err);
  }
  return null;
}

export async function apiClient<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
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

  // Attach in-memory CSRF token on state-changing methods
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (!inMemoryCsrfToken) {
      await fetchCsrfToken();
    }
    if (inMemoryCsrfToken) {
      headers['X-CSRF-Token'] = inMemoryCsrfToken;
    }
  }

  const response = await fetch(url, {
    ...options,
    credentials: 'include', // ALWAYS include credentials (HttpOnly cookie)
    headers,
  });

  const text = await response.text();
  let data: T;
  try {
    data = text ? JSON.parse(text) : ({} as T);
  } catch {
    data = { rawText: text } as unknown as T;
  }

  if (!response.ok) {
    const errorPayload = data as { message?: string; isLocked?: boolean; remainingMs?: number };
    const err = new Error(errorPayload.message || `Request failed with status ${response.status}`);
    (err as unknown as { status: number; payload: unknown }).status = response.status;
    (err as unknown as { status: number; payload: unknown }).payload = errorPayload;
    throw err;
  }

  return { data, status: response.status };
}
