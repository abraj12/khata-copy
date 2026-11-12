import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { fetchPreferencesApi, updatePreferencesApi } from '../lib/appDataApi.js';
import type { DashboardDatePreset } from '../features/dashboard/dashboard.types.js';
import {
  NeuPresetId,
  TextSizeOption,
  ContrastOption,
  MotionOption,
  UIPreferences,
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  NEUMORPHIC_PRESETS,
} from '../theme/neumorphicThemes.js';

export type DefaultDashboardDatePreset = Exclude<DashboardDatePreset, 'custom'>;

export interface WorkflowPrintPreferences {
  defaultDatePreset: DefaultDashboardDatePreset;
  defaultPaperSize: 'A4';
  autoOpenPreview: boolean;
}

const VALID_DATE_PRESETS: ReadonlySet<DefaultDashboardDatePreset> = new Set([
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'this_month',
  'last_month',
  'this_fy',
  'previous_fy',
  'all_time',
]);

export const DEFAULT_WORKFLOW_PREFERENCES: WorkflowPrintPreferences = {
  defaultDatePreset: 'all_time',
  defaultPaperSize: 'A4',
  autoOpenPreview: true,
};

const WORKFLOW_PREFERENCES_STORAGE_KEY = 'khata_workflow_preferences_v1';

const PRESET_CHROME_PALETTE: Record<NeuPresetId, { themeColor: string; colorScheme: 'light' | 'dark' }> = {
  'soft-light': { themeColor: '#eef2f6', colorScheme: 'light' },
  'soft-dark': { themeColor: '#202736', colorScheme: 'dark' },
  raised: { themeColor: '#edf1f7', colorScheme: 'light' },
  pressed: { themeColor: '#dde4ec', colorScheme: 'light' },
  concave: { themeColor: '#edf2f7', colorScheme: 'light' },
  convex: { themeColor: '#eceff4', colorScheme: 'light' },
  flat: { themeColor: '#ffffff', colorScheme: 'light' },
  'high-contrast': { themeColor: '#ffffff', colorScheme: 'light' },
  accent: { themeColor: '#ecf3f9', colorScheme: 'light' },
};

interface ThemeAccessibilityContextType {
  preferences: UIPreferences;
  workflowDefaults: WorkflowPrintPreferences;
  setPreset: (preset: NeuPresetId) => void;
  setTextSize: (size: TextSizeOption) => void;
  setContrastOverride: (contrast: ContrastOption) => void;
  setReduceMotion: (motion: MotionOption) => void;
  setIncreaseSpacing: (increase: boolean) => void;
  setStrongFocus: (focus: boolean) => void;
  setDefaultDatePreset: (preset: DefaultDashboardDatePreset) => void;
  setAutoOpenPreview: (autoOpen: boolean) => void;
  resetToDefaults: () => void;
  syncFromServer: () => Promise<void>;
  resetServerSync: () => void;
  announcement: string;
}

const ThemeAccessibilityContext = createContext<ThemeAccessibilityContextType | undefined>(undefined);

function loadSavedPreferences(): UIPreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.version === 1 || parsed.version === 2 || parsed.version === 3)) {
      // Validate preset is among valid presets
      const isValidPreset = NEUMORPHIC_PRESETS.some((p) => p.id === parsed.preset);

      // In version 2 and 3, contrastOverride defaults to 'enhanced'.
      let contrastOverride: ContrastOption = DEFAULT_PREFERENCES.contrastOverride;
      if ((parsed.version === 2 || parsed.version === 3) && ['default', 'enhanced'].includes(parsed.contrastOverride)) {
        contrastOverride = parsed.contrastOverride;
      }

      // In version 3, default preset is 'flat'.
      // If user had old default 'soft-light' from v1/v2, migrate them to 'flat'.
      let preset: NeuPresetId = DEFAULT_PREFERENCES.preset;
      if (parsed.version === 3 && isValidPreset) {
        preset = parsed.preset;
      } else if (isValidPreset && parsed.preset !== 'soft-light') {
        preset = parsed.preset;
      }

      return {
        version: 3,
        preset,
        textSize: ['100', '115', '130', '145'].includes(parsed.textSize)
          ? parsed.textSize
          : DEFAULT_PREFERENCES.textSize,
        contrastOverride,
        reduceMotion: ['system', 'on', 'off'].includes(parsed.reduceMotion)
          ? parsed.reduceMotion
          : DEFAULT_PREFERENCES.reduceMotion,
        increaseSpacing: typeof parsed.increaseSpacing === 'boolean'
          ? parsed.increaseSpacing
          : DEFAULT_PREFERENCES.increaseSpacing,
        strongFocus: typeof parsed.strongFocus === 'boolean'
          ? parsed.strongFocus
          : DEFAULT_PREFERENCES.strongFocus,
      };
    }
  } catch {
    // If localStorage access fails (e.g. security sandboxing), fallback safely
  }
  return DEFAULT_PREFERENCES;
}

