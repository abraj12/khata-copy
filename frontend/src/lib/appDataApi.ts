import { apiClient } from './apiClient.js';

export interface ServerThemePreferences {
  version?: number;
  preset?: string;
  textSize?: string;
  contrastOverride?: string;
  reduceMotion?: string;
  increaseSpacing?: boolean;
  strongFocus?: boolean;
}

export interface ServerUserPreferences {
  preferenceKey: string;
  theme: ServerThemePreferences;
  dashboardDefaults: {
    defaultDatePreset: string;
  };
  printPreferences: {
    defaultPaperSize: 'A4';
    autoOpenPreview: boolean;
  };
  updatedAt: string | null;
}

export interface PreferencesResponse {
  success: boolean;
  preferences: ServerUserPreferences;
  source: 'mongodb' | 'default';
}

export interface AppNotificationItem {
  id: string;
  category: 'quotation_expiry' | 'sync' | 'system' | 'billing' | 'supplier';
  severity: 'info' | 'warning' | 'success' | 'error';
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  success: boolean;
  notifications: AppNotificationItem[];
  unreadCount: number;
  source: 'mongodb' | 'default';
}

export async function fetchPreferencesApi(signal?: AbortSignal): Promise<PreferencesResponse> {
  const { data } = await apiClient<PreferencesResponse>('/api/v1/preferences', {
    method: 'GET',
    signal,
  });
  return data;
}

export async function updatePreferencesApi(patch: {
  theme?: ServerThemePreferences;
  dashboardDefaults?: { defaultDatePreset?: string };
  printPreferences?: { defaultPaperSize?: 'A4'; autoOpenPreview?: boolean };
}): Promise<PreferencesResponse> {
  const { data } = await apiClient<PreferencesResponse>('/api/v1/preferences', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  return data;
}

export async function fetchNotificationsApi(
  options: { limit?: number; unreadOnly?: boolean; signal?: AbortSignal } = {}
): Promise<NotificationsResponse> {
  const params = new URLSearchParams();
  if (typeof options.limit === 'number') params.set('limit', String(options.limit));
  if (options.unreadOnly) params.set('unreadOnly', 'true');
  const query = params.toString();
  const { data } = await apiClient<NotificationsResponse>(
    `/api/v1/notifications${query ? `?${query}` : ''}`,
    {
      method: 'GET',
      signal: options.signal,
    }
  );
  return data;
}

export async function markNotificationReadApi(id: string): Promise<{ success: boolean; updatedCount: number }> {
  const { data } = await apiClient<{ success: boolean; updatedCount: number }>(
    `/api/v1/notifications/${encodeURIComponent(id)}/read`,
    { method: 'POST' }
  );
  return data;
}

export async function markAllNotificationsReadApi(): Promise<{ success: boolean; updatedCount: number }> {
  const { data } = await apiClient<{ success: boolean; updatedCount: number }>(
    '/api/v1/notifications/read-all',
    { method: 'POST' }
  );
  return data;
}

export async function sendTelemetryApi(payload: {
  kind: 'read_latency' | 'outbox_sync' | 'pdf_render' | 'client_error';
  name: string;
  durationMs?: number | null;
  ok?: boolean;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await apiClient('/api/v1/telemetry', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort non-blocking telemetry
  }
}
