import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
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
  announcement: string;
}

const ThemeAccessibilityContext = createContext<ThemeAccessibilityContextType | undefined>(undefined);

function loadSavedPreferences(): UIPreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1) {
      // Validate preset is among valid presets
      const isValidPreset = NEUMORPHIC_PRESETS.some((p) => p.id === parsed.preset);
      return {
        version: 1,
        preset: isValidPreset ? parsed.preset : DEFAULT_PREFERENCES.preset,
        textSize: ['100', '115', '130', '145'].includes(parsed.textSize)
          ? parsed.textSize
          : DEFAULT_PREFERENCES.textSize,
        contrastOverride: ['default', 'enhanced'].includes(parsed.contrastOverride)
          ? parsed.contrastOverride
          : DEFAULT_PREFERENCES.contrastOverride,
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
    announce(`Contrast set to ${contrastOverride === 'enhanced' ? 'Enhanced' : 'Default'}`);
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
