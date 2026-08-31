# Theme Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a customizable Theme Settings Panel accessible via a Paintbrush header button, supporting color modes, accent colors, and corner radiuses while preserving Omarchy Plugins' minimal, technical design language.

**Architecture:** Update HTML pages (`index.html`, `plugin.html`, `publish.html`, `develop.html`) with paintbrush button triggers and the theme settings dialog overlay. Expand CSS variables in `site/assets/css/style.css` to handle dataset attributes (`data-theme`, `data-accent`, `data-radius`). Enhance `site/assets/js/shared.js` to manage dialog interactions, system preferences, and `localStorage` persistence.

**Tech Stack:** Plain HTML, CSS Custom Properties, Vanilla JavaScript (ES Modules), Node.js Test Runner (`node:test`).

## Global Constraints

- Preserve minimal, precise, technical, and aesthetically restrained design language.
- Monospace typography for headers, labels, and technical options.
- No external frontend frameworks, backend dependencies, or heavy icon libraries.
- Static, accessible HTML/CSS/JS with `aria-haspopup="dialog"`, keyboard focus management, and `prefers-reduced-motion` compliance.
- Cache busting query string `?v=20260831-01` updated across HTML and CSS/JS asset references.

---

### Task 1: Add Paintbrush Header Button & Theme Settings Dialog Markup

**Files:**
- Modify: `site/index.html`
- Modify: `site/plugin.html`
- Modify: `site/publish.html`
- Modify: `site/develop.html`
- Create: `test/theme-settings.test.js`

**Interfaces:**
- Consumes: Header top-actions bar.
- Produces: `#theme-dialog` HTML structure and paintbrush SVG button across all pages.

- [ ] **Step 1: Write failing node test for Theme Settings HTML structure**

Create `test/theme-settings.test.js`:
```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const pages = [
  "site/index.html",
  "site/plugin.html",
  "site/publish.html",
  "site/develop.html"
];

test("all HTML pages contain the paintbrush theme trigger button and theme dialog", () => {
  for (const pagePath of pages) {
    const html = readFileSync(pagePath, "utf-8");
    assert.ok(
      html.includes('aria-label="Theme settings"') || html.includes('aria-label="Toggle theme settings"'),
      `${pagePath} missing paintbrush trigger aria-label`
    );
    assert.ok(
      html.includes('id="theme-dialog"'),
      `${pagePath} missing #theme-dialog modal element`
    );
    assert.ok(
      html.includes('paintbrush-icon'),
      `${pagePath} missing paintbrush icon SVG`
    );
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/theme-settings.test.js`
Expected: FAIL with missing paintbrush trigger / `#theme-dialog` assertions.

- [ ] **Step 3: Add Paintbrush SVG Trigger and #theme-dialog Markup to HTML pages**

In `site/index.html`, `site/plugin.html`, `site/publish.html`, and `site/develop.html`:
1. Replace `.theme-toggle` button content with Paintbrush SVG:
```html
<button class="square-action icon-only theme-toggle" type="button" aria-label="Theme settings" aria-haspopup="dialog" aria-expanded="false">
  <svg class="paintbrush-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m14 14-8.5 8.5a2.12 2.12 0 0 1-3-3L11 11" />
    <path d="M15 9.5 14.5 10" />
    <path d="M18.37 3.63a3.5 3.5 0 0 1 4.5 4.5L16 15l-4-4 6.37-7.37z" />
  </svg>
</button>
```

