import React from 'react';
import { WifiOff, RefreshCw, RotateCcw } from 'lucide-react';

interface Props {
  message: string | null;
  onRetry: () => Promise<void>;
  isRetrying: boolean;
}

export const AuthConnectionError: React.FC<Props> = ({
  message,
  onRetry,
  isRetrying,
}) => {
  return (
    <main
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'var(--khata-bg)', color: 'var(--khata-text)' }}
    >
      <section
        className="w-full max-w-md neu-card p-6 sm:p-8 text-center"
        role="alert"
        aria-live="assertive"
      >
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl neu-pressed">
          <WifiOff className="w-8 h-8 text-[var(--khata-danger)]" />
        </div>

        <h1 className="text-xl font-bold tracking-tight">
          Unable to Verify Session
        </h1>

        <p className="mt-3 text-sm text-[var(--khata-text-muted)] leading-relaxed">
          {message ||
            'The Khata server or database may be temporarily waking up or unavailable. Your existing session has not been cleared.'}
        </p>

        <div className="mt-6 space-y-3">
          <button
            type="button"
            disabled={isRetrying}
            onClick={() => void onRetry()}
            className="neu-btn-primary w-full py-3 flex items-center justify-center gap-2 font-semibold text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${isRetrying ? 'animate-spin' : ''}`} />
            {isRetrying ? 'Connecting...' : 'Retry Connection'}
          </button>

          <button
            type="button"
            onClick={() => window.location.reload()}
            className="neu-btn-secondary w-full py-3 flex items-center justify-center gap-2 font-medium text-sm"
          >
            <RotateCcw className="w-4 h-4 text-[var(--khata-text-muted)]" />
            Reload Application
          </button>
        </div>
      </section>
    </main>
  );
};