function isValidDefaultPreset(value: unknown): value is DefaultDashboardDatePreset {
  return typeof value === 'string' && VALID_DATE_PRESETS.has(value as DefaultDashboardDatePreset);
}

function loadSavedWorkflowPreferences(): WorkflowPrintPreferences {
  try {
    const raw = localStorage.getItem(WORKFLOW_PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_WORKFLOW_PREFERENCES;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        defaultDatePreset: isValidDefaultPreset(parsed.defaultDatePreset)
          ? parsed.defaultDatePreset
          : DEFAULT_WORKFLOW_PREFERENCES.defaultDatePreset,
        defaultPaperSize: 'A4',
        autoOpenPreview:
          typeof parsed.autoOpenPreview === 'boolean'
            ? parsed.autoOpenPreview
            : DEFAULT_WORKFLOW_PREFERENCES.autoOpenPreview,
      };
    }
  } catch {
    // fallback safely
  }
  return DEFAULT_WORKFLOW_PREFERENCES;
}

export const ThemeAccessibilityProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [preferences, setPreferences] = useState<UIPreferences>(loadSavedPreferences);
  const [workflowDefaults, setWorkflowDefaults] = useState<WorkflowPrintPreferences>(
    loadSavedWorkflowPreferences
  );
  const [announcement, setAnnouncement] = useState<string>('');
  const serverSyncEnabledRef = useRef(false);
  const skipNextServerSaveRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetServerSync = useCallback(() => {
    serverSyncEnabledRef.current = false;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  const syncFromServer = useCallback(async () => {
    try {
      const res = await fetchPreferencesApi();
      if (res?.source === 'mongodb') {
        serverSyncEnabledRef.current = true;
      }
      if (res?.source === 'mongodb' && res.preferences) {
        skipNextServerSaveRef.current = true;
        if (res.preferences.theme) {
          const t = res.preferences.theme;
          const validPreset = NEUMORPHIC_PRESETS.some((p) => p.id === t.preset);
          const nextPrefs: UIPreferences = {
            version: 3,
            preset: validPreset ? (t.preset as NeuPresetId) : DEFAULT_PREFERENCES.preset,
            textSize: ['100', '115', '130', '145'].includes(String(t.textSize))
              ? (t.textSize as TextSizeOption)
              : DEFAULT_PREFERENCES.textSize,
            contrastOverride: ['default', 'enhanced'].includes(String(t.contrastOverride))
              ? (t.contrastOverride as ContrastOption)
              : DEFAULT_PREFERENCES.contrastOverride,
            reduceMotion: ['system', 'on', 'off'].includes(String(t.reduceMotion))
              ? (t.reduceMotion as MotionOption)
              : DEFAULT_PREFERENCES.reduceMotion,
            increaseSpacing:
              typeof t.increaseSpacing === 'boolean' ? t.increaseSpacing : DEFAULT_PREFERENCES.increaseSpacing,
            strongFocus: typeof t.strongFocus === 'boolean' ? t.strongFocus : DEFAULT_PREFERENCES.strongFocus,
          };
          setPreferences(nextPrefs);
        }

        const serverDatePreset = res.preferences.dashboardDefaults?.defaultDatePreset;
        const serverPrint = res.preferences.printPreferences;
        setWorkflowDefaults({
          defaultDatePreset: isValidDefaultPreset(serverDatePreset)
            ? serverDatePreset
            : DEFAULT_WORKFLOW_PREFERENCES.defaultDatePreset,
          defaultPaperSize: 'A4',
          autoOpenPreview:
            typeof serverPrint?.autoOpenPreview === 'boolean'
              ? serverPrint.autoOpenPreview
              : DEFAULT_WORKFLOW_PREFERENCES.autoOpenPreview,
        });
      }
    } catch {
      // Fail-open to localStorage defaults if offline or server unreachable
    }
  }, []);

  const announce = useCallback((message: string) => {
    setAnnouncement(message);
    const timer = setTimeout(() => setAnnouncement(''), 3000);
    return () => clearTimeout(timer);
  }, []);

  // Sync DOM attributes whenever preferences change
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-neu-preset', preferences.preset);
    root.setAttribute('data-text-size', preferences.textSize);
    root.setAttribute('data-contrast', preferences.contrastOverride);
    root.setAttribute('data-motion', preferences.reduceMotion);
    root.setAttribute('data-spacing', preferences.increaseSpacing ? 'increased' : 'normal');
    root.setAttribute('data-strong-focus', preferences.strongFocus ? 'true' : 'false');

    const chrome = PRESET_CHROME_PALETTE[preferences.preset] ?? PRESET_CHROME_PALETTE.flat;
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', chrome.themeColor);
    }
    const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (statusBarMeta) {
      statusBarMeta.setAttribute(
        'content',
        chrome.colorScheme === 'dark' ? 'black-translucent' : 'default'
      );
    }

    // Save non-sensitive preferences safely
    try {
      localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
      localStorage.setItem(WORKFLOW_PREFERENCES_STORAGE_KEY, JSON.stringify(workflowDefaults));
    } catch {
      // safe fallback
    }

    if (!serverSyncEnabledRef.current) return;
    if (skipNextServerSaveRef.current) {
      skipNextServerSaveRef.current = false;
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      void updatePreferencesApi({
        theme: preferences,
        dashboardDefaults: { defaultDatePreset: workflowDefaults.defaultDatePreset },
        printPreferences: {
          defaultPaperSize: workflowDefaults.defaultPaperSize,
          autoOpenPreview: workflowDefaults.autoOpenPreview,
        },
      }).catch(() => {
        // Non-blocking best-effort sync
      });
    }, 350);
  }, [preferences, workflowDefaults]);

  const setPreset = useCallback((preset: NeuPresetId) => {
    setPreferences((prev) => ({ ...prev, preset }));
    const meta = NEUMORPHIC_PRESETS.find((p) => p.id === preset);
    announce(`Appearance updated to ${meta ? meta.name : preset}`);
  }, [announce]);

  const setTextSize = useCallback((textSize: TextSizeOption) => {
    setPreferences((prev) => ({ ...prev, textSize }));
    announce(`Text scale changed to ${textSize} percent`);
  }, [announce]);

  const setContrastOverride = useCallback((contrastOverride: ContrastOption) => {
    setPreferences((prev) => ({ ...prev, contrastOverride }));
    announce(`Contrast set to ${contrastOverride === 'enhanced' ? 'Enhanced (Default)' : 'Standard'}`);
  }, [announce]);

  const setReduceMotion = useCallback((reduceMotion: MotionOption) => {
    setPreferences((prev) => ({ ...prev, reduceMotion }));
    announce(`Motion preference set to ${reduceMotion}`);
  }, [announce]);

  const setIncreaseSpacing = useCallback((increaseSpacing: boolean) => {
    setPreferences((prev) => ({ ...prev, increaseSpacing }));
    announce(`Layout spacing ${increaseSpacing ? 'increased' : 'normal'}`);
  }, [announce]);

  const setStrongFocus = useCallback((strongFocus: boolean) => {
    setPreferences((prev) => ({ ...prev, strongFocus }));
    announce('Strong focus indicator ' + (strongFocus ? 'enabled' : 'disabled'));
  }, [announce]);

  const setDefaultDatePreset = useCallback((defaultDatePreset: DefaultDashboardDatePreset) => {
    setWorkflowDefaults((prev) => ({ ...prev, defaultDatePreset }));
    announce('Default dashboard period set to ' + defaultDatePreset.replace(/_/g, ' '));
  }, [announce]);

  const setAutoOpenPreview = useCallback((autoOpenPreview: boolean) => {
    setWorkflowDefaults((prev) => ({ ...prev, autoOpenPreview }));
    announce('Auto-open print preview ' + (autoOpenPreview ? 'enabled' : 'disabled'));
  }, [announce]);

  const resetToDefaults = useCallback(() => {
    setPreferences(DEFAULT_PREFERENCES);
    setWorkflowDefaults(DEFAULT_WORKFLOW_PREFERENCES);
    announce('Appearance and workflow settings reset to defaults');
  }, [announce]);

  return (
    <ThemeAccessibilityContext.Provider
      value={{
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
        syncFromServer,
        resetServerSync,
        announcement,
      }}
    >
      {children}
      {/* Polite live region for screen reader accessibility announcements */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          padding: 0,
          margin: '-1px',
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {announcement}
      </div>
    </ThemeAccessibilityContext.Provider>
  );
};

export function useOptionalThemeAccessibility(): ThemeAccessibilityContextType | undefined {
  return useContext(ThemeAccessibilityContext);
}

export function useThemeAccessibility(): ThemeAccessibilityContextType {
  const context = useContext(ThemeAccessibilityContext);
  if (!context) {
    throw new Error('useThemeAccessibility must be used within ThemeAccessibilityProvider');
  }
  return context;
}
