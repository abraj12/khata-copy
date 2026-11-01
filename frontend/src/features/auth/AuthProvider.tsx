import React, { createContext, useContext, useEffect, useState } from 'react';
import { authApi } from './authApi.js';
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
  });

  const checkAuth = async () => {
    try {
      setAuthState((prev) => ({ ...prev, isLoading: true, error: null, isOffline: false }));
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
      const status = (err as { status?: number }).status;
      if (status === 401) {
        // Authenticated session is definitely invalid or expired
        setAuthState({
          isAuthenticated: false,
          isLoading: false,
          owner: null,
          error: null,
          isOffline: false,
        });
      } else {
        // Network timeout, Render cold boot, or temporary 502/503 service outage
        setAuthState((prev) => ({
          ...prev,
          isLoading: false,
          isOffline: true,
          error:
            status === 503 || status === 502
              ? 'Khata server is temporarily waking up. Please retry in a moment.'
              : 'Connection temporarily unavailable. Please verify internet connectivity.',
        }));
      }
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  const login = async (phone: string, pass: string) => {
    setAuthState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const res = await authApi.login(phone, pass);
      if (res.authenticated) {
        setAuthState({
          isAuthenticated: true,
          isLoading: false,
          owner: (res.owner as OwnerUser) || { role: 'OWNER' },
          error: null,
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
      // Scenario 1: Successful logout - backend revokes session, frontend clears state
      setAuthState({
        isAuthenticated: false,
        isLoading: false,
        owner: null,
        error: null,
        isOffline: false,
      });
      // Purge cached offline assets and sensitive document data on logout
      if (typeof window !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
      }
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        // Scenario 3: Session is already unauthenticated/expired on the server
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
        // Scenario 2: Network failure / backend unavailable (502/503/timeout)
        // Do NOT falsely claim server revocation. Keep state and notify user with retry option.
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
