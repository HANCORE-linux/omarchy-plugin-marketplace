import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyReleaseState } from "../scripts/build-catalog.mjs";
import { isRecentlyAdded, isRecentlyUpdated, listingTime } from "../site/assets/js/shared.js";

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
    if (!plugin.placeholder && !plugin.builtIn) {
      assert.ok(plugin.installCommand);
      assert.match(plugin.addedAt, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(plugin.listedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  }
});

test("built-in plugins are separated from installable community plugins", () => {
  const builtIns = catalog.plugins.filter((plugin) => plugin.builtIn);
  assert.ok(builtIns.length > 20);
  for (const plugin of builtIns) {
    assert.equal(plugin.sourceType, "builtin");
    assert.equal(plugin.installCommand, "");
    assert.match(plugin.officialCommand, /^omarchy (?:bar plugin add|plugin enable) omarchy\./);
    assert.ok(["Add to bar", "Enable plugin"].includes(plugin.officialCommandLabel));
    assert.equal(plugin.addedAt, undefined);
    assert.match(plugin.id, /^omarchy\./);
    assert.match(plugin.sourceUrl, /^https:\/\/github\.com\/basecamp\/omarchy\/tree\/quattro\//);
  }
});

test("stars represent repository stars and are shared by plugins from the same repository", () => {
  const community = catalog.plugins.filter((plugin) => plugin.sourceType === "community" && !plugin.placeholder);
  const repositories = new Map();
  for (const plugin of community) {
    repositories.set(plugin.repo, [...(repositories.get(plugin.repo) || []), plugin]);
  }
  for (const plugins of repositories.values()) {
    assert.equal(new Set(plugins.map((plugin) => plugin.stars)).size, 1);
    assert.ok(Number.isInteger(plugins[0].stars));
    assert.ok(plugins[0].stars >= 0);
  }
});

test("community install commands match the current Omarchy Quattro CLI", () => {
  const overview = catalog.plugins.find((plugin) => plugin.id === "omarchy-overview");
  assert.equal(
    overview?.installCommand,
    "omarchy plugin add https://github.com/AyushKr2003/omarchy-overview.git --enable",
  );

  for (const id of ["omni", "quickapps-hud", "cliamp", "taildrop"]) {
    const plugin = catalog.plugins.find((entry) => entry.id === id);
    assert.doesNotMatch(plugin?.installCommand || "", /omarchy plugin source|--from/);
    assert.doesNotMatch(plugin?.installCommand || "", /rm -rf/);
    assert.match(plugin?.installCommand || "", /git clone https:\/\/github\.com\/bjarneo\/omarchy-shell-plugins\.git/);
    assert.match(plugin?.installCommand || "", /test ! -e/);
    assert.match(plugin?.installCommand || "", new RegExp(`plugins/${id}`));
    assert.match(plugin?.installCommand || "", new RegExp(`omarchy plugin validate.*plugins/${id}`));
    if (id === "taildrop") {
      assert.match(plugin?.installCommand || "", /omarchy bar plugin add taildrop --section right/);
    } else {
      assert.match(plugin?.installCommand || "", new RegExp(`omarchy plugin enable ${id}`));
    }
  }
});

test("recently added badges use a 3-day listing window", () => {
  const now = Date.parse("2026-07-28T00:00:00Z");
  assert.equal(isRecentlyAdded({ addedAt: "2026-07-28" }, now), true);
  assert.equal(isRecentlyAdded({ addedAt: "2026-07-26" }, now), true);
  assert.equal(isRecentlyAdded({ addedAt: "2026-07-25" }, now), false);
  assert.equal(isRecentlyAdded({ addedAt: "2026-07-28", placeholder: true }, now), false);
  assert.equal(isRecentlyAdded({ addedAt: "2026-07-28", builtIn: true }, now), false);
});

test("recently added ordering uses the exact listing time", () => {
  const plugins = [
    { name: "Alpha", addedAt: "2026-07-28", listedAt: "2026-07-28T08:00:00.000Z" },
    { name: "Zulu", addedAt: "2026-07-28", listedAt: "2026-07-28T11:00:00.000Z" },
  ];
  plugins.sort((left, right) => listingTime(right) - listingTime(left));
  assert.deepEqual(plugins.map((plugin) => plugin.name), ["Zulu", "Alpha"]);
});

test("release changes create a three-day updated state without replacing new listings", () => {
  const detectedAt = "2026-07-28T12:00:00.000Z";
  const plugins = [
    { id: "new-plugin", releaseTag: "v1.0.0" },
    { id: "updated-plugin", releaseTag: "v2.0.0" },
    { id: "unchanged-plugin", releaseTag: "v1.0.0" },
  ];
  const previous = [
    { id: "updated-plugin", releaseTag: "v1.0.0" },
    {
      id: "unchanged-plugin",
      releaseTag: "v1.0.0",
      releaseUpdatedAt: "2026-07-27T09:00:00.000Z",
    },
  ];

  const result = applyReleaseState(plugins, previous, detectedAt);
  assert.equal(result.find((plugin) => plugin.id === "new-plugin").releaseUpdatedAt, undefined);
  assert.equal(result.find((plugin) => plugin.id === "updated-plugin").releaseUpdatedAt, detectedAt);
  assert.equal(
    result.find((plugin) => plugin.id === "unchanged-plugin").releaseUpdatedAt,
    "2026-07-27T09:00:00.000Z",
  );
  assert.equal(
    isRecentlyUpdated(
      result.find((plugin) => plugin.id === "updated-plugin"),
      Date.parse("2026-07-30T11:59:59.000Z"),
    ),
    true,
  );
  assert.equal(
    isRecentlyUpdated(
      result.find((plugin) => plugin.id === "updated-plugin"),
      Date.parse("2026-07-31T12:00:00.000Z"),
    ),
    false,
  );
});

test("SHIBUMI remains a non-installable placeholder", () => {
  const shibumi = catalog.plugins.find((plugin) => plugin.id === "hancore.shibumi");
  assert.equal(shibumi?.placeholder, true);
  assert.equal(shibumi?.installCommand, "");
});
