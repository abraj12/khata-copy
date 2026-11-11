import { API_BASE_URL, fetchCsrfToken, getCsrfToken } from './apiClient';

export async function fetchAuthorizedBlob(
  endpoint: string,
  fallbackError: string,
  signal?: AbortSignal
): Promise<Blob> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    credentials: 'include',
    signal,
  });

  if (!response.ok) {
    const errJson = await response.json().catch(() => null);
    throw new Error(errJson?.message || errJson?.error || fallbackError);
  }

  return response.blob();
}

export async function fetchPostPdfBlob(
  endpoint: string,
  payload: unknown,
  fallbackError: string,
  signal?: AbortSignal
): Promise<Blob> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
  let csrfToken = getCsrfToken();
  if (!csrfToken) {
    csrfToken = await fetchCsrfToken();
  }

  const sendRequest = (token: string | null) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['X-CSRF-Token'] = token;
    }
    return fetch(url, {
      method: 'POST',
      headers,
      credentials: 'include',
      signal,
      body: JSON.stringify(payload),
    });
  };

  let res = await sendRequest(csrfToken);
  if (!res.ok) {
    const errorJson = await res.json().catch(() => ({}));
    if (
      res.status === 403 &&
      (errorJson.message?.includes('CSRF token') || errorJson.message?.includes('Origin'))
    ) {
      const refreshedToken = await fetchCsrfToken();
      if (refreshedToken) {
        const retryRes = await sendRequest(refreshedToken);
        if (retryRes.ok) {
          res = retryRes;
        } else {
          const retryErr = await retryRes.json().catch(() => ({}));
          throw new Error(retryErr.message || retryErr.error || fallbackError);
        }
      } else {
        throw new Error(errorJson.message || errorJson.error || fallbackError);
      }
    } else {
      throw new Error(errorJson.message || errorJson.error || fallbackError);
    }
  }

  return res.blob();
}
