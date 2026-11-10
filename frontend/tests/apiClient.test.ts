import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  apiClient,
  ApiClientError,
  setCsrfToken,
  getCsrfToken,
  fetchCsrfToken,
  fetchTextWithTimeout,
  AUTH_CHECK_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  CSRF_REQUEST_TIMEOUT_MS,
} from '../src/lib/apiClient.js';
import { authApi } from '../src/features/auth/authApi.js';

describe('Frontend API Client Test Suite (Timeouts, Errors, Credentials & CSRF)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    setCsrfToken(null);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('1. Successfully executes an API request and parses JSON data', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, count: 5 }),
    } as Response);

    const res = await apiClient<{ success: boolean; count: number }>('/api/v1/test');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ success: true, count: 5 });
  });

  it('2. Properly surfaces valid HTTP 401 response with UNAUTHORIZED code', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ success: false, message: 'No active authenticated session found.' }),
    } as Response);

    await expect(apiClient('/api/v1/auth/me')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'No active authenticated session found.',
    });
  });

  it('3. Surfaces HTTP 403 Forbidden with FORBIDDEN code', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ success: false, message: 'Origin or Referer not permitted.' }),
    } as Response);

    await expect(apiClient('/api/v1/restricted')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('4. Surfaces HTTP 429 Too Many Requests with TOO_MANY_REQUESTS code', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ success: false, isLocked: true, message: 'Too many attempts.' }),
    } as Response);

    await expect(apiClient('/api/v1/auth/login', { method: 'POST' })).rejects.toMatchObject({
      status: 429,
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('5. Surfaces HTTP 500 Server Error with SERVER_ERROR code', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ success: false, message: 'Internal Server Error' }),
    } as Response);

    await expect(apiClient('/api/v1/error')).rejects.toMatchObject({
      status: 500,
      code: 'SERVER_ERROR',
    });
  });

  it('6. Surfaces HTTP 502 Bad Gateway and HTTP 503 Service Unavailable', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => '<html><body>Bad Gateway</body></html>',
    } as Response);

    await expect(apiClient('/api/v1/auth/me')).rejects.toMatchObject({
      status: 502,
      code: 'SERVER_ERROR',
    });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ success: false, message: 'Database service unready' }),
    } as Response);

    await expect(apiClient('/api/v1/auth/me')).rejects.toMatchObject({
      status: 503,
      code: 'SERVER_ERROR',
    });
  });

  it('7. Surfaces network connection failure as NETWORK_ERROR', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiClient('/api/v1/auth/me')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: expect.stringContaining('Unable to connect to the Khata server'),
    });
  });

  it('8. Aborts and surfaces REQUEST_TIMEOUT when request exceeds timeoutMs', async () => {
    // Simulate a hung fetch using a promise that only resolves after abort
    global.fetch = vi.fn().mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The user aborted a request.', 'AbortError'));
        });
      });
    });

    await expect(
      apiClient('/api/v1/auth/me', { timeoutMs: 50 })
    ).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      message: expect.stringContaining('took too long to respond'),
    });
  });

  it('9. Aborts and surfaces REQUEST_TIMEOUT when reading response body hangs beyond timeout', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('Body reading timed out', 'AbortError')), 100);
        }),
    } as unknown as Response);

    await expect(
      fetchTextWithTimeout('https://erp-api.algions.in/api/v1/hang', {}, 40)
    ).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    });
  });

  it('10. Safely handles invalid JSON and empty text responses without crashing', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => 'Not Valid JSON',
    } as Response);

    const resInvalid = await apiClient<{ rawText?: string }>('/api/v1/test');
    expect(resInvalid.status).toBe(200);
    expect(resInvalid.data).toEqual({ rawText: 'Not Valid JSON' });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => '',
    } as Response);

    const resEmpty = await apiClient('/api/v1/empty');
    expect(resEmpty.status).toBe(204);
    expect(resEmpty.data).toEqual({});
  });

  it('11. Always includes credentials: "include" on every request', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    } as Response);
    global.fetch = fetchSpy;

    await apiClient('/api/v1/auth/me');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/auth/me'),
      expect.objectContaining({
        credentials: 'include',
      })
    );
  });

  it('12. Attaches X-CSRF-Token header on state-changing methods', async () => {
    setCsrfToken('mock_csrf_token_12345');
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true }),
    } as Response);
    global.fetch = fetchSpy;

    await apiClient('/api/v1/khata/customers', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ramesh Hardware' }),
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/khata/customers'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-CSRF-Token': 'mock_csrf_token_12345',
        }),
      })
    );
  });

  it('13. Login endpoint does NOT fetch CSRF token before calling /auth/login', async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/v1/auth/csrf-token')) {
        throw new Error('CSRF token must NOT be requested prior to login!');
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            authenticated: true,
            csrfToken: 'new_token_from_login_response',
          }),
      } as Response);
    });
    global.fetch = fetchSpy;

    const res = await authApi.login('9876543210', 'Password123!');
    expect(res.authenticated).toBe(true);
    expect(getCsrfToken()).toBe('new_token_from_login_response');
  });

  it('14. Retries once on 403 CSRF token error and does NOT loop infinitely', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/v1/auth/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ csrfToken: 'refreshed_csrf_token_999' }),
        } as Response);
      }

      callCount++;
      // Return 403 CSRF token error
      return Promise.resolve({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ success: false, message: 'Invalid or missing CSRF token.' }),
      } as Response);
    });

    // Should retry once and then stop with an error, not loop infinitely
    await expect(
      apiClient('/api/v1/khata/transactions', {
        method: 'POST',
        body: JSON.stringify({ amount: 100 }),
      })
    ).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });

    // 1 initial call + 1 retry call = exactly 2 calls
    expect(callCount).toBe(2);
  });

  it('15. Verifies default timeout durations for auth check and general requests', () => {
    expect(AUTH_CHECK_TIMEOUT_MS).toBe(75_000);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(CSRF_REQUEST_TIMEOUT_MS).toBe(45_000);
  });
});
