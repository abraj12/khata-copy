# Khata - Design System & UI Architecture

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Primary Typography:** Montserrat (Locally Bundled)  
**Visual Style:** Tactile Neumorphism (9 Distinct Presets)  

---

## 1. Typography & Text Scaling Architecture

### 1.1 Local Montserrat Bundling
Khata bundles all font assets directly into the application build using `@fontsource/montserrat` (weights `400`, `500`, `600`, and `700`).
- **Zero External Dependencies:** No requests are made to `fonts.googleapis.com` or `fonts.gstatic.com`.
- **Offline & Mobile Ready:** When bundled as an Android APK via Capacitor, the application renders typography instantly without internet access.

### 1.2 Layout-Safe Text Scaling
To provide accessibility enlargement without breaking CSS grid containers, modal dialogues, or button paddings:
1. The root `html` font size is strictly pinned:
   ```css
   html {
     font-size: 16px !important;
   }
   ```
2. The CSS custom property `--khata-text-scale` is applied directly to typography utility classes in [frontend/src/index.css](file:///c:/Users/rajab/OneDrive/Desktop/khata/frontend/src/index.css):
   ```css
   .text-xs   { font-size: calc(0.75rem * var(--khata-text-scale, 1)) !important; }
   .text-sm   { font-size: calc(0.875rem * var(--khata-text-scale, 1)) !important; }
   .text-base { font-size: calc(1rem * var(--khata-text-scale, 1)) !important; }
   .text-lg   { font-size: calc(1.125rem * var(--khata-text-scale, 1)) !important; }
   .text-xl   { font-size: calc(1.25rem * var(--khata-text-scale, 1)) !important; }
   ```
3. Available scale factors: `100%` (1.0), `115%` (1.15), `130%` (1.30), `145%` (1.45).

---

## 2. Nine Tactile Neumorphic Presets

Khata features 9 selectable neumorphic color schemes managed by `ThemeContext` and persisted in `localStorage`:

| # | Preset Name | ID | Visual Characteristic | Surface Background |
|---|---|---|---|---|
| 1 | **Classic Light** | `classic-light` | Soft off-white with dual dual-tone drop shadows | `#e6ecf5` |
| 2 | **Modern Dark** | `modern-dark` | Slate charcoal with deep shadows and soft top highlights | `#1e2430` |
| 3 | **Warm Clay** | `warm-clay` | Terracotta / warm sandstone earthy aesthetic | `#f4ede4` |
| 4 | **Soft Teal** | `soft-teal` | Calming clinical teal / seafoam tones | `#e2f0ed` |
| 5 | **Elegant Violet** | `elegant-violet` | Gentle lavender and slate purple surface | `#eeeaf5` |
| 6 | **Neumorphic Concave** | `neu-concave` | Sunken recessed depth | `linear-gradient(145deg, #cfd8e5, #f5ffff)` |
| 7 | **Neumorphic Convex** | `neu-convex` | Pillowed extruded tactile depth | `linear-gradient(145deg, #f5ffff, #cfd8e5)` |
| 8 | **High Contrast Light** | `high-contrast-light` | WCAG AAA compliant pure black text on stark white | `#ffffff` |
| 9 | **High Contrast Dark** | `high-contrast-dark` | WCAG AAA compliant bright amber & white on deep black | `#0a0c10` |

### Surface Rendering Rule
To ensure that linear gradient surfaces (#6 and #7) display correctly alongside solid colors (#1–#5, #8–#9), UI cards apply the shorthand property:
```css
.neu-card {
  background: var(--khata-surface-raised);
  box-shadow: var(--khata-shadow-raised);
  border-radius: var(--khata-radius);
}
```

---

## 3. Persistent Accessibility Controls

The global **Appearance & Accessibility Bar** (located in the header/drawer) provides instant customization controls:
- **Preset Selector:** Rapid switcher across all 9 visual themes.
- **High Contrast Mode:** Instant toggle between standard neumorphism and high-contrast WCAG AAA mode.
- **Text Scale Controls:** 4 discrete text zoom levels (`100%`, `115%`, `130%`, `145%`).
- **Reduced Motion Toggle:** Disables smooth transitions and animations for users sensitive to motion.
- **State Persistence:** All preferences are saved immediately to `localStorage` under:
  - `khata_theme`
  - `khata_contrast`
  - `khata_text_scale`
  - `khata_reduced_motion`

---

## 4. Responsive Breakpoints & Touch Guidelines

| Screen Width | Target Device | Layout Strategy |
|---|---|---|
| **320px - 430px** | Mobile phones (iPhone SE, Pixel, Galaxy) | Header wraps cleanly into a 2-row layout. Product line inputs stack vertically (`col-span-12`). All buttons enforce minimum touch targets $\ge 44\text{px} \times 44\text{px}$. Zero horizontal scrolling. |
| **640px - 768px** | Tablets & Foldables | 2-column grid arrangements for customer cards and product entries. Modal dialogs fill 90% screen width. |
| **1024px - 1440px+** | Desktop & POS Terminals | Split-view workspace: Customer list on left pane, detailed transaction history on right pane with print view. |
