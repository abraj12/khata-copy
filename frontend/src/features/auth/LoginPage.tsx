import React, { useState } from 'react';
import { useAuth } from './AuthProvider.js';
import { Lock, Phone, Eye, EyeOff, Store, AlertCircle, Clock, Palette } from 'lucide-react';
import { AppearanceAccessibilityModal } from '../../components/AppearanceAccessibilityModal.js';

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [lockoutRemainingSec, setLockoutRemainingSec] = useState<number>(0);
  const [isAppearanceOpen, setIsAppearanceOpen] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isLocked) return;

    // Validate 10-digit mobile number on client
    const cleaned = phone.replace(/[\s\-()]/g, '');
    const is10Digit = /^(?:\+91)?[6-9]\d{9}$/.test(cleaned);

    if (!is10Digit) {
      setErrorMessage('Please enter a valid 10-digit Indian mobile number.');
      return;
    }

    if (!password) {
      setErrorMessage('Password is required.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await login(phone, password);
    } catch (err: unknown) {
      const errorObj = err as {
        payload?: { isLocked?: boolean; remainingMs?: number; message?: string };
        message?: string;
      };
      if (errorObj?.payload?.isLocked) {
        setIsLocked(true);
        const remainingSec = Math.ceil((errorObj.payload.remainingMs || 900000) / 1000);
        setLockoutRemainingSec(remainingSec);
        setErrorMessage(
          errorObj.payload.message || 'Account temporarily locked due to repeated failed attempts.'
        );

        // Start countdown timer
        const timer = setInterval(() => {
          setLockoutRemainingSec((prev) => {
            if (prev <= 1) {
              clearInterval(timer);
              setIsLocked(false);
              setErrorMessage(null);
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      } else {
        setErrorMessage(
          errorObj.payload?.message || errorObj.message || 'Invalid mobile number or password.'
        );
      }
      setPassword('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-4 pt-16 sm:pt-4 relative"
      style={{ backgroundColor: 'var(--khata-bg)' }}
    >
      {/* Top Floating Appearance & Accessibility Control */}
      <header className="absolute top-4 right-4 z-20">
        <button
          onClick={() => setIsAppearanceOpen(true)}
          className="neu-btn-secondary text-xs py-2 px-3 flex items-center gap-2"
          aria-label="Open Appearance & Accessibility settings"
        >
          <Palette className="w-4 h-4 text-[var(--khata-accent)]" />
          <span className="hidden sm:inline">Appearance & Accessibility</span>
        </button>
      </header>

      {/* Main Login Card with Neumorphic Elevation */}
      <main className="w-full max-w-md neu-card overflow-hidden my-auto">
        {/* Brand header */}
        <div
          className="p-6 text-center border-b border-[var(--khata-border)]"
          style={{ background: 'var(--khata-gradient-surface)' }}
        >
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-3 shadow-md border border-[var(--khata-border)]"
            style={{ background: 'var(--khata-surface-inset)', color: 'var(--khata-accent)' }}
          >
            <Store className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-[var(--khata-text)]">Khata</h1>
          <p className="text-xs text-[var(--khata-text-muted)] mt-1 font-medium">
            Algions AI Labs Private Limited
          </p>
          <div className="mt-2.5 inline-block text-[11px] font-semibold px-3 py-0.5 rounded-full bg-[var(--khata-surface-inset)] border border-[var(--khata-border)] text-[var(--khata-text)]">
            Owner Authentication
          </div>
        </div>

        {/* Login form body */}
        <div className="p-6 sm:p-8">
          {/* Accessible error alert */}
          {errorMessage && (
            <div
              role="alert"
              aria-live="assertive"
              className={`mb-5 p-4 rounded-xl flex flex-wrap items-start gap-3 text-xs font-medium border ${
                isLocked
                  ? 'bg-amber-500/10 border-amber-500/30 text-[var(--khata-warning)]'
                  : 'bg-red-500/10 border-red-500/30 text-[var(--khata-danger)]'
              }`}
            >
              {isLocked ? (
                <Clock className="w-4 h-4 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <p className="font-bold">{isLocked ? 'Account Temporarily Locked' : 'Authentication Error'}</p>
                <p className="mt-0.5">{errorMessage}</p>
                {isLocked && lockoutRemainingSec > 0 && (
                  <p className="mt-1.5 font-mono font-bold">
                    Retry available in: {Math.floor(lockoutRemainingSec / 60)}m {lockoutRemainingSec % 60}s
                  </p>
                )}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            {/* Phone input */}
            <div>
              <label
                htmlFor="owner-phone"
                className="block text-xs font-bold uppercase tracking-wider text-[var(--khata-text-muted)] mb-1.5"
              >
                Owner Mobile Number
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[var(--khata-text-muted)]">
                  <Phone className="w-4 h-4" />
                  <span className="ml-1 text-xs font-bold">+91</span>
                </div>
                <input
                  id="owner-phone"
                  name="phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel"
                  required
                  disabled={isSubmitting || isLocked}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="98765 43210"
                  className="neu-input neu-input-with-phone-prefix w-full text-sm font-medium"
                />
              </div>
              <p className="mt-1 text-[11px] text-[var(--khata-text-muted)]">
                10-digit registered Indian phone number
              </p>
            </div>

            {/* Password input */}
            <div>
              <label
                htmlFor="owner-password"
                className="block text-xs font-bold uppercase tracking-wider text-[var(--khata-text-muted)] mb-1.5"
              >
                Owner Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[var(--khata-text-muted)]">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  id="owner-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  disabled={isSubmitting || isLocked}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="neu-input neu-input-with-leading-icon neu-input-with-trailing-icon w-full text-sm font-medium"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  disabled={isSubmitting || isLocked}
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center justify-center min-w-[44px] min-h-[44px] text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] transition"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit button */}
            <button
              type="submit"
              disabled={isSubmitting || isLocked}
              className="neu-btn-primary w-full mt-3 py-3 text-sm font-bold"
            >
              {isSubmitting ? (
                <>
                  <svg
                    className="animate-spin h-4 w-4"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  <span>Authenticating...</span>
                </>
              ) : (
                <span>Login to Khata</span>
              )}
            </button>
          </form>

          {/* Security footnote */}
          <div className="mt-6 pt-4 border-t border-[var(--khata-border)] text-center">
            <p className="text-[11px] text-[var(--khata-text-muted)] flex items-center justify-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-[var(--khata-accent)]" />
              <span>Protected by Argon2id & Host-Only Sessions</span>
            </p>
          </div>
        </div>
      </main>

      {/* Global Brand Footer */}
      <footer className="mt-6 pb-4 text-center text-xs font-medium text-[var(--khata-text-muted)]">
        Designed and managed by Algions AI Labs Pvt. Ltd.
      </footer>

      {/* Appearance Modal */}
      <AppearanceAccessibilityModal
        isOpen={isAppearanceOpen}
        onClose={() => setIsAppearanceOpen(false)}
      />
    </div>
  );
};
