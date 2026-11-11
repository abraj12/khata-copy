import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { fetchPreferencesApi, updatePreferencesApi } from '../lib/appDataApi.js';
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

interface ThemeAccessibilityContextType {
  preferences: UIPreferences;
  setPreset: (preset: NeuPresetId) => void;
  setTextSize: (size: TextSizeOption) => void;
  setContrastOverride: (contrast: ContrastOption) => void;
  setReduceMotion: (motion: MotionOption) => void;
  setIncreaseSpacing: (increase: boolean) => void;
  setStrongFocus: (focus: boolean) => void;
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

export const ThemeAccessibilityProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [preferences, setPreferences] = useState<UIPreferences>(loadSavedPreferences);
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
      if (res?.source === 'mongodb' && res.preferences?.theme) {
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
        skipNextServerSaveRef.current = true;
        setPreferences(nextPrefs);
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

    // Save non-sensitive preferences safely
    try {
      localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
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
      void updatePreferencesApi({ theme: preferences }).catch(() => {
        // Non-blocking best-effort sync
      });
    }, 350);
  }, [preferences]);

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
    announce(`Strong focus indicator ${strongFocus ? 'enabled' : 'disabled'}`);
  }, [announce]);

  const resetToDefaults = useCallback(() => {
    setPreferences(DEFAULT_PREFERENCES);
    announce('Appearance and accessibility settings reset to Soft Light defaults');
  }, [announce]);

  return (
    <ThemeAccessibilityContext.Provider
      value={{
        preferences,
        setPreset,
        setTextSize,
        setContrastOverride,
        setReduceMotion,
        setIncreaseSpacing,
        setStrongFocus,
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

export function useThemeAccessibility(): ThemeAccessibilityContextType {
  const context = useContext(ThemeAccessibilityContext);
  if (!context) {
    throw new Error('useThemeAccessibility must be used within ThemeAccessibilityProvider');
  }
  return context;
}
