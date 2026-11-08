import React, { useState } from 'react';
import { useAuth } from '../features/auth/AuthProvider.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { AuthConnectionError } from '../features/auth/AuthConnectionError.js';
import { Store, RefreshCw } from 'lucide-react';

export const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading, isOffline, error, refreshAuth } = useAuth();
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = async () => {
    try {
      setIsRetrying(true);
      await refreshAuth();
    } finally {
      setIsRetrying(false);
    }
  };

  // State A: Verifying session
  if (isLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        style={{ backgroundColor: 'var(--khata-bg)', color: 'var(--khata-text)' }}
      >
        <div className="w-full max-w-sm neu-card p-8 text-center space-y-4">
          <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center neu-pressed">
            <Store className="w-8 h-8 text-[var(--khata-accent)] animate-pulse" />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight">Verifying Owner Session...</h2>
            <p className="mt-1 text-xs text-[var(--khata-text-muted)]">Connecting securely to Khata...</p>
          </div>
          <div className="flex justify-center pt-2">
            <div className="animate-spin rounded-full h-8 w-8 border-3 border-[var(--khata-accent)] border-t-transparent" />
          </div>
        </div>
      </div>
    );
  }

  // State B: Session verification unavailable (Network, Render sleep, Neon cold start)
  if (!isAuthenticated && isOffline) {
    return (
      <AuthConnectionError
        message={error}
        onRetry={handleRetry}
        isRetrying={isRetrying}
      />
    );
  }

  // State C: Genuine unauthenticated state (401 or user logged out)
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // State D: Already authenticated, but temporarily offline or background check failed
  return (
    <>
      {isOffline && (
        <aside
          role="status"
          aria-live="polite"
          className="mhi-no-print bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 text-xs font-medium text-amber-700 dark:text-amber-300 flex items-center justify-between gap-2"
        >
          <span>Khata is temporarily reconnecting. You can continue reviewing existing data.</span>
          <button
            type="button"
            onClick={handleRetry}
            disabled={isRetrying}
            className="underline hover:text-amber-800 dark:hover:text-amber-200 flex items-center gap-1 font-semibold"
          >
            <RefreshCw className={`w-3 h-3 ${isRetrying ? 'animate-spin' : ''}`} />
            {isRetrying ? 'Retrying...' : 'Retry'}
          </button>
        </aside>
      )}
      {children}
    </>
  );
};
