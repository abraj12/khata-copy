export interface OwnerUser {
  role: 'OWNER';
  phone?: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  owner: OwnerUser | null;
  error: string | null;
}

export interface LoginResponse {
  success: boolean;
  authenticated: boolean;
  owner?: OwnerUser;
  message?: string;
  isLocked?: boolean;
  remainingMs?: number;
}
