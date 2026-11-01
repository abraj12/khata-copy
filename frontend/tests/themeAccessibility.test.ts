import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  NEUMORPHIC_PRESETS,
  UIPreferences,
} from '../src/theme/neumorphicThemes.js';

describe('Theme & Accessibility Preferences (Flat Neumorphic & Enhanced Contrast as Default)', () => {
  it('1. DEFAULT_PREFERENCES specifies flat neumorphic & enhanced contrast as default', () => {
    expect(DEFAULT_PREFERENCES.contrastOverride).toBe('enhanced');
    expect(DEFAULT_PREFERENCES.preset).toBe('flat');
    expect(DEFAULT_PREFERENCES.textSize).toBe('100');
    expect(DEFAULT_PREFERENCES.strongFocus).toBe(true);
    expect(DEFAULT_PREFERENCES.version).toBe(3);
  });

  it('2. Presets include WCAG AA and high contrast options', () => {
    const ids = NEUMORPHIC_PRESETS.map((p) => p.id);
    expect(ids).toContain('soft-light');
    expect(ids).toContain('flat');
    expect(ids).toContain('high-contrast');
    expect(ids).toContain('soft-dark');
  });

  it('3. Migrates legacy version 1 & 2 defaults to flat neumorphic & enhanced contrast', () => {
    // Simulate migration logic from ThemeAccessibilityContext
    function migratePrefs(parsed: any): UIPreferences {
      let contrastOverride = DEFAULT_PREFERENCES.contrastOverride;
      if ((parsed.version === 2 || parsed.version === 3) && ['default', 'enhanced'].includes(parsed.contrastOverride)) {
        contrastOverride = parsed.contrastOverride;
      }
      let preset = DEFAULT_PREFERENCES.preset;
      if (parsed.version === 3 && parsed.preset) {
        preset = parsed.preset;
      } else if (parsed.preset && parsed.preset !== 'soft-light') {
        preset = parsed.preset;
      }
      return {
        version: 3,
        preset,
        textSize: parsed.textSize || DEFAULT_PREFERENCES.textSize,
        contrastOverride,
        reduceMotion: parsed.reduceMotion || DEFAULT_PREFERENCES.reduceMotion,
        increaseSpacing: Boolean(parsed.increaseSpacing),
        strongFocus: parsed.strongFocus ?? DEFAULT_PREFERENCES.strongFocus,
      };
    }

    const legacyV1 = {
      version: 1,
      preset: 'soft-light', // old v1 default
      textSize: '100',
      contrastOverride: 'default', // old v1 default
      reduceMotion: 'system',
      increaseSpacing: false,
      strongFocus: true,
    };

    const migrated = migratePrefs(legacyV1);
    expect(migrated.contrastOverride).toBe('enhanced');
    expect(migrated.preset).toBe('flat');
    expect(migrated.version).toBe(3);

    const explicitCustomPreset = {
      version: 2,
      preset: 'soft-dark',
      textSize: '100',
      contrastOverride: 'default', // user explicitly switched to standard in v2
      reduceMotion: 'system',
      increaseSpacing: false,
      strongFocus: true,
    };

    const preserved = migratePrefs(explicitCustomPreset);
    expect(preserved.contrastOverride).toBe('default');
    expect(preserved.preset).toBe('soft-dark');
    expect(preserved.version).toBe(3);
  });
});
