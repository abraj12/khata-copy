import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ProtectedRoute } from '../src/components/ProtectedRoute.js';
import { AuthConnectionError } from '../src/features/auth/AuthConnectionError.js';
import { AuthProvider } from '../src/features/auth/AuthProvider.js';

describe('Protected Route & Auth Connection Error Test Suite', () => {
  it('1. AuthConnectionError component renders heading, default message, and action buttons', () => {
    const html = renderToString(
      <AuthConnectionError
        message={null}
        onRetry={async () => {}}
        isRetrying={false}
      />
    );

    expect(html).toContain('Unable to Verify Session');
    expect(html).toContain('The Khata server or database may be temporarily waking up or unavailable.');
    expect(html).toContain('Retry Connection');
    expect(html).toContain('Reload Application');
  });

  it('2. AuthConnectionError displays custom error message and "Connecting..." state when retrying', () => {
    const customMessage = 'The server is taking too long to respond. Your existing login has not been cleared. Please retry.';
    const html = renderToString(
      <AuthConnectionError
        message={customMessage}
        onRetry={async () => {}}
        isRetrying={true}
      />
    );

    expect(html).toContain('Unable to Verify Session');
    expect(html).toContain(customMessage);
    expect(html).toContain('Connecting...');
    expect(html).toContain('disabled');
  });

  it('3. ProtectedRoute displays loading screen with "Verifying Owner Session..." while isLoading is true', () => {
    // Initial mount of AuthProvider has isLoading: true
    const html = renderToString(
      <AuthProvider>
        <ProtectedRoute>
          <div data-testid="dashboard-content">Owner Dashboard</div>
        </ProtectedRoute>
      </AuthProvider>
    );

    expect(html).toContain('Verifying Owner Session...');
    expect(html).toContain('Connecting securely to Khata...');
    expect(html).not.toContain('Owner Dashboard');
  });
});
