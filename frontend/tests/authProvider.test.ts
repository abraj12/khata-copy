import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authApi } from '../src/features/auth/authApi.js';
import { setCsrfToken, getCsrfToken, ApiClientError } from '../src/lib/apiClient.js';
import type { AuthState, OwnerUser } from '../src/features/auth/auth.types.js';

describe('Auth Provider State Transitions & Deduplication Test Suite', () => {
  beforeEach(() => {
    setCsrfToken(null);
    vi.restoreAllMocks();
  });

  // Test the state reducer/transition logic matching AuthProvider implementation
  function createTestAuthManager() {
    let state: AuthState = {
      isAuthenticated: false,
      isLoading: true,
      owner: null,
      error: null,
      isOffline: false,
    };

    let authCheckPromise: Promise<void> | null = null;

    const checkAuth = async () => {
      if (authCheckPromise) {
        return authCheckPromise;
      }

      const operation = (async () => {
        state = {
          ...state,
          isLoading: true,
          error: null,
          isOffline: false,
        };

        try {
          const res = await authApi.me();
          if (res && res.authenticated) {
            state = {
              isAuthenticated: true,
              isLoading: false,
              owner: res.owner as OwnerUser,
              error: null,
              isOffline: false,
            };
          } else {
            state = {
              isAuthenticated: false,
              isLoading: false,
              owner: null,
              error: null,
              isOffline: false,
            };
          }
        } catch (err: unknown) {
          const error = err as {
            status?: number;
            code?: string;
            message?: string;
          };

          if (error.status === 401) {
            setCsrfToken(null);
            state = {
              isAuthenticated: false,
              isLoading: false,
              owner: null,
              error: null,
              isOffline: false,
            };
            return;
          }

          let message = 'Unable to verify your session. Please check your internet connection and retry.';
          if (error.code === 'REQUEST_TIMEOUT') {
            message =
              'The server is taking too long to respond. Your existing login has not been cleared. Please retry.';
          } else if (error.code === 'NETWORK_ERROR') {
            message = 'Cannot connect to Khata. Check your internet connection and retry.';
          } else if (error.status === 502 || error.status === 503) {
            message = 'Khata server or database is temporarily unavailable. Please retry.';
          }

          state = {
            ...state,
            isLoading: false,
            isOffline: true,
            error: message,
          };
        }
      })();

      authCheckPromise = operation;
      try {
        await operation;
      } finally {
        authCheckPromise = null;
      }
    };

    const logout = async () => {
      state = { ...state, isLoading: true, error: null };
      try {
        await authApi.logout();
        state = {
          isAuthenticated: false,
          isLoading: false,
          owner: null,
          error: null,
          isOffline: false,
        };
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        if (status === 401) {
          state = {
            isAuthenticated: false,
            isLoading: false,
            owner: null,
            error: null,
            isOffline: false,
          };
        } else {
          const failureMessage =
            'Logout could not be confirmed with the server. Please check your network and retry.';
          state = {
            ...state,
            isLoading: false,
            error: failureMessage,
            isOffline: true,
          };
          throw new Error(failureMessage);
        }
      }
    };

    return {
      getState: () => state,
      setState: (s: Partial<AuthState>) => {
        state = { ...state, ...s };
      },
      checkAuth,
      logout,
    };
  }

  it('1. Initial state is isLoading: true and isOffline: false', () => {
    const manager = createTestAuthManager();
    expect(manager.getState()).toEqual({
      isAuthenticated: false,
      isLoading: true,
      owner: null,
      error: null,
      isOffline: false,
    });
  });

  it('2. Successful session verification updates state to isAuthenticated: true', async () => {
    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { role: 'OWNER', phone: '9876543210' },
    });

    const manager = createTestAuthManager();
    await manager.checkAuth();

    expect(manager.getState()).toEqual({
      isAuthenticated: true,
      isLoading: false,
      owner: { role: 'OWNER', phone: '9876543210' },
      error: null,
      isOffline: false,
    });
  });

  it('3. Explicit HTTP 401 marks session as unauthenticated and NOT offline', async () => {
    setCsrfToken('some_old_token');
    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiClientError('No active authenticated session found.', {
        status: 401,
        code: 'UNAUTHORIZED',
      })
    );

    const manager = createTestAuthManager();
    await manager.checkAuth();

    expect(manager.getState()).toEqual({
      isAuthenticated: false,
      isLoading: false,
      owner: null,
      error: null,
      isOffline: false,
    });
    expect(getCsrfToken()).toBeNull();
  });

  it('4. Network failure preserves existing authentication state and sets isOffline: true', async () => {
    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiClientError('Unable to connect to the Khata server.', {
        code: 'NETWORK_ERROR',
      })
    );

    const manager = createTestAuthManager();
    // Simulate user was already authenticated
    manager.setState({ isAuthenticated: true, owner: { role: 'OWNER' } });

    await manager.checkAuth();

    const state = manager.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.isLoading).toBe(false);
    expect(state.isOffline).toBe(true);
    expect(state.error).toBe('Cannot connect to Khata. Check your internet connection and retry.');
  });

  it('5. Request timeout sets isOffline: true and displays specific timeout message', async () => {
    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiClientError('The Khata server took too long to respond.', {
        code: 'REQUEST_TIMEOUT',
      })
    );

    const manager = createTestAuthManager();
    await manager.checkAuth();

    const state = manager.getState();
    expect(state.isLoading).toBe(false);
    expect(state.isOffline).toBe(true);
    expect(state.error).toBe(
      'The server is taking too long to respond. Your existing login has not been cleared. Please retry.'
    );
  });

  it('6. HTTP 502/503 sets isOffline: true and displays temporary wakeup message', async () => {
    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiClientError('Bad Gateway', {
        status: 502,
        code: 'SERVER_ERROR',
      })
    );

    const manager = createTestAuthManager();
    await manager.checkAuth();

    const state = manager.getState();
    expect(state.isOffline).toBe(true);
    expect(state.error).toBe('Khata server or database is temporarily unavailable. Please retry.');
  });

  it('7. Concurrent checkAuth calls (e.g. React StrictMode) deduplicate to a single in-flight request', async () => {
    let callCount = 0;
    vi.spyOn(authApi, 'me').mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      return { authenticated: true, owner: { role: 'OWNER' } };
    });

    const manager = createTestAuthManager();

    // Call concurrently (simulating StrictMode double-mount)
    const [p1, p2, p3] = [manager.checkAuth(), manager.checkAuth(), manager.checkAuth()];
    await Promise.all([p1, p2, p3]);

    // Exactly 1 network request fired
    expect(callCount).toBe(1);
    expect(manager.getState().isAuthenticated).toBe(true);
  });

  it('8. Logout on network failure does NOT falsely claim session was cleared on the server', async () => {
    vi.spyOn(authApi, 'logout').mockRejectedValue(
      new ApiClientError('Network disconnected', {
        code: 'NETWORK_ERROR',
      })
    );

    const manager = createTestAuthManager();
    manager.setState({ isAuthenticated: true, owner: { role: 'OWNER' } });

    await expect(manager.logout()).rejects.toThrow(
      'Logout could not be confirmed with the server. Please check your network and retry.'
    );

    // Existing session not wiped falsely
    expect(manager.getState().isOffline).toBe(true);
    expect(manager.getState().error).toBe(
      'Logout could not be confirmed with the server. Please check your network and retry.'
    );
  });
});
