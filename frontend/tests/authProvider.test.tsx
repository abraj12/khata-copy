// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuthProvider, useAuth } from '../src/features/auth/AuthProvider.js';
import { ProtectedRoute } from '../src/components/ProtectedRoute.js';
import { Navbar } from '../src/components/Navbar.js';
import { ThemeAccessibilityProvider } from '../src/context/ThemeAccessibilityContext.js';
import { authApi } from '../src/features/auth/authApi.js';
import { setCsrfToken, getCsrfToken, ApiClientError } from '../src/lib/apiClient.js';

// Configure React 19 test environment for act()
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Real React AuthProvider & ProtectedRoute Authentication Test Suite', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setCsrfToken(null);
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  function renderWithProviders(children: React.ReactNode) {
    return (
      <ThemeAccessibilityProvider>
        <AuthProvider>
          <ProtectedRoute>
            {children}
          </ProtectedRoute>
        </AuthProvider>
      </ThemeAccessibilityProvider>
    );
  }

  it('1. Renders initial loading screen ("Verifying Owner Session...") while auth check is in flight', async () => {
    let resolveMe: (value: unknown) => void;
    vi.spyOn(authApi, 'me').mockImplementation(
      () => new Promise((resolve) => { resolveMe = resolve; })
    );

    await act(async () => {
      root.render(
        renderWithProviders(
          <div data-testid="dashboard-content">Owner Dashboard</div>
        )
      );
    });

    expect(container.textContent).toContain('Verifying Owner Session...');
    expect(container.textContent).toContain('Connecting securely to Khata...');
    expect(container.textContent).not.toContain('Owner Dashboard');

    // Resolve promise to clean up
    await act(async () => {
      resolveMe({ authenticated: false });
    });
  });

  it('2. Authenticates successfully on HTTP 200 and renders protected children', async () => {
    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { role: 'OWNER', phone: '9876543210' },
    });

    await act(async () => {
      root.render(
        renderWithProviders(
          <div data-testid="dashboard-content">Owner Dashboard Content</div>
        )
      );
    });

    expect(container.textContent).toContain('Owner Dashboard Content');
    expect(container.textContent).not.toContain('Verifying Owner Session...');
    expect(container.textContent).not.toContain('Unable to Verify Session');
  });

  it('3. Renders LoginPage on HTTP 401 unauthenticated response and clears CSRF token', async () => {
    setCsrfToken('old-csrf-token');
    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiClientError('No active authenticated session found.', { status: 401, code: 'UNAUTHORIZED' })
    );

    await act(async () => {
      root.render(
        renderWithProviders(
          <div data-testid="dashboard-content">Owner Dashboard Content</div>
        )
      );
    });

    // Shows login form and clears CSRF token
    expect(container.textContent).toContain('Owner Authentication');
    expect(container.textContent).toContain('Login to Khata');
    expect(container.textContent).not.toContain('Owner Dashboard Content');
    expect(getCsrfToken()).toBeNull();
  });

  it('4. Renders AuthConnectionError on HTTP 500 server error', async () => {
    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiClientError('Internal Server Error', { status: 500, code: 'INTERNAL_SERVER_ERROR' })
    );

    await act(async () => {
      root.render(
        renderWithProviders(
          <div data-testid="dashboard-content">Owner Dashboard Content</div>
        )
      );
    });

    expect(container.textContent).toContain('Unable to Verify Session');
    expect(container.textContent).toContain('Retry Connection');
    expect(container.textContent).not.toContain('Owner Dashboard Content');
  });

  it('5. Renders AuthConnectionError on HTTP 502 (Render sleep) and HTTP 503 (Neon outage)', async () => {
    // Test 502
    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiClientError('Bad Gateway', { status: 502, code: 'SERVICE_UNAVAILABLE' })
    );

    await act(async () => {
      root.render(
        renderWithProviders(
          <div>Protected Content</div>
        )
      );
    });

    expect(container.textContent).toContain('Unable to Verify Session');
    expect(container.textContent).toContain('Khata server or database is temporarily unavailable. Please retry.');

    // Unmount and test 503
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiClientError('Service Unavailable', { status: 503, code: 'SESSION_STORE_UNAVAILABLE' })
    );

    await act(async () => {
      root.render(
        renderWithProviders(
          <div>Protected Content</div>
        )
      );
    });

    expect(container.textContent).toContain('Unable to Verify Session');
    expect(container.textContent).toContain('Khata server or database is temporarily unavailable. Please retry.');
  });

  it('6. Renders AuthConnectionError on Network Failure and Request Timeout', async () => {
    // Network Error
    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiClientError('Failed to fetch', { code: 'NETWORK_ERROR' })
    );

    await act(async () => {
      root.render(
        renderWithProviders(
          <div>Protected Content</div>
        )
      );
    });

    expect(container.textContent).toContain('Unable to Verify Session');
    expect(container.textContent).toContain('Cannot connect to Khata. Check your internet connection and retry.');

    // Unmount and test Request Timeout
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiClientError('Request timeout', { code: 'REQUEST_TIMEOUT' })
    );

    await act(async () => {
      root.render(
        renderWithProviders(
          <div>Protected Content</div>
        )
      );
    });

    expect(container.textContent).toContain('Unable to Verify Session');
    expect(container.textContent).toContain('The server is taking too long to respond.');
  });

  it('7. Interactive Retry: clicking "Retry Connection" button re-verifies session and restores dashboard', async () => {
    let attempts = 0;
    vi.spyOn(authApi, 'me').mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new ApiClientError('Neon waking up', { status: 503, code: 'SESSION_STORE_UNAVAILABLE' });
      }
      return { authenticated: true, owner: { role: 'OWNER', phone: '9876543210' } };
    });

    await act(async () => {
      root.render(
        renderWithProviders(
          <div data-testid="dashboard-content">Recovered Owner Dashboard</div>
        )
      );
    });

    // First attempt failed with 503
    expect(container.textContent).toContain('Unable to Verify Session');
    expect(container.textContent).not.toContain('Recovered Owner Dashboard');

    // Find and click the Retry Connection button
    const buttons = Array.from(container.querySelectorAll('button'));
    const retryBtn = buttons.find((b) => b.textContent?.includes('Retry Connection'));
    expect(retryBtn).toBeDefined();

    await act(async () => {
      retryBtn?.click();
    });

    // After retry succeeds on attempt 2, protected dashboard is shown
    expect(attempts).toBe(2);
    expect(container.textContent).toContain('Recovered Owner Dashboard');
  });

  it('8. Network failure does NOT clear an existing authenticated session', async () => {
    let authCheckCount = 0;
    let authContextConsumer: ReturnType<typeof useAuth> | null = null;

    function TestConsumer() {
      authContextConsumer = useAuth();
      return <div data-testid="live-dashboard">Active Dashboard Data</div>;
    }

    vi.spyOn(authApi, 'me').mockImplementation(async () => {
      authCheckCount++;
      if (authCheckCount === 1) {
        return { authenticated: true, owner: { role: 'OWNER', phone: '9876543210' } };
      }
      // Subsequent check encounters a network drop
      throw new ApiClientError('Network disconnected', { code: 'NETWORK_ERROR' });
    });

    await act(async () => {
      root.render(
        renderWithProviders(
          <TestConsumer />
        )
      );
    });

    // Successfully authenticated initially
    expect(container.textContent).toContain('Active Dashboard Data');
    expect(authContextConsumer!.isAuthenticated).toBe(true);

    // Trigger refreshAuth (which encounters NETWORK_ERROR)
    await act(async () => {
      await authContextConsumer!.refreshAuth();
    });

    // Crucial guarantee: User is NOT logged out!
    expect(authContextConsumer!.isAuthenticated).toBe(true);
    expect(authContextConsumer!.isOffline).toBe(true);
    expect(container.textContent).toContain('Active Dashboard Data');

    // Non-blocking reconnection banner is displayed
    expect(container.textContent).toContain('Khata is temporarily reconnecting. You can continue reviewing existing data.');
  });

  it('9. Secure logout clears owner state, removes CSRF token, and redirects to LoginPage', async () => {
    let authContextConsumer: ReturnType<typeof useAuth> | null = null;

    function AuthSpy() {
      authContextConsumer = useAuth();
      return null;
    }

    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { role: 'OWNER', phone: '9876543210' },
    });
    vi.spyOn(authApi, 'logout').mockResolvedValue(undefined as never);
    setCsrfToken('valid-csrf-token');

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <AuthSpy />
            <ProtectedRoute>
              <div>Authenticated View</div>
            </ProtectedRoute>
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });

    expect(container.textContent).toContain('Authenticated View');
    expect(authContextConsumer!.isAuthenticated).toBe(true);
    expect(getCsrfToken()).toBe('valid-csrf-token');

    // Trigger logout and await completion
    await act(async () => {
      await authContextConsumer?.logout();
    });

    // Session is terminated, CSRF token is cleared, and LoginPage is shown
    expect(authContextConsumer!.isAuthenticated).toBe(false);
    expect(authContextConsumer!.owner).toBeNull();
    expect(getCsrfToken()).toBeNull();
    expect(container.textContent).toContain('Owner Authentication');
    expect(container.textContent).not.toContain('Authenticated View');
  });

  it('10. HTTP 401 logout clears in-memory CSRF token and redirects to LoginPage', async () => {
    let authContextConsumer: ReturnType<typeof useAuth> | null = null;

    function AuthSpy() {
      authContextConsumer = useAuth();
      return null;
    }

    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { role: 'OWNER', phone: '9876543210' },
    });
    vi.spyOn(authApi, 'logout').mockRejectedValue(
      new ApiClientError('Session expired.', {
        status: 401,
        code: 'UNAUTHORIZED',
      })
    );
    setCsrfToken('stale-session-csrf-token');

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <AuthSpy />
            <ProtectedRoute>
              <div>Authenticated View</div>
            </ProtectedRoute>
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });

    expect(container.textContent).toContain('Authenticated View');
    expect(authContextConsumer!.isAuthenticated).toBe(true);
    expect(getCsrfToken()).toBe('stale-session-csrf-token');

    // Trigger logout (which encounters HTTP 401 on server)
    await act(async () => {
      await authContextConsumer?.logout();
    });

    // Crucial check: Auth state is cleared, owner is null, CSRF token is wiped from memory, and LoginPage is shown
    expect(authContextConsumer!.isAuthenticated).toBe(false);
    expect(authContextConsumer!.owner).toBeNull();
    expect(getCsrfToken()).toBeNull();
    expect(container.textContent).toContain('Owner Authentication');
    expect(container.textContent).not.toContain('Authenticated View');
  });

  it('11. Network failure during logout does NOT falsely claim session was cleared on the server', async () => {
    let authContextConsumer: ReturnType<typeof useAuth> | null = null;

    function AuthSpy() {
      authContextConsumer = useAuth();
      return null;
    }

    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { role: 'OWNER', phone: '9876543210' },
    });
    vi.spyOn(authApi, 'logout').mockRejectedValue(
      new ApiClientError('Network disconnected', {
        code: 'NETWORK_ERROR',
      })
    );
    setCsrfToken('valid-csrf-token');

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <AuthSpy />
            <ProtectedRoute>
              <div>Authenticated View</div>
            </ProtectedRoute>
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });

    expect(authContextConsumer!.isAuthenticated).toBe(true);
    expect(getCsrfToken()).toBe('valid-csrf-token');

    // Trigger logout (which encounters network error)
    await act(async () => {
      try {
        await authContextConsumer?.logout();
      } catch {
        // Expected logout failure error thrown
      }
    });

    // Session is NOT falsely marked unauthenticated
    expect(authContextConsumer!.isAuthenticated).toBe(true);
    expect(authContextConsumer!.isOffline).toBe(true);
    expect(authContextConsumer!.error).toContain('Logout could not be confirmed with the server');
    // Content is preserved
    expect(container.textContent).toContain('Authenticated View');
  });

  it('12. Real Navbar Logout button click initiates logout, disables button during transit, prevents duplicate clicks, and transitions to login on server success', async () => {
    let resolveLogout: (val: { success: boolean; message: string }) => void;
    const logoutPromise = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveLogout = resolve;
    });

    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { role: 'OWNER', phone: '9876543210' },
    });
    const logoutSpy = vi.spyOn(authApi, 'logout').mockReturnValue(logoutPromise);
    setCsrfToken('active-owner-csrf-token');

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <Navbar currentTab="khata" onTabChange={() => {}} onOpenAppearance={() => {}} />
            <ProtectedRoute>
              <div>Owner Dashboard Content</div>
            </ProtectedRoute>
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });

    // Verify initial authenticated state with dashboard and logout button
    expect(container.textContent).toContain('Owner Dashboard Content');
    const logoutBtn = container.querySelector('button[aria-label="Log out of Khata"]') as HTMLButtonElement;
    expect(logoutBtn).not.toBeNull();
    expect(logoutBtn.disabled).toBe(false);

    // Click logout
    await act(async () => {
      logoutBtn.click();
    });

    // While in-flight: button is disabled to prevent duplicate clicks, and shows spinner/loading text
    expect(logoutSpy).toHaveBeenCalledTimes(1);
    expect(logoutBtn.disabled).toBe(true);

    // Duplicate clicks while in-flight must be ignored
    await act(async () => {
      logoutBtn.click();
    });
    expect(logoutSpy).toHaveBeenCalledTimes(1);

    // Resolve server-side logout
    await act(async () => {
      resolveLogout!({ success: true, message: 'Logged out successfully.' });
      await logoutPromise;
    });

    // Verify transitions to login screen and CSRF token is cleared
    expect(container.textContent).toContain('Owner Authentication');
    expect(container.textContent).not.toContain('Owner Dashboard Content');
    expect(getCsrfToken()).toBeNull();
  });

  it('13. HTTP 500 on logout preserves authentication, displays error banner in Navbar, and Retry recovers', async () => {
    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { role: 'OWNER', phone: '9876543210' },
    });
    const logoutSpy = vi.spyOn(authApi, 'logout').mockRejectedValueOnce(
      new ApiClientError('Server database failed to destroy session.', {
        status: 500,
        code: 'INTERNAL_ERROR',
      })
    );
    setCsrfToken('preserved-csrf-token');

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <Navbar currentTab="khata" onTabChange={() => {}} onOpenAppearance={() => {}} />
            <ProtectedRoute>
              <div>Owner Dashboard Content</div>
            </ProtectedRoute>
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });

    const logoutBtn = container.querySelector('button[aria-label="Log out of Khata"]') as HTMLButtonElement;
    expect(logoutBtn).not.toBeNull();

    // Click logout (fails with HTTP 500)
    await act(async () => {
      logoutBtn.click();
    });

    // Content is preserved (user is not logged out falsely)
    expect(container.textContent).toContain('Owner Dashboard Content');
    // Error banner is displayed in Navbar
    expect(container.textContent).toContain('Logout could not be confirmed with the server');
    // CSRF token is NOT cleared on 500
    expect(getCsrfToken()).toBe('preserved-csrf-token');

    // Find the Retry button in the banner
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Retry'
    );
    expect(retryBtn).toBeDefined();

    // Now mock successful logout on retry
    logoutSpy.mockResolvedValueOnce({ success: true, message: 'Logged out successfully.' });

    // Click Retry
    await act(async () => {
      retryBtn!.click();
    });

    // Transitions to login page, error banner is gone, CSRF token is wiped
    expect(container.textContent).toContain('Owner Authentication');
    expect(container.textContent).not.toContain('Owner Dashboard Content');
    expect(getCsrfToken()).toBeNull();
  });

  it('14. Network failure on logout preserves authentication and Retry completes logout when reconnected', async () => {
    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { role: 'OWNER', phone: '9876543210' },
    });
    const logoutSpy = vi.spyOn(authApi, 'logout').mockRejectedValueOnce(
      new ApiClientError('Connection timeout', {
        code: 'NETWORK_ERROR',
      })
    );
    setCsrfToken('network-preserved-csrf');

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <Navbar currentTab="khata" onTabChange={() => {}} onOpenAppearance={() => {}} />
            <ProtectedRoute>
              <div>Protected Financial Data</div>
            </ProtectedRoute>
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });

    const logoutBtn = container.querySelector('button[aria-label="Log out of Khata"]') as HTMLButtonElement;

    // Trigger logout
    await act(async () => {
      logoutBtn.click();
    });

    // Preserved on network failure
    expect(container.textContent).toContain('Protected Financial Data');
    expect(container.textContent).toContain('Logout could not be confirmed with the server');
    expect(getCsrfToken()).toBe('network-preserved-csrf');

    // Click Retry with restored connection
    logoutSpy.mockResolvedValueOnce({ success: true, message: 'Logged out successfully.' });
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Retry'
    );

    await act(async () => {
      retryBtn!.click();
    });

    expect(container.textContent).toContain('Owner Authentication');
    expect(container.textContent).not.toContain('Protected Financial Data');
    expect(getCsrfToken()).toBeNull();
  });
});
