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
      setAuthState((prev) => ({ ...prev, isLoading: true, error: null }));
      const res = await authApi.me();
      if (res && res.authenticated) {
        setAuthState({
          isAuthenticated: true,
          isLoading: false,
          owner: res.owner as OwnerUser,
          error: null,
        });
      } else {
        setAuthState({
          isAuthenticated: false,
          isLoading: false,
          owner: null,
          error: null,
        });
      }
    } catch {
      // Unauthenticated or network error on startup: fail closed to logged-out state
      setAuthState({
        isAuthenticated: false,
        isLoading: false,
        owner: null,
        error: null,
      });
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
    try {
      await authApi.logout();
    } catch {
      // Continue client cleanup even if network fails
    } finally {
      setAuthState({
        isAuthenticated: false,
        isLoading: false,
        owner: null,
        error: null,
      });
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
