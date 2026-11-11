import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  Palette,
  Type,
  Eye,
  Activity,
  Layers,
  RotateCcw,
  Check,
  Calendar,
  Printer,
  Server,
  RefreshCw,
} from 'lucide-react';
import {
  useThemeAccessibility,
  DefaultDashboardDatePreset,
} from '../context/ThemeAccessibilityContext.js';
import {
  fetchHealthReadyApi,
  fetchRealtimeStatusApi,
  sendTelemetryApi,
  SystemReadinessResponse,
  RealtimeStatusResponse,
} from '../lib/appDataApi.js';
import {
  NEUMORPHIC_PRESETS,
  NeuPresetId,
  TextSizeOption,
  ContrastOption,
  MotionOption,
} from '../theme/neumorphicThemes.js';

interface AppearanceAccessibilityModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AppearanceAccessibilityModal: React.FC<AppearanceAccessibilityModalProps> = ({
  isOpen,
  onClose,
}) => {
  const {
    preferences,
    workflowDefaults,
    setPreset,
    setTextSize,
    setContrastOverride,
    setReduceMotion,
    setIncreaseSpacing,
    setStrongFocus,
    setDefaultDatePreset,
    setAutoOpenPreview,
    resetToDefaults,
  } = useThemeAccessibility();

  const [checkingDiagnostics, setCheckingDiagnostics] = useState(false);
  const [readiness, setReadiness] = useState<SystemReadinessResponse | null>(null);
  const [realtime, setRealtime] = useState<RealtimeStatusResponse['data'] | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  const handleCheckSystemStatus = async () => {
    setCheckingDiagnostics(true);
    setDiagnosticsError(null);
    const startedAt = Date.now();
    try {
      const [readyRes, realtimeRes] = await Promise.all([
        fetchHealthReadyApi(),
        fetchRealtimeStatusApi(),
      ]);
      setReadiness(readyRes);
      setRealtime(realtimeRes?.data ?? null);
      void sendTelemetryApi({
        kind: 'read_latency',
        name: 'system_diagnostics',
        durationMs: Date.now() - startedAt,
        ok: readyRes.status === 'ready',
      });
    } catch (err) {
      setDiagnosticsError((err as Error).message || 'Could not reach backend diagnostics.');
      void sendTelemetryApi({
        kind: 'client_error',
        name: 'system_diagnostics_failed',
        durationMs: Date.now() - startedAt,
        ok: false,
      });
    } finally {
      setCheckingDiagnostics(false);
    }
  };

  const modalRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Focus trap, Escape key handling, and focus restoration
  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === 'Tab' && modalRef.current) {
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;

        const firstElement = focusables[0];
        const lastElement = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    closeBtnRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="appearance-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="neu-card w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 my-auto text-left"
        style={{ background: 'var(--khata-surface)' }}
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--khata-border)]">
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-[var(--khata-surface-raised)] border border-[var(--khata-border)] text-[var(--khata-accent)]">
              <Palette className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="appearance-modal-title"
                className="text-lg font-bold tracking-tight text-[var(--khata-text)]"
              >
                Appearance & Accessibility
              </h2>
              <p className="text-xs text-[var(--khata-text-muted)]">
                Customize your visual theme, typography size, and readability settings.
              </p>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            className="p-2 rounded-lg text-[var(--khata-text-muted)] hover:text-[var(--khata-text)] hover:bg-[var(--khata-surface-inset)] transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Close Appearance & Accessibility settings"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Section A: Nine Neumorphic Presets */}
        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <label className="text-sm font-semibold flex items-center gap-2 text-[var(--khata-text)]">
              <Palette className="w-4 h-4 text-[var(--khata-accent)]" />
              Neumorphic Style Presets (9 Styles)
            </label>
            <span className="text-xs text-[var(--khata-text-muted)]">
              Active: {NEUMORPHIC_PRESETS.find((p) => p.id === preferences.preset)?.name}
            </span>
          </div>

          <div
            className="grid grid-cols-1 sm:grid-cols-3 gap-3"
            role="radiogroup"
            aria-label="Neumorphic Style Presets"
          >
            {NEUMORPHIC_PRESETS.map((p) => {
              const isSelected = preferences.preset === p.id;
              return (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setPreset(p.id as NeuPresetId)}
                  className={`p-3 rounded-xl text-left border transition-all flex flex-col justify-between ${
                    isSelected
                      ? 'border-[var(--khata-accent)] ring-2 ring-[var(--khata-accent)]/30 shadow-md'
                      : 'border-[var(--khata-border)] hover:border-[var(--khata-accent)]/50'
                  }`}
                  style={{ background: 'var(--khata-surface-raised)' }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-1.5 w-full mb-2">
                    <span className="font-semibold text-xs text-[var(--khata-text)]">
                      {p.name}
                    </span>
                    {isSelected && (
                      <span className="flex items-center justify-center w-4 h-4 rounded-full bg-[var(--khata-accent)] text-white">
                        <Check className="w-3 h-3" />
                      </span>
                    )}
                  </div>

                  {/* Visual Theme Swatch */}
                  <div
                    className="w-full h-8 rounded-lg mb-2 flex items-center justify-center text-[10px] font-semibold border border-black/10"
                    style={{
                      background: p.previewSurface,
                      color: p.previewText,
                    }}
                  >
                    <span
                      className="px-2 py-0.5 rounded text-[9px] text-white"
                      style={{ backgroundColor: p.previewAccent }}
                    >
                      Sample
                    </span>
                  </div>

                  <p className="text-[11px] leading-snug text-[var(--khata-text-muted)] line-clamp-2">
                    {p.shortDesc}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Section B: Readability and Accessibility Controls */}
        <div className="mt-6 pt-5 border-t border-[var(--khata-border)] space-y-5">
          {/* 1. Text Scale */}
          <div>
            <label className="text-sm font-semibold flex items-center gap-2 mb-2 text-[var(--khata-text)]">
              <Type className="w-4 h-4 text-[var(--khata-accent)]" />
              Text Scale (rem-based)
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(['100', '115', '130', '145'] as TextSizeOption[]).map((size) => (
                <button
                  key={size}
                  onClick={() => setTextSize(size)}
                  className={`py-2 px-3 rounded-lg text-xs font-semibold border transition-all ${
                    preferences.textSize === size
                      ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-sm'
                      : 'border-[var(--khata-border)] text-[var(--khata-text)] bg-[var(--khata-surface-inset)] hover:border-[var(--khata-accent)]'
                  }`}
                >
                  {size}% {size === '100' && '(Default)'}
                </button>
              ))}
            </div>
          </div>

          {/* 2. Contrast Override & Reduced Motion */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-semibold flex items-center gap-2 mb-2 text-[var(--khata-text)]">
                <Eye className="w-4 h-4 text-[var(--khata-accent)]" />
                Contrast Override
              </label>
              <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-2">
                {(['enhanced', 'default'] as ContrastOption[]).map((c) => (
                  <button
                    key={c}
                    onClick={() => setContrastOverride(c)}
                    className={`py-2 px-3 rounded-lg text-xs font-semibold border transition-all ${
                      preferences.contrastOverride === c
                        ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-sm'
                        : 'border-[var(--khata-border)] text-[var(--khata-text)] bg-[var(--khata-surface-inset)] hover:border-[var(--khata-accent)]'
                    }`}
                  >
                    {c === 'enhanced' ? 'Enhanced (Default)' : 'Standard'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-semibold flex items-center gap-2 mb-2 text-[var(--khata-text)]">
                <Activity className="w-4 h-4 text-[var(--khata-accent)]" />
                Reduce Motion
              </label>
              <div className="grid grid-cols-1 min-[360px]:grid-cols-3 gap-2">
                {(['system', 'on', 'off'] as MotionOption[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setReduceMotion(m)}
                    className={`py-2 px-2 rounded-lg text-xs font-semibold capitalize border transition-all ${
                      preferences.reduceMotion === m
                        ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-sm'
                        : 'border-[var(--khata-border)] text-[var(--khata-text)] bg-[var(--khata-surface-inset)] hover:border-[var(--khata-accent)]'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 3. Spacing & Strong Focus */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-semibold flex items-center gap-2 mb-2 text-[var(--khata-text)]">
                <Layers className="w-4 h-4 text-[var(--khata-accent)]" />
                Layout Spacing
              </label>
              <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-2">
                {[false, true].map((val) => (
                  <button
                    key={String(val)}
                    onClick={() => setIncreaseSpacing(val)}
                    className={`py-2 px-3 rounded-lg text-xs font-semibold border transition-all ${
                      preferences.increaseSpacing === val
                        ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-sm'
                        : 'border-[var(--khata-border)] text-[var(--khata-text)] bg-[var(--khata-surface-inset)] hover:border-[var(--khata-accent)]'
                    }`}
                  >
                    {val ? 'Increased' : 'Normal'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-semibold flex items-center gap-2 mb-2 text-[var(--khata-text)]">
                <Eye className="w-4 h-4 text-[var(--khata-accent)]" />
                Keyboard Focus Outline
              </label>
              <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-2">
                {[true, false].map((val) => (
                  <button
                    key={String(val)}
                    onClick={() => setStrongFocus(val)}
                    className={`py-2 px-3 rounded-lg text-xs font-semibold border transition-all ${
                      preferences.strongFocus === val
                        ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-sm'
                        : 'border-[var(--khata-border)] text-[var(--khata-text)] bg-[var(--khata-surface-inset)] hover:border-[var(--khata-accent)]'
                    }`}
                  >
                    {val ? 'Strong Focus' : 'Standard'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Section C: Workflow & Print Defaults (Synced to MongoDB Preferences) */}
        <div className="mt-6 pt-5 border-t border-[var(--khata-border)] space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="appearance-default-date-preset"
                className="text-sm font-semibold flex items-center gap-2 mb-2 text-[var(--khata-text)]"
              >
                <Calendar className="w-4 h-4 text-[var(--khata-accent)]" />
                Default Dashboard Period
              </label>
              <select
                id="appearance-default-date-preset"
                value={workflowDefaults.defaultDatePreset}
                onChange={(e) => setDefaultDatePreset(e.target.value as DefaultDashboardDatePreset)}
                className="neu-input w-full text-xs font-semibold"
              >
                <option value="all_time">All Time</option>
                <option value="today">Today</option>
                <option value="yesterday">Yesterday</option>
                <option value="last_7_days">Last 7 Days</option>
                <option value="last_30_days">Last 30 Days</option>
                <option value="this_month">This Month</option>
                <option value="last_month">Last Month</option>
                <option value="this_fy">This Financial Year</option>
                <option value="previous_fy">Previous Financial Year</option>
              </select>
            </div>

            <div>
              <span className="text-sm font-semibold flex items-center gap-2 mb-2 text-[var(--khata-text)]">
                <Printer className="w-4 h-4 text-[var(--khata-accent)]" />
                After Saving Bill / Invoice ({workflowDefaults.defaultPaperSize})
              </span>
              <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-2">
                {[true, false].map((val) => (
                  <button
                    key={String(val)}
                    type="button"
                    onClick={() => setAutoOpenPreview(val)}
                    className={
                      'py-2 px-3 rounded-lg text-xs font-semibold border transition-all ' +
                      (workflowDefaults.autoOpenPreview === val
                        ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-sm'
                        : 'border-[var(--khata-border)] text-[var(--khata-text)] bg-[var(--khata-surface-inset)] hover:border-[var(--khata-accent)]')
                    }
                  >
                    {val ? 'Auto-Open Preview' : 'Summary Only'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Section D: On-demand System & Sync Status */}
          <div className="p-3.5 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--khata-text)]">
                <Server className="w-4 h-4 text-[var(--khata-accent)]" />
                <span>System, Database &amp; Realtime Status</span>
              </div>
              <button
                type="button"
                onClick={() => void handleCheckSystemStatus()}
                disabled={checkingDiagnostics}
                className="neu-btn-secondary text-xs px-3 py-1.5 inline-flex items-center gap-1.5"
              >
                <RefreshCw className={'w-3.5 h-3.5 ' + (checkingDiagnostics ? 'animate-spin' : '')} />
                <span>{checkingDiagnostics ? 'Checking...' : 'Check Status'}</span>
              </button>
            </div>

            {diagnosticsError && (
              <p className="text-xs text-rose-500">{diagnosticsError}</p>
            )}

            {(readiness || realtime) && (
              <div className="space-y-1.5 text-xs text-[var(--khata-text-muted)]">
                {readiness && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        'px-2 py-0.5 rounded font-semibold ' +
                        (readiness.status === 'ready'
                          ? 'bg-emerald-500/15 text-emerald-600'
                          : 'bg-rose-500/15 text-rose-600')
                      }
                    >
                      Backend: {readiness.status}
                    </span>
                    {readiness.services?.postgres && (
                      <span className="px-2 py-0.5 rounded bg-[var(--khata-surface)] border border-[var(--khata-border)]">
                        PostgreSQL: {readiness.services.postgres}
                      </span>
                    )}
                    {readiness.services?.mongodb && (
                      <span className="px-2 py-0.5 rounded bg-[var(--khata-surface)] border border-[var(--khata-border)]">
                        MongoDB: {readiness.services.mongodb}
                      </span>
                    )}
                    {readiness.message && <span>{readiness.message}</span>}
                  </div>
                )}
                {realtime && (
                  <p className="text-[11px] leading-snug">
                    Sync mode: <strong className="text-[var(--khata-text)]">{realtime.status}</strong> via{' '}
                    <span className="font-mono">{realtime.authoritativeSource}</span> — {realtime.notes}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer actions: Reset & Close */}
        <div className="mt-6 pt-4 border-t border-[var(--khata-border)] flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={resetToDefaults}
            className="neu-btn-secondary text-xs px-3 py-2 flex items-center gap-1.5"
            title="Reset to Soft Light preset and standard accessibility settings"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset to Defaults
          </button>

          <button
            onClick={onClose}
            className="neu-btn-primary text-xs px-5 py-2"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