2. Add `<dialog id="theme-dialog">` before `</body>`:
```html
<dialog id="theme-dialog" class="theme-dialog" aria-labelledby="theme-dialog-title">
  <div class="theme-dialog-content">
    <div class="theme-dialog-header">
      <h2 id="theme-dialog-title">Theme Settings</h2>
      <button type="button" class="theme-dialog-close" aria-label="Close theme settings">&times;</button>
    </div>
    <form class="theme-dialog-body" method="dialog">
      <fieldset class="theme-group">
        <legend>Color Mode</legend>
        <div class="theme-options">
          <label><input type="radio" name="mode" value="system" checked> System</label>
          <label><input type="radio" name="mode" value="dark"> Dark</label>
          <label><input type="radio" name="mode" value="light"> Light</label>
        </div>
      </fieldset>
      <fieldset class="theme-group">
        <legend>Accent Color</legend>
        <div class="theme-swatches">
          <label class="swatch swatch-orange"><input type="radio" name="accent" value="orange" checked><span class="swatch-color"></span>Orange</label>
          <label class="swatch swatch-cyan"><input type="radio" name="accent" value="cyan"><span class="swatch-color"></span>Cyan</label>
          <label class="swatch swatch-emerald"><input type="radio" name="accent" value="emerald"><span class="swatch-color"></span>Emerald</label>
          <label class="swatch swatch-purple"><input type="radio" name="accent" value="purple"><span class="swatch-color"></span>Purple</label>
          <label class="swatch swatch-yellow"><input type="radio" name="accent" value="yellow"><span class="swatch-color"></span>Yellow</label>
        </div>
      </fieldset>
      <fieldset class="theme-group">
        <legend>Corner Radius</legend>
        <div class="theme-options">
          <label><input type="radio" name="radius" value="0" checked> Square (0px)</label>
          <label><input type="radio" name="radius" value="4"> Slight (4px)</label>
          <label><input type="radio" name="radius" value="8"> Rounded (8px)</label>
        </div>
      </fieldset>
      <div class="theme-dialog-footer">
        <button type="button" class="square-action theme-reset-btn">Reset Defaults</button>
        <button type="submit" class="square-action theme-save-btn">Done</button>
      </div>
    </form>
  </div>
</dialog>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/theme-settings.test.js`
Expected: PASS.

---

### Task 2: Add CSS Styles for Paintbrush Button, Theme Dialog, and Accent / Radius Custom Properties

**Files:**
- Modify: `site/assets/css/style.css`
- Modify: `site/index.html` (bump CSS version `?v=20260831-01`)
- Modify: `site/plugin.html` (bump CSS version `?v=20260831-01`)
- Modify: `site/publish.html` (bump CSS version `?v=20260831-01`)
- Modify: `site/develop.html` (bump CSS version `?v=20260831-01`)

**Interfaces:**
- Consumes: `:root` CSS variables and dataset attributes on `<html>`.
- Produces: Overlay dialog styling, accent swatches, corner radiuses.

- [ ] **Step 1: Add CSS Rules in `site/assets/css/style.css`**

Append stylesheet rules for:
1. Paintbrush icon:
```css
.paintbrush-icon { width: 15px; height: 15px; }
```
2. Accent color datasets:
```css
:root[data-accent="orange"] { --accent: #ff5a36; --accent-contrast: #111; }
:root[data-accent="cyan"] { --accent: #00bcd4; --accent-contrast: #111; }
:root[data-accent="emerald"] { --accent: #10b981; --accent-contrast: #111; }
:root[data-accent="purple"] { --accent: #8b5cf6; --accent-contrast: #fff; }
:root[data-accent="yellow"] { --accent: #f59e0b; --accent-contrast: #111; }

:root[data-theme="light"][data-accent="orange"] { --accent: #c6371c; --accent-contrast: #fff; }
:root[data-theme="light"][data-accent="cyan"] { --accent: #008ba3; --accent-contrast: #fff; }
:root[data-theme="light"][data-accent="emerald"] { --accent: #047857; --accent-contrast: #fff; }
:root[data-theme="light"][data-accent="purple"] { --accent: #6d28d9; --accent-contrast: #fff; }
:root[data-theme="light"][data-accent="yellow"] { --accent: #b45309; --accent-contrast: #fff; }
```
3. Corner radius datasets:
```css
:root[data-radius="0"] { --panel-radius: 0px; }
:root[data-radius="4"] { --panel-radius: 4px; }
:root[data-radius="8"] { --panel-radius: 8px; }

.square-action, .card, .plugin-card, .theme-dialog-content {
  border-radius: var(--panel-radius, 0px);
}
```
4. `#theme-dialog` styles matching Omarchy design:
```css
.theme-dialog {
  padding: 0; border: 1px solid var(--line-strong); background: transparent;
  color: var(--text); font-family: var(--mono); max-width: 440px; width: calc(100% - 32px);
  border-radius: var(--panel-radius, 0px);
}
.theme-dialog::backdrop { background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(2px); }
.theme-dialog-content { background: var(--panel); padding: 20px; border-radius: inherit; }
.theme-dialog-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--line-soft); padding-bottom: 12px; margin-bottom: 16px; }
.theme-dialog-header h2 { margin: 0; font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); }
.theme-dialog-close { background: none; border: none; color: var(--muted); font-size: 20px; cursor: pointer; padding: 0 4px; }
.theme-dialog-close:hover { color: var(--text); }
.theme-group { border: 1px solid var(--line-soft); padding: 12px 14px; margin-bottom: 14px; border-radius: var(--panel-radius, 0px); }
.theme-group legend { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--muted); padding: 0 4px; }
.theme-options, .theme-swatches { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; font-size: 12px; }
.swatch { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.swatch-color { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.swatch-orange .swatch-color { background: #ff5a36; }
.swatch-cyan .swatch-color { background: #00bcd4; }
.swatch-emerald .swatch-color { background: #10b981; }
.swatch-purple .swatch-color { background: #8b5cf6; }
.swatch-yellow .swatch-color { background: #f59e0b; }
.theme-dialog-footer { display: flex; justify-content: space-between; margin-top: 18px; pt: 12px; border-top: 1px solid var(--line-soft); }
```

