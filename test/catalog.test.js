import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isRecentlyAdded } from "../site/assets/js/shared.js";

const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));

test("catalog IDs are unique", () => {
  const ids = catalog.plugins.map((plugin) => plugin.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("catalog has no manual featured ranking", () => {
  assert.equal(catalog.plugins.some((plugin) => Object.hasOwn(plugin, "featured")), false);
});

test("installable plugins have commands and HTTPS repositories", () => {
  for (const plugin of catalog.plugins) {
    assert.match(plugin.repo, /^https:\/\/github\.com\//);
    if (!plugin.placeholder) {
      assert.ok(plugin.installCommand);
      assert.match(plugin.addedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test("recently added badges use a 3-day listing window", () => {
  const now = Date.parse("2026-07-28T00:00:00Z");
  assert.equal(isRecentlyAdded({ addedAt: "2026-07-28" }, now), true);
  assert.equal(isRecentlyAdded({ addedAt: "2026-07-26" }, now), true);
  assert.equal(isRecentlyAdded({ addedAt: "2026-07-25" }, now), false);
  assert.equal(isRecentlyAdded({ addedAt: "2026-07-28", placeholder: true }, now), false);
});

test("SHIBUMI remains a non-installable placeholder", () => {
  const shibumi = catalog.plugins.find((plugin) => plugin.id === "hancore.shibumi");
  assert.equal(shibumi?.placeholder, true);
  assert.equal(shibumi?.installCommand, "");
});
