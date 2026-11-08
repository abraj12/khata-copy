export interface OwnerUser {
  role: 'OWNER';
  phone?: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  owner: OwnerUser | null;
  error: string | null;
  isOffline?: boolean;
}

export interface LoginResponse {
  success: boolean;
  authenticated: boolean;
  csrfToken?: string;
  owner?: OwnerUser;
  message?: string;
  isLocked?: boolean;
  remainingMs?: number;
}
