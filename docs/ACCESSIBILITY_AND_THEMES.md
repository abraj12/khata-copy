# Khata — Accessibility, Themes & Design System Specification

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Typography:** Montserrat (bundled locally via `@fontsource/montserrat`)  
**Design Philosophy:** Soft Neumorphism with accessible WCAG 2.1 AA contrast  

---

## 1. Neumorphic Presets (9 Themes)

Khata ships with 9 carefully tuned tactile themes defined in `frontend/src/theme/themes.ts` and controlled via CSS variables:

| Preset Name | Target Vibe | Surface Background | Shadow / Accent |
| :--- | :--- | :--- | :--- |
| **Default (Neumorphic Slate)** | Professional shopkeeper neutral | `#e6ecf5` | Dual concave/convex soft shadows |
| **Clay** | Warm organic clay pottery | `#e8e0d5` | Earthy dual bevel |
| **Soft Dark** | Modern low-glare evening ledger | `#1e2430` | Inset dark deboss |
| **Slate** | Cool industrial hardware store | `#e2e8f0` | Precision edge shadows |
| **Emerald Tactile** | Crisp banking green tone | `#e6f4ea` | Forest emerald indicators |
| **Midnight Neon** | High contrast dark mode | `#0f172a` | Vivid cyan/blue highlights |
| **Sand Warmth** | Warm desert sandstone | `#f5efe6` | Amber/gold accents |
| **Copper Forge** | Industrial metallic warmth | `#eee5e0` | Burnt copper elevation |
| **Lavender Mist** | Calming retail soft tint | `#ede9fe` | Soft violet dual glow |

All 9 presets are verified across:
- Login page
- Product catalog & modals
- New Udhar transaction modal
- Customer ledger table & search pickers
- Historical Udhar & Payment expansion rows

---

## 2. Local Typography Bundling (Montserrat)

- **Font Family:** Montserrat (`weights: 400, 500, 600, 700`)
- **Distribution:** Self-hosted inside `frontend/src/index.css` via `@fontsource/montserrat`.
- **Zero External CDNs:** No requests to Google Fonts (`fonts.googleapis.com` or `fonts.gstatic.com`). Works 100% offline in PWA and native Android Capacitor APK.
- **Woff / Woff2 formats:** Packaged directly into Android native assets (`android/app/src/main/assets/public/assets/`).

---

## 3. Accessibility & Usability Hardening

### 3.1 Text Scaling (Dynamic Scaling)
The interface supports 4 user-selectable text scaling levels via `frontend/src/context/AppearanceContext.tsx`:
- `100%` (Default base font)
- `115%` (Comfortable readability)
- `130%` (Large text for older users)
- `145%` (Maximum magnification without layout breakage)

Flexbox wrap and auto-fitting grids prevent horizontal overflow and clipping across all viewports (`320px` to `1440px+`).

### 3.2 Focus Visibility & Touch Targets
- All interactive controls (buttons, inputs, searchable pickers) feature an explicit, high-contrast focus outline (`focus-visible:ring-2 focus-visible:ring-[var(--khata-accent)]`).
- Mobile touch targets adhere to WCAG 2.1 Level AA minimum height of **44px** (`min-h-[44px]`).
- Screen reader announcements (`aria-live="polite"`, `role="combobox"`, `aria-expanded`, `aria-haspopup`) are integrated on all combobox pickers and search bars.

### 3.3 Modal Scroll & Mobile Keyboards
- Modals (`NewUdharModal`, `CustomerDetailModal`, `ProductModal`, `AppearanceModal`) enforce independent `overflow-y-auto` internal scrolling with fixed header and sticky action footers.
- Close buttons and action buttons remain reachable when the Android virtual software keyboard is displayed.

---

## 4. Brand & Footer Policy

- **Authoritative Footer Text:**
  ```text
  Designed and managed by Algions AI Labs Pvt. Ltd.
  ```
- **Prohibited Footer Text:** `"Single-Shopkeeper Ledger Book"` must NEVER appear in the footer.
- **Modal Policy:** The footer is strictly excluded from modal dialogs to maximize usable vertical workspace on mobile viewports.
