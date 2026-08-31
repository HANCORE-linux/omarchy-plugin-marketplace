import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseThemeSettings, DEFAULT_THEME_SETTINGS } from "../site/assets/js/shared.js";

const pages = [
  "site/index.html",
  "site/explore.html",
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
    assert.ok(
      html.includes('name="font"'),
      `${pagePath} missing font family radio inputs`
    );
    assert.ok(
      html.includes('name="base"'),
      `${pagePath} missing theme base radio inputs`
    );
    assert.ok(
      html.includes('value="blue"') && html.includes('value="pink"') && html.includes('value="red"'),
      `${pagePath} missing expanded accent color swatches`
    );
  }
});

test("parseThemeSettings returns default settings when raw data is invalid or missing", () => {
  assert.deepEqual(parseThemeSettings(null), DEFAULT_THEME_SETTINGS);
  assert.deepEqual(parseThemeSettings("invalid json"), DEFAULT_THEME_SETTINGS);
  assert.deepEqual(parseThemeSettings("{}"), DEFAULT_THEME_SETTINGS);
});

test("parseThemeSettings correctly parses valid settings JSON and theme base", () => {
  assert.deepEqual(
    parseThemeSettings(JSON.stringify({ mode: "light", accent: "pink", radius: "8", font: "sans", base: "slate" })),
    { mode: "light", accent: "pink", radius: "8", font: "sans", base: "slate" }
  );
  assert.deepEqual(
    parseThemeSettings(JSON.stringify({ mode: "dark", accent: "blue", radius: "4", font: "mono", base: "stone" })),
    { mode: "dark", accent: "blue", radius: "4", font: "mono", base: "stone" }
  );
  assert.deepEqual(
    parseThemeSettings(null, "light"),
    { mode: "light", accent: "orange", radius: "0", font: "mono", base: "neutral" }
  );
});
