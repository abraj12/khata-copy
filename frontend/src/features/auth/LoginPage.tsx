import React, { useState } from 'react';
import { useAuth } from './AuthProvider.js';
import { Lock, Phone, Eye, EyeOff, Store, AlertCircle, Clock } from 'lucide-react';

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [lockoutRemainingSec, setLockoutRemainingSec] = useState<number>(0);

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
      // On success, AuthProvider state updates and parent renders protected dashboard
    } catch (err: unknown) {
      const errorObj = err as { payload?: { isLocked?: boolean; remainingMs?: number; message?: string }; message?: string };
      if (errorObj?.payload?.isLocked) {
        setIsLocked(true);
        const remainingSec = Math.ceil((errorObj.payload.remainingMs || 900000) / 1000);
        setLockoutRemainingSec(remainingSec);
        setErrorMessage(errorObj.payload.message || 'Account temporarily locked due to failed attempts.');

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
        setErrorMessage(errorObj.payload?.message || errorObj.message || 'Invalid mobile number or password.');
      }
      // Clear password field on failed attempt for security
      setPassword('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4 py-8 select-none">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden border border-slate-100">
        {/* Header / Brand identity */}
        <div className="bg-gradient-to-r from-indigo-600 to-indigo-800 px-8 py-8 text-white text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-white/10 backdrop-blur-md mb-3 border border-white/20">
            <Store className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight">Khata</h1>
          <p className="text-indigo-200 text-sm font-medium mt-1">Single-Shopkeeper Ledger Book</p>
          <div className="mt-3 inline-block bg-indigo-900/50 text-indigo-100 text-xs font-semibold px-3 py-1 rounded-full border border-indigo-500/30">
            Owner Login
          </div>
        </div>

        {/* Form Body */}
        <div className="p-8">
          {/* Accessible Error / Alert */}
          {errorMessage && (
            <div
              role="alert"
              aria-live="assertive"
              className={`mb-6 p-4 rounded-xl flex items-start space-x-3 text-sm ${
                isLocked
                  ? 'bg-amber-50 text-amber-900 border border-amber-200'
                  : 'bg-red-50 text-red-800 border border-red-200'
              }`}
            >
              {isLocked ? (
                <Clock className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              )}
              <div className="flex-1">
                <p className="font-semibold">{isLocked ? 'Access Temporarily Restricted' : 'Authentication Error'}</p>
                <p className="mt-0.5">{errorMessage}</p>
                {isLocked && lockoutRemainingSec > 0 && (
                  <p className="mt-2 text-xs font-mono font-bold text-amber-700">
                    Retry available in: {Math.floor(lockoutRemainingSec / 60)}m {lockoutRemainingSec % 60}s
                  </p>
                )}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            {/* Mobile Number Field */}
            <div>
              <label htmlFor="owner-phone" className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                Owner Mobile Number
              </label>
              <div className="relative rounded-xl shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Phone className="w-4 h-4 text-slate-400" />
                  <span className="ml-1.5 text-xs font-bold text-slate-500">+91</span>
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
                  className="block w-full pl-16 pr-4 py-3 rounded-xl border border-slate-300 bg-slate-50/50 text-slate-900 placeholder-slate-400 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 transition disabled:opacity-60 disabled:cursor-not-allowed"
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">Enter registered 10-digit Indian phone number</p>
            </div>

            {/* Password Field with Show/Hide */}
            <div>
              <label htmlFor="owner-password" className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                Owner Password
              </label>
              <div className="relative rounded-xl shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
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
                  className="block w-full pl-10 pr-11 py-3 rounded-xl border border-slate-300 bg-slate-50/50 text-slate-900 placeholder-slate-400 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 transition disabled:opacity-60 disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  tabIndex={0}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  disabled={isSubmitting || isLocked}
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 focus:outline-none focus:text-indigo-600 transition"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isSubmitting || isLocked}
              className="w-full mt-2 py-3 px-4 rounded-xl font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 shadow-lg shadow-indigo-600/30 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2"
            >
              {isSubmitting ? (
                <>
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
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

          {/* Security Notice */}
          <div className="mt-8 pt-6 border-t border-slate-100 text-center">
            <p className="text-xs text-slate-400 flex items-center justify-center space-x-1">
              <Lock className="w-3 h-3 inline mr-1 text-slate-400" />
              <span>Protected by Argon2id & Host-Only Session Security</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
