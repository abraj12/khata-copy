// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuthProvider, useAuth } from '../src/features/auth/AuthProvider.js';
import { ProtectedRoute } from '../src/components/ProtectedRoute.js';
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
});
