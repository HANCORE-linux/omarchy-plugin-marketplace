import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));

test("catalog IDs are unique", () => {
  const ids = catalog.plugins.map((plugin) => plugin.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("installable plugins have commands and HTTPS repositories", () => {
  for (const plugin of catalog.plugins) {
    assert.match(plugin.repo, /^https:\/\/github\.com\//);
    if (!plugin.placeholder) assert.ok(plugin.installCommand);
  }
});

test("SHIBUMI remains a non-installable placeholder", () => {
  const shibumi = catalog.plugins.find((plugin) => plugin.id === "hancore.shibumi");
  assert.equal(shibumi?.placeholder, true);
  assert.equal(shibumi?.installCommand, "");
});
