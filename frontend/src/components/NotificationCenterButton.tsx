import React, { useState, useEffect, useCallback } from 'react';
import { useViewportPopover } from '../utils/useViewportPopover.js';
import {
  Bell,
  Check,
  CheckCheck,
  RefreshCw,
  AlertTriangle,
  Info,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import {
  AppNotificationItem,
  fetchNotificationsApi,
  markAllNotificationsReadApi,
  markNotificationReadApi,
} from '../lib/appDataApi.js';

function formatRelativeTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  const diffMs = Math.max(0, Date.now() - parsed);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function renderSeverityIcon(severity: AppNotificationItem['severity']) {
  switch (severity) {
    case 'warning':
      return <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />;
    case 'error':
      return <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />;
    case 'success':
      return <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />;
    default:
      return <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" aria-hidden="true" />;
  }
}

export const NotificationCenterButton: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closePopover = useCallback(() => setIsOpen(false), []);
  const { containerRef, triggerRef, popoverStyle } = useViewportPopover({
    isOpen,
    onClose: closePopover,
    preferredWidthPx: 384,
    offsetY: 8,
  });

  const loadNotifications = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchNotificationsApi({ limit: 20, signal });
      setNotifications(Array.isArray(res.notifications) ? res.notifications : []);
      setUnreadCount(typeof res.unreadCount === 'number' ? res.unreadCount : 0);
    } catch (err: any) {
      if (err?.code === 'REQUEST_ABORTED') return;
      setError('Unable to load alerts.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch once on authenticated mount (zero background polling intervals)
  useEffect(() => {
    const controller = new AbortController();
    void loadNotifications(controller.signal);
    return () => controller.abort();
  }, [loadNotifications]);



  const handleToggle = () => {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      void loadNotifications();
    }
  };

  const handleMarkRead = async (id: string) => {
    setBusyAction(true);
    try {
      await markNotificationReadApi(id);
      setNotifications((prev) =>
        prev.map((item) => (item.id === id ? { ...item, isRead: true, readAt: new Date().toISOString() } : item))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      setError('Failed to mark alert as read.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleMarkAllRead = async () => {
    setBusyAction(true);
    try {
      await markAllNotificationsReadApi();
      const now = new Date().toISOString();
      setNotifications((prev) => prev.map((item) => ({ ...item, isRead: true, readAt: now })));
      setUnreadCount(0);
    } catch {
      setError('Failed to mark all alerts as read.');
    } finally {
      setBusyAction(false);
    }
  };

  return (
    <div ref={containerRef} className="relative shrink-0 inline-flex items-center">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className="neu-btn-secondary px-2 py-1.5 sm:px-2.5 sm:py-2 text-xs font-medium relative inline-flex items-center justify-center gap-1.5 min-h-[38px] sm:min-h-[40px]"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={isOpen}
        title="Notifications"
      >
        <Bell className="w-4 h-4 shrink-0" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center bg-rose-600 text-white"
            aria-label={`${unreadCount} unread notifications`}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Business notifications"
          className="absolute right-0 mt-2 w-[min(24rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] max-h-[calc(100vh-5rem)] flex flex-col rounded-2xl border border-[var(--khata-border)] shadow-xl z-50 overflow-hidden"
          style={{ backgroundColor: 'var(--khata-surface)', color: 'var(--khata-text)', ...popoverStyle }}
        >
          <div className="px-4 py-3 border-b border-[var(--khata-border)] flex flex-wrap items-center justify-between gap-2 shrink-0">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--khata-text)]">
                Notifications
              </h3>
              <p className="text-[11px] text-[var(--khata-text-muted)]">
                {unreadCount > 0 ? `${unreadCount} unread alert${unreadCount === 1 ? '' : 's'}` : 'All caught up'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {unreadCount > 0 && (
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() => void handleMarkAllRead()}
                  className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-[var(--khata-border)] hover:bg-[var(--khata-surface-inset)] inline-flex items-center gap-1"
                >
                  <CheckCheck className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                  <span>Mark all</span>
                </button>
              )}
              <button
                type="button"
                disabled={loading}
                onClick={() => void loadNotifications()}
                className="p-1.5 rounded-lg border border-[var(--khata-border)] hover:bg-[var(--khata-surface-inset)]"
                aria-label="Refresh notifications"
                title="Refresh notifications"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 max-h-80 overflow-y-auto divide-y divide-[var(--khata-border)]">
            {loading && notifications.length === 0 ? (
              <div className="py-8 flex items-center justify-center gap-2 text-xs text-[var(--khata-text-muted)]">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                <span>Loading alerts...</span>
              </div>
            ) : error ? (
              <div className="p-4 text-xs text-rose-600">{error}</div>
            ) : notifications.length === 0 ? (
              <div className="py-8 px-4 text-center text-xs text-[var(--khata-text-muted)]">
                No notifications yet. System events and alerts will appear here.
              </div>
            ) : (
              notifications.map((item) => (
                <div
                  key={item.id}
                  className={`p-3.5 flex flex-wrap items-start gap-2.5 transition ${
                    item.isRead ? 'opacity-75' : 'bg-[var(--khata-surface-inset)]/60'
                  }`}
                >
                  {renderSeverityIcon(item.severity)}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-bold text-[var(--khata-text)] break-words min-w-0">{item.title}</span>
                      <span className="text-[10px] font-mono text-[var(--khata-text-muted)] shrink-0">
                        {formatRelativeTime(item.createdAt)}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--khata-text-muted)] mt-0.5 break-words">{item.message}</p>
                    <div className="flex flex-wrap items-center justify-between gap-2 mt-1.5">
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--khata-text-muted)]">
                        {item.category.replace(/_/g, ' ')}
                      </span>
                      {!item.isRead && (
                        <button
                          type="button"
                          disabled={busyAction}
                          onClick={() => void handleMarkRead(item.id)}
                          className="text-[11px] font-semibold text-[var(--khata-accent)] hover:underline inline-flex items-center gap-1"
                        >
                          <Check className="w-3 h-3" aria-hidden="true" />
                          <span>Mark read</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
