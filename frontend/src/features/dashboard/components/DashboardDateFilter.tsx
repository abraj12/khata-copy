import React from 'react';
import { Calendar } from 'lucide-react';
import type { DashboardDatePreset } from '../dashboard.types.js';

export interface DashboardDateFilterProps {
  preset: DashboardDatePreset;
  customFrom: string;
  customTo: string;
  activeRangeLabel: string;
  onPresetChange: (preset: DashboardDatePreset) => void;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  onApplyCustom: () => void;
  disabled?: boolean;
}

const PRESET_OPTIONS: Array<{ id: DashboardDatePreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'last_7_days', label: 'Last 7 Days' },
  { id: 'this_month', label: 'This Month' },
  { id: 'last_30_days', label: 'Last 30 Days' },
  { id: 'all_time', label: 'All Time' },
  { id: 'custom', label: 'Custom' },
];

export const DashboardDateFilter: React.FC<DashboardDateFilterProps> = ({
  preset,
  customFrom,
  customTo,
  activeRangeLabel,
  onPresetChange,
  onCustomFromChange,
  onCustomToChange,
  onApplyCustom,
  disabled = false,
}) => {
  return (
    <div className="neu-card p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2" role="group" aria-label="Dashboard Date Filter">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--khata-text-muted)] mr-1">
            <Calendar className="w-3.5 h-3.5 text-[var(--khata-accent)]" aria-hidden="true" />
            <span>Period:</span>
          </span>
          {PRESET_OPTIONS.map((item) => {
            const active = preset === item.id;
            return (
              <button
                key={item.id}
                type="button"
                disabled={disabled}
                onClick={() => onPresetChange(item.id)}
                aria-pressed={active}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border min-h-[36px] transition-all ${
                  active
                    ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-sm'
                    : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <span className="text-[11px] font-mono font-semibold text-[var(--khata-text-muted)]">
          Showing: {activeRangeLabel}
        </span>
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap items-end gap-3 pt-2 border-t border-[var(--khata-border)]/70">
          <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
            <span className="text-[11px] text-[var(--khata-text-muted)]">From Date</span>
            <input
              type="date"
              aria-label="Custom From Date"
              value={customFrom}
              onChange={(e) => onCustomFromChange(e.target.value)}
              className="neu-input text-xs py-1.5 px-3"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--khata-text)]">
            <span className="text-[11px] text-[var(--khata-text-muted)]">To Date</span>
            <input
              type="date"
              aria-label="Custom To Date"
              value={customTo}
              onChange={(e) => onCustomToChange(e.target.value)}
              className="neu-input text-xs py-1.5 px-3"
            />
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={onApplyCustom}
            className="neu-btn-primary text-xs px-4 py-2 min-h-[40px]"
          >
            Apply Range
          </button>
        </div>
      )}
    </div>
  );
};
