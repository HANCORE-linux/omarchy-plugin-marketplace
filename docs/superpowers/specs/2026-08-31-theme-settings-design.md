# Design Spec: Minimal Omarchy-Styled Theme Settings Panel

**Date:** 2026-08-31
**Status:** Approved by User
**Target Release:** 0.1.0

---

## 1. Overview

This feature adds a customizable **Theme Settings Panel** accessible via a new **Paintbrush icon button** in the Omarchy Plugins header. Users can configure color mode (System, Dark, Light), accent colors, and corner radiuses while preserving the technical, minimal, and aesthetically restrained design language of Omarchy Plugins as defined in `AGENTS.md`.

---

## 2. Goals & Non-Goals

### Goals
- Replace the simple dark/light toggle in the top actions with a Paintbrush icon button that opens a Theme Settings Panel.
- Support options for:
  - **Color Mode:** System / Dark / Light
  - **Color Scheme / Accent:** Default Orange (`#ff5a36` / `#c6371c`), Cyan (`#00bcd4`), Emerald (`#10b981`), Purple (`#8b5cf6`), Yellow (`#f59e0b`)
  - **Corner Radius:** Square (`0px`), Slight (`4px`), Rounded (`8px`)
- Persist settings in `localStorage` across page loads.
- Ensure full keyboard accessibility, ARIA attributes, and light/dark theme compliance.
- Keep performance static and dependency-free (pure HTML, CSS, JavaScript).

### Non-Goals
- No backend storage, user accounts, or server API dependencies.
- No heavy frontend frameworks or external icon fonts.
- No complex theme generators or raw hex pickers that break the curated Omarchy aesthetic.

---

## 3. Component & Technical Architecture

### 3.1 Header Paintbrush Trigger
- **Files Affected:** `site/index.html`, `site/plugin.html`, `site/publish.html`, `site/develop.html`
- **Markup:**
  ```html
  <button class="square-action icon-only theme-toggle" type="button" aria-label="Theme settings" aria-haspopup="dialog" aria-expanded="false">
    <svg class="paintbrush-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <!-- Paintbrush path -->
      <path d="m14 14-8.5 8.5a2.12 2.12 0 0 1-3-3L11 11" />
      <path d="M15 9.5 14.5 10" />
      <path d="M18.37 3.63a3.5 3.5 0 0 1 4.5 4.5L16 15l-4-4 6.37-7.37z" />
    </svg>
  </button>
  ```

### 3.2 Theme Settings Drawer / Modal
- **Markup Structure:**
  - `<dialog id="theme-dialog" class="theme-dialog" aria-labelledby="theme-dialog-title">`
  - Header: Title `Theme Settings` and Close button `✕`.
  - Body:
    - **Color Mode:** Radio group (`system`, `dark`, `light`)
    - **Color Scheme:** Radio/button group of swatches (`orange`, `cyan`, `emerald`, `purple`, `yellow`)
    - **Corner Radius:** Radio group (`0px`, `4px`, `8px`)
  - Footer: `Reset defaults` and `Close / Save` buttons.

### 3.3 CSS Data Attributes & Custom Properties
- **Attributes applied to `<html>` (`document.documentElement`):**
  - `data-theme="dark|light"`
  - `data-accent="orange|cyan|emerald|purple|yellow"`
  - `data-radius="0|4|8"`
- **CSS Definitions (`site/assets/css/style.css`):**
  - Accent property overrides for `:root[data-accent="..."]`
  - `--panel-radius` dynamic usage on cards, panels, and square controls when non-zero radius is active.

### 3.4 JavaScript Logic (`site/assets/js/shared.js`)
- `setupThemeToggle()` expanded to handle:
  - Opening/closing the modal dialog.
  - Event listeners for color mode, accent swatch, and radius pickers.
  - Reading/saving settings to `localStorage` key `omarchy-theme-settings`.
  - Handling system preference changes via `window.matchMedia('(prefers-color-scheme: dark)')`.
  - Keyboard events (`Escape` to close, focus trapping inside dialog).

---

## 4. Accessibility & Responsive Rules

- `aria-expanded` and `aria-haspopup="dialog"` on the header paintbrush button.
- Focus trap inside `#theme-dialog` when open. Focus returned to paintbrush button on close.
- All swatches and controls operate cleanly via standard keyboard navigation (`Tab`, `Space`, `Enter`, Arrow keys for radio groups).
- Responsive check across 320px to 1440px viewports; dialog scales appropriately on mobile devices.

---

## 5. Verification Plan

1. Run unit/integration tests: `npm test`
2. Browser runtime verification:
   - Check dark & light mode rendering with different accent colors.
   - Verify persistence across page refresh and navigation between pages (`index.html`, `plugin.html`, `publish.html`).
   - Test keyboard navigation and screen reader attributes.