- [ ] **Step 2: Update Cache Busting Query Parameters**

Bump `?v=` parameter across `site/*.html` for `style.css` to `?v=20260831-01`.

---

### Task 3: Implement Theme Settings JS Logic & Persistence

**Files:**
- Modify: `site/assets/js/shared.js`
- Modify: `test/theme-settings.test.js`

**Interfaces:**
- Consumes: `#theme-dialog` DOM elements and `localStorage`.
- Produces: `setupThemeToggle()` handling dialog modal, dataset attributes, and state persistence.

- [ ] **Step 1: Add Node Tests for Theme State Parsing & Defaults**

In `test/theme-settings.test.js`, add test cases for theme setting helpers:
```javascript
test("default theme settings fall back to system mode, orange accent, 0px radius", () => {
  const defaults = { mode: "system", accent: "orange", radius: "0" };
  assert.equal(defaults.mode, "system");
  assert.equal(defaults.accent, "orange");
  assert.equal(defaults.radius, "0");
});
```

- [ ] **Step 2: Implement `setupThemeToggle()` in `site/assets/js/shared.js`**

Update `setupThemeToggle()` in `site/assets/js/shared.js`:
- Query `.theme-toggle` button and `#theme-dialog`.
- Load saved settings from `localStorage.getItem("omarchy-theme-settings")` or fallback to legacy `"omarchy-theme"` or defaults `{ mode: "system", accent: "orange", radius: "0" }`.
- Helper `applySettings(settings)`:
  - Determine active color theme (`dark` vs `light`) based on `mode`:
    - `dark`: `data-theme="dark"`
    - `light`: `data-theme="light"`
    - `system`: check `window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`
  - Set `document.documentElement.dataset.theme = theme`
  - Set `document.documentElement.dataset.accent = settings.accent`
  - Set `document.documentElement.dataset.radius = settings.radius`
  - Sync meta `theme-color`.
- Handle dialog opening: `dialog.showModal()`, set `aria-expanded="true"`.
- Handle dialog closing: `dialog.close()`, set `aria-expanded="false"`, restore focus to trigger button.
- Support `Reset Defaults` action.
- Listen for changes to `window.matchMedia('(prefers-color-scheme: dark)')`.

- [ ] **Step 3: Run Unit Tests**

Run: `npm test`
Expected: All tests pass cleanly.

---

### Task 4: Verification & Final Checks

**Files:**
- Workspace files

- [ ] **Step 1: Run Full Test Suite**

Run: `npm test`
Expected: All unit tests pass.

- [ ] **Step 2: Run Whitespace Checks**

Run: `git diff --check`
Expected: No trailing whitespace or formatting errors.

- [ ] **Step 3: Manual Runtime Review on Local Dev Server**

Verify at `http://127.0.0.1:4173`:
- Click paintbrush button -> opens modal dialog cleanly.
- Change options (Mode, Accent, Radius) -> live update on page.
- Reload page -> settings persist.
