import { apiClient, fetchCsrfToken, setCsrfToken } from '../../lib/apiClient.js';
import type { LoginResponse } from './auth.types.js';

export const authApi = {
  async login(phone: string, password: string): Promise<LoginResponse> {
    const { data } = await apiClient<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone, password }),
    });

    if (data.csrfToken) {
      setCsrfToken(data.csrfToken);
    } else {
      // Backward-compatible fallback
      await fetchCsrfToken();
    }

    return data;
  },

  async me(): Promise<{ authenticated: boolean; owner: { role: 'OWNER'; phone?: string } }> {
    const { data } = await apiClient<{ authenticated: boolean; owner: { role: 'OWNER'; phone?: string } }>(
      '/api/v1/auth/me',
      {
        method: 'GET',
      }
    );
    return data;
  },

  async logout(): Promise<{ success: boolean; message: string }> {
    const { data } = await apiClient<{ success: boolean; message: string }>('/api/v1/auth/logout', {
      method: 'POST',
    });
    setCsrfToken(null);
    return data;
  },
};
