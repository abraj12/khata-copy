import React from 'react';
import { ArrowUpRight } from 'lucide-react';

export interface DashboardMetricCardProps {
  title: string;
  value: string;
  subtitle?: string;
  badgeText?: string;
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
  icon?: React.ReactNode;
  onClick?: () => void;
  actionLabel?: string;
  testId?: string;
}

const TONE_VALUE_CLASS: Record<NonNullable<DashboardMetricCardProps['tone']>, string> = {
  default: 'text-[var(--khata-text)]',
  accent: 'text-[var(--khata-accent)]',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-rose-600 dark:text-rose-400',
};

const TONE_ICON_BG_CLASS: Record<NonNullable<DashboardMetricCardProps['tone']>, string> = {
  default: 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)]',
  accent: 'bg-[var(--khata-accent)]/10 text-[var(--khata-accent)] border-[var(--khata-accent)]/25',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25',
  danger: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25',
};

export const DashboardMetricCard: React.FC<DashboardMetricCardProps> = React.memo(({
  title,
  value,
  subtitle,
  badgeText,
  tone = 'default',
  icon,
  onClick,
  actionLabel,
  testId,
}) => {
  const interactive = typeof onClick === 'function';

  const body = (
    <div className="flex flex-col justify-between h-full gap-3 text-left">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--khata-text-muted)]">
            {title}
          </p>
          {badgeText && (
            <span className="inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--khata-surface-inset)] border border-[var(--khata-border)] text-[var(--khata-text-muted)]">
              {badgeText}
            </span>
          )}
        </div>
        {icon && (
          <span
            className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${TONE_ICON_BG_CLASS[tone]}`}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
      </div>

      <div>
        <div
          className={`text-xl sm:text-2xl font-black font-mono tracking-tight break-words ${TONE_VALUE_CLASS[tone]}`}
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value}
        </div>
        {subtitle && (
          <p className="text-xs text-[var(--khata-text-muted)] font-medium mt-1 leading-snug">
            {subtitle}
          </p>
        )}
      </div>

      {interactive && (
        <div className="pt-1 flex items-center gap-1 text-[11px] font-bold text-[var(--khata-accent)]">
          <span>{actionLabel || 'Open module'}</span>
          <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
        </div>
      )}
    </div>
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        className="neu-card p-4 sm:p-5 w-full text-left hover:border-[var(--khata-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--khata-accent)] transition-all cursor-pointer"
      >
        {body}
      </button>
    );
  }

  return (
    <div data-testid={testId} className="neu-card p-4 sm:p-5 w-full">
      {body}
    </div>
  );
});
