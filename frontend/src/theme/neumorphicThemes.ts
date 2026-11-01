export type NeuPresetId =
  | 'soft-light'
  | 'soft-dark'
  | 'raised'
  | 'pressed'
  | 'concave'
  | 'convex'
  | 'flat'
  | 'high-contrast'
  | 'accent';

export interface NeuPresetMeta {
  id: NeuPresetId;
  name: string;
  shortDesc: string;
  previewBg: string;
  previewSurface: string;
  previewAccent: string;
  previewText: string;
  isDark?: boolean;
}

export const NEUMORPHIC_PRESETS: NeuPresetMeta[] = [
  {
    id: 'soft-light',
    name: 'Soft Light',
    shortDesc: 'Default calm light background with subtle balanced bilateral shadows.',
    previewBg: '#eef2f6',
    previewSurface: '#eef2f6',
    previewAccent: '#315fce',
    previewText: '#1e293b',
  },
  {
    id: 'soft-dark',
    name: 'Soft Dark',
    shortDesc: 'Graphite background with soft illuminated edges and high legibility.',
    previewBg: '#1e232d',
    previewSurface: '#242a36',
    previewAccent: '#5b8bf5',
    previewText: '#f1f5f9',
    isDark: true,
  },
  {
    id: 'raised',
    name: 'Raised / Extruded',
    shortDesc: 'More prominent tactile elevation and pronounced card surfaces.',
    previewBg: '#e9edf2',
    previewSurface: '#f1f5fa',
    previewAccent: '#2b58c7',
    previewText: '#0f172a',
  },
  {
    id: 'pressed',
    name: 'Pressed / Inset',
    shortDesc: 'Recessed paneling with distinct inner contours and crisp control boundaries.',
    previewBg: '#e8edf3',
    previewSurface: '#dfe5ee',
    previewAccent: '#3b6dd8',
    previewText: '#1e293b',
  },
  {
    id: 'concave',
    name: 'Concave',
    shortDesc: 'Graceful curved gradient lighting on container panels for depth.',
    previewBg: '#eef2f7',
    previewSurface: 'linear-gradient(135deg, #e3e8ee, #f9fbff)',
    previewAccent: '#3262d1',
    previewText: '#1e293b',
  },
  {
    id: 'convex',
    name: 'Convex',
    shortDesc: 'Subtle outward surface beveling on action cards and buttons.',
    previewBg: '#edf1f6',
    previewSurface: 'linear-gradient(135deg, #f6f9fc, #e1e7ee)',
    previewAccent: '#2d5cc7',
    previewText: '#1e293b',
  },
  {
    id: 'flat',
    name: 'Flat Neumorphic',
    shortDesc: 'Minimal shadows with crisp tonal separation for clean simplicity.',
    previewBg: '#f3f5f8',
    previewSurface: '#ffffff',
    previewAccent: '#3b66cf',
    previewText: '#1e293b',
  },
  {
    id: 'high-contrast',
    name: 'High-Contrast',
    shortDesc: 'Maximum legibility with deep borders and WCAG AA contrast compliance.',
    previewBg: '#f8fafc',
    previewSurface: '#ffffff',
    previewAccent: '#1d4ed8',
    previewText: '#020617',
  },
  {
    id: 'accent',
    name: 'Accent / Tinted',
    shortDesc: 'Soft cool blue tinted foundation with cohesive active state accents.',
    previewBg: '#e9f0f8',
    previewSurface: '#eef4fa',
    previewAccent: '#1e54c7',
    previewText: '#0f1f3d',
  },
];

export type TextSizeOption = '100' | '115' | '130' | '145';
export type ContrastOption = 'default' | 'enhanced';
export type MotionOption = 'system' | 'on' | 'off';

export interface UIPreferences {
  version: 1 | 2 | 3;
  preset: NeuPresetId;
  textSize: TextSizeOption;
  contrastOverride: ContrastOption;
  reduceMotion: MotionOption;
  increaseSpacing: boolean;
  strongFocus: boolean;
}

export const DEFAULT_PREFERENCES: UIPreferences = {
  version: 3,
  preset: 'flat',
  textSize: '100',
  contrastOverride: 'enhanced',
  reduceMotion: 'system',
  increaseSpacing: false,
  strongFocus: true,
};

export const PREFERENCES_STORAGE_KEY = 'khata_ui_preferences_v1';
