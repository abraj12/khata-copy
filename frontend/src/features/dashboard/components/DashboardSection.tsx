import React from 'react';
import { ArrowRight } from 'lucide-react';

export interface DashboardSectionProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}

export const DashboardSection: React.FC<DashboardSectionProps> = ({
  title,
  subtitle,
  icon,
  actionLabel,
  onAction,
  rightSlot,
  children,
}) => {
  return (
    <section className="neu-card p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          {icon && (
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center bg-[var(--khata-surface-inset)] border border-[var(--khata-border)] text-[var(--khata-accent)] flex-shrink-0"
              aria-hidden="true"
            >
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-extrabold tracking-tight text-[var(--khata-text)]">
              {title}
            </h2>
            {subtitle && (
              <p className="text-xs text-[var(--khata-text-muted)] font-medium mt-0.5">
                {subtitle}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {rightSlot}
          {onAction && actionLabel && (
            <button
              type="button"
              onClick={onAction}
              className="neu-btn-secondary text-xs px-3 py-2 min-h-[38px] font-bold inline-flex items-center gap-1.5"
            >
              <span>{actionLabel}</span>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {children}
    </section>
  );
};
