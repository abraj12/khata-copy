# Khata — Accessibility, Themes & Design System Specification

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Typography:** Montserrat (bundled locally via `@fontsource/montserrat`)  
**Design Philosophy:** Soft Neumorphism with accessible contrast  

---

## 1. Supported Neumorphic Appearance Presets (9 Presets)

Khata ships with 9 tactile themes defined in `frontend/src/theme/neumorphicThemes.ts` and managed via CSS custom properties:

| Preset ID | Name | Theme Type | Description |
|---|---|---|---|
| `soft-light` | **Soft Light** | Light | Default calm neutral with subtle balanced bilateral shadows. |
| `soft-dark` | **Soft Dark** | Dark | Graphite background with soft illuminated edges and high legibility. |
| `raised` | **Raised / Extruded** | Light | Prominent tactile elevation and pronounced card surfaces. |
| `pressed` | **Pressed / Inset** | Light | Recessed paneling with distinct inner contours. |
| `concave` | **Concave Surfaces** | Light / Gradient | Curving inward gradient surfaces using CSS `background` rendering. |
| `convex` | **Convex Surfaces** | Light / Gradient | Curving outward gradient surfaces using CSS `background` rendering. |
| `flat` | **Clean Flat / Minimal** | Light | Minimal elevation with crisp border contrast. |
| `high-contrast`| **High-Contrast Accessible**| Dark | Deep black background with stark white/amber borders and high contrast. |
| `accent` | **Vivid Accent Forward** | Light | Highlighted card borders and vibrant brand accent coloring. |

---

## 2. Gradient Surface CSS Token Rendering Fix

The Concave and Convex appearance presets generate gradient-based surface tokens (e.g. `linear-gradient(...)`). In standard CSS, declaring `backgroundColor: 'var(--khata-surface-raised)'` is invalid for gradients and is silently ignored by browser render engines.

All card and modal surfaces in the application use:
```css
background: var(--khata-surface-raised);
```
This guarantees that concave and convex gradient tokens render cleanly across all modern mobile and desktop browsers.

---

## 3. Modal and Keyboard Accessibility

1. **Focus Trapping:** When modals (`AppearanceAccessibilityModal`, `SearchablePicker`) are opened, pressing `Tab` or `Shift+Tab` wraps focus exclusively within the modal's focusable elements.
2. **Escape Key Dismissal:** Pressing `Escape` closes active dialogs immediately.
3. **Focus Restoration:** Upon closing a modal, focus is automatically returned to the originating trigger element.
4. **Combobox ARIA Support:** Combobox search inputs feature `role="combobox"`, `aria-expanded`, `aria-haspopup="listbox"`, `aria-controls`, and `aria-selected` attributes.
5. **Touch Targets:** All interactive buttons and combobox triggers enforce minimum 44px touch heights (`min-h-[44px]`).
