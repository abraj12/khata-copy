import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from 'react';
import { authApi } from './authApi.js';
import { setCsrfToken } from '../../lib/apiClient.js';
import type { AuthState, OwnerUser } from './auth.types.js';

interface AuthContextType extends AuthState {
  login: (phone: string, pass: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    isLoading: true,
    owner: null,
    error: null,
    isOffline: false,
  });

  const authCheckPromiseRef = useRef<Promise<void> | null>(null);

  const checkAuth = useCallback(async () => {
    if (authCheckPromiseRef.current) {
      return authCheckPromiseRef.current;
    }

    const operation = (async () => {
      setAuthState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
        isOffline: false,
      }));

      try {
        const res = await authApi.me();

        if (res && res.authenticated) {
          setAuthState({
            isAuthenticated: true,
            isLoading: false,
            owner: res.owner as OwnerUser,
            error: null,
            isOffline: false,
          });
        } else {
          setAuthState({
            isAuthenticated: false,
            isLoading: false,
            owner: null,
            error: null,
            isOffline: false,
          });
        }
      } catch (err: unknown) {
        const error = err as {
          status?: number;
          code?: string;
          message?: string;
        };

        if (error.status === 401) {
          // Only an explicit HTTP 401 means no valid session
          setCsrfToken(null);
          setAuthState({
            isAuthenticated: false,
            isLoading: false,
            owner: null,
            error: null,
            isOffline: false,
          });
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

        // Preserve current authentication state; never clear owner or credentials on connection failure
        setAuthState((prev) => ({
          ...prev,
          isLoading: false,
          isOffline: true,
          error: message,
        }));
      }
    })();

    authCheckPromiseRef.current = operation;

    try {
      await operation;
    } finally {
      authCheckPromiseRef.current = null;
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  const login = async (phone: string, pass: string) => {
    setAuthState((prev) => ({ ...prev, isLoading: true, error: null, isOffline: false }));
    try {
      const res = await authApi.login(phone, pass);
      if (res.authenticated) {
        setAuthState({
          isAuthenticated: true,
          isLoading: false,
          owner: (res.owner as OwnerUser) || { role: 'OWNER' },
          error: null,
          isOffline: false,
        });
      }
    } catch (err) {
      setAuthState((prev) => ({
        ...prev,
        isLoading: false,
        isAuthenticated: false,
        error: (err as Error).message || 'Invalid mobile number or password.',
      }));
      throw err;
    }
  };

  const logout = async () => {
    setAuthState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      await authApi.logout();
      setCsrfToken(null);
      setAuthState({
        isAuthenticated: false,
        isLoading: false,
        owner: null,
        error: null,
        isOffline: false,
      });
      if (typeof window !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
      }
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        setCsrfToken(null);
        setAuthState({
          isAuthenticated: false,
          isLoading: false,
          owner: null,
          error: null,
          isOffline: false,
        });
        if (typeof window !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
        }
      } else {
        const failureMessage =
          'Logout could not be confirmed with the server. Please check your network and retry.';
        setAuthState((prev) => ({
          ...prev,
          isLoading: false,
          error: failureMessage,
          isOffline: true,
        }));
        throw new Error(failureMessage);
      }
    }
  };

  return (
    <AuthContext.Provider
      value={{
        ...authState,
        login,
        logout,
        refreshAuth: checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
