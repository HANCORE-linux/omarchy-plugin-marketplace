import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyVersionState,
  CatalogCheckError,
  failedSourcePlugins,
  snapshotHttpErrorCode,
  successfulState,
  upstreamCheckErrorCodes,
  validateBeforeStagingPreview,
} from "../scripts/build-catalog.mjs";
import {
  isRecentlyAdded,
  isRecentlyUpdated,
  listingTime,
  pluginVersionLabel,
} from "../site/assets/js/shared.js";

const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));
const shaPattern = /^[a-f0-9]{40}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertCommunityPluginState(plugin) {
  assert.match(plugin.repo, /^https:\/\/github\.com\//);
  assert.match(plugin.addedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(plugin.listedAt, timestampPattern);
  assert.match(plugin.listingValidatedCommit, shaPattern);
  assert.match(plugin.listingValidatedAt, timestampPattern);
  assert.match(plugin.upstreamObservedCommit, shaPattern);
  assert.match(plugin.upstreamValidatedCommit, shaPattern);
  assert.match(plugin.upstreamCheckedAt, timestampPattern);
  assert.match(plugin.upstreamValidatedAt, timestampPattern);
  assert.ok(["passed", "failed", "unreachable"].includes(plugin.upstreamCheckStatus));

  if (plugin.upstreamCheckStatus === "passed") {
    assert.equal(plugin.upstreamObservedCommit, plugin.upstreamValidatedCommit);
    assert.equal(plugin.upstreamCheckError, undefined);
    if (plugin.repositoryLayout === "root-plugin") {
      assert.equal(plugin.installAvailable, true);
      assert.ok(plugin.installCommand);
    } else {
      assert.equal(plugin.installAvailable, false);
      assert.equal(plugin.installCommand, "");
      assert.ok(["monorepo", "suite"].includes(plugin.repositoryLayout));
    }
  } else if (plugin.upstreamCheckStatus === "failed") {
    assert.ok(upstreamCheckErrorCodes.includes(plugin.upstreamCheckError));
    assert.notEqual(plugin.upstreamCheckError, "repository-unreachable");
    assert.equal(plugin.installAvailable, false);
    assert.equal(plugin.installCommand, "");
    assert.equal(plugin.status, "Compatibility failed");
  } else {
    assert.equal(plugin.upstreamCheckError, "repository-unreachable");
    assert.equal(plugin.status, "Status unknown");
    if (plugin.repositoryLayout === "root-plugin") {
      assert.equal(plugin.installAvailable, true);
      assert.ok(plugin.installCommand);
    } else {
      assert.equal(plugin.installAvailable, false);
      assert.equal(plugin.installCommand, "");
    }
  }
}

test("catalog IDs are unique", () => {
  const ids = catalog.plugins.map((plugin) => plugin.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("catalog has no manual featured ranking", () => {
  assert.equal(catalog.plugins.some((plugin) => Object.hasOwn(plugin, "featured")), false);
  assert.equal(catalog.plugins.some((plugin) => Object.hasOwn(plugin, "releaseTag")), false);
  assert.equal(catalog.plugins.some((plugin) => Object.hasOwn(plugin, "releaseUpdatedAt")), false);
  assert.equal(catalog.stateSchemaVersion, 1);
});

test("community plugins preserve the invariants of every upstream check state", () => {
  for (const plugin of catalog.plugins) {
    assert.match(plugin.repo, /^https:\/\/github\.com\//);
    if (!plugin.placeholder && !plugin.builtIn) {
      assertCommunityPluginState(plugin);
    }
  }
});

test("failed and unreachable catalog records satisfy their state invariants", () => {
  const common = {
    id: "example.weather",
    repo: "https://github.com/example/weather",
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T10:00:00.000Z",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T10:00:00.000Z",
    listingValidatedBranch: "main",
    upstreamObservedCommit: "c".repeat(40),
    upstreamObservedBranch: "main",
    upstreamCheckedAt: "2026-07-28T13:00:00.000Z",
    upstreamValidatedCommit: "b".repeat(40),
    upstreamValidatedAt: "2026-07-28T11:00:00.000Z",
    repositoryLayout: "root-plugin",
  };
  assertCommunityPluginState({
    ...common,
    upstreamCheckStatus: "failed",
    upstreamCheckError: "entry-point-missing",
    installAvailable: false,
    installCommand: "",
    status: "Compatibility failed",
  });
  assertCommunityPluginState({
    ...common,
    upstreamCheckStatus: "unreachable",
    upstreamCheckError: "repository-unreachable",
    installAvailable: true,
    installCommand: "omarchy plugin add https://github.com/example/weather.git --enable",
    status: "Status unknown",
  });
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
    assert.match(plugin.sourceUrl, /^https:\/\/github\.com\/basecamp\/omarchy\/tree\/[a-f0-9]{40}\//);
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

test("root plugins use Quattro while unsupported repository layouts stay non-installable", () => {
  const overview = catalog.plugins.find((plugin) => plugin.id === "omarchy-overview");
  assert.equal(
    overview?.installCommand,
    "omarchy plugin add https://github.com/AyushKr2003/omarchy-overview.git --enable",
  );

  for (const id of ["omni", "quickapps-hud", "cliamp", "taildrop"]) {
    const plugin = catalog.plugins.find((entry) => entry.id === id);
    assert.equal(plugin?.repositoryLayout, "monorepo");
    assert.equal(plugin?.installAvailable, false);
    assert.equal(plugin?.installCommand, "");
  }
  const lacuna = catalog.plugins.find((entry) => entry.id === "lacuna.shell-suite");
  assert.equal(lacuna?.repositoryLayout, "suite");
  assert.equal(lacuna?.installAvailable, false);
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

test("manifest version changes create a three-day updated state", () => {
  const detectedAt = "2026-07-28T12:00:00.000Z";
  const plugins = [
    { id: "new-plugin", version: "1.0.0" },
    { id: "updated-plugin", version: "2.0.0" },
    { id: "unchanged-plugin", version: "1.0.0" },
  ];
  const previous = [
    { id: "updated-plugin", version: "1.0.0" },
    {
      id: "unchanged-plugin",
      version: "1.0.0",
      versionUpdatedAt: "2026-07-27T09:00:00.000Z",
    },
  ];

  const result = applyVersionState(plugins, previous, detectedAt);
  assert.equal(result.find((plugin) => plugin.id === "new-plugin").versionUpdatedAt, undefined);
  assert.equal(result.find((plugin) => plugin.id === "updated-plugin").versionUpdatedAt, detectedAt);
  assert.equal(
    result.find((plugin) => plugin.id === "unchanged-plugin").versionUpdatedAt,
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

test("upstream checks preserve last-known-good state across failures", () => {
  const source = {
    repo: "https://github.com/example/weather",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T10:00:00.000Z",
    listingValidatedBranch: "main",
  };
  const previous = {
    id: "example.weather",
    repo: source.repo,
    version: "1.0.0",
    repositoryLayout: "root-plugin",
    installAvailable: true,
    installCommand: "omarchy plugin add https://github.com/example/weather.git --enable",
    upstreamObservedCommit: "b".repeat(40),
    upstreamObservedBranch: "main",
    upstreamValidatedCommit: "b".repeat(40),
    upstreamValidatedAt: "2026-07-28T11:00:00.000Z",
    upstreamCheckStatus: "passed",
  };
  const failed = failedSourcePlugins(
    source,
    [previous],
    { commitSha: "c".repeat(40), branch: "main" },
    "2026-07-28T12:00:00.000Z",
    new CatalogCheckError("entry-point-missing", "missing"),
  )[0];
  assert.equal(failed.upstreamObservedCommit, "c".repeat(40));
  assert.equal(failed.upstreamValidatedCommit, "b".repeat(40));
  assert.equal(failed.upstreamCheckStatus, "failed");
  assert.equal(failed.installAvailable, false);

  const unreachable = failedSourcePlugins(
    source,
    [failed],
    undefined,
    "2026-07-28T13:00:00.000Z",
    new CatalogCheckError("repository-unreachable", "offline"),
  )[0];
  assert.equal(unreachable.upstreamObservedCommit, "c".repeat(40));
  assert.equal(unreachable.upstreamValidatedCommit, "b".repeat(40));
  assert.equal(unreachable.upstreamCheckStatus, "unreachable");
  assert.equal(unreachable.installAvailable, true);
  assert.equal(
    unreachable.installCommand,
    "omarchy plugin add https://github.com/example/weather.git --enable",
  );
});

test("temporary raw GitHub responses are classified as unreachable", () => {
  assert.equal(snapshotHttpErrorCode(429, "manifest-invalid"), "repository-unreachable");
  assert.equal(snapshotHttpErrorCode(503, "preview-invalid"), "repository-unreachable");
  assert.equal(snapshotHttpErrorCode(404, "entry-point-missing"), "entry-point-missing");
});

test("previews are staged only after the complete source validates", async () => {
  const calls = [];
  const snapshot = { metadata: { previewImage: "preview.png" } };
  await assert.rejects(
    validateBeforeStagingPreview({
      loadPreview: async () => {
        calls.push("load");
        return snapshot;
      },
      validateSource: async () => {
        calls.push("validate");
        throw new CatalogCheckError("manifest-invalid", "invalid");
      },
      stagePreview: async () => calls.push("stage"),
    }),
    /invalid/,
  );
  assert.deepEqual(calls, ["load", "validate"]);

  calls.length = 0;
  const result = await validateBeforeStagingPreview({
    loadPreview: async () => {
      calls.push("load");
      return snapshot;
    },
    validateSource: async (preview) => {
      calls.push("validate");
      assert.equal(preview, snapshot.metadata);
      return ["plugin"];
    },
    stagePreview: async (loaded) => {
      calls.push("stage");
      assert.equal(loaded, snapshot);
    },
  });
  assert.deepEqual(result, ["plugin"]);
  assert.deepEqual(calls, ["load", "validate", "stage"]);
});

test("successful checks bind observed and validated state to one snapshot", () => {
  const sha = "d".repeat(40);
  const plugin = {
    id: "example.weather",
    repo: "https://github.com/example/weather",
    version: "2.0.0",
    installAvailable: true,
  };
  const source = {
    repo: plugin.repo,
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T10:00:00.000Z",
    listingValidatedBranch: "main",
  };
  const result = successfulState(
    plugin,
    source,
    { commitSha: sha, branch: "main" },
    { ...plugin, version: "1.0.0" },
    "2026-07-28T12:00:00.000Z",
  );
  assert.equal(result.upstreamObservedCommit, sha);
  assert.equal(result.upstreamValidatedCommit, sha);
  assert.equal(result.upstreamCheckStatus, "passed");
  assert.equal(result.versionUpdatedAt, "2026-07-28T12:00:00.000Z");
});

test("cards distinguish release tags from manifest versions", () => {
  assert.equal(pluginVersionLabel({ releaseTag: "v2.0.0", version: "1.0.0" }), "manifest v1.0.0");
  assert.equal(pluginVersionLabel({ version: "1.0.0" }), "manifest v1.0.0");
  assert.equal(pluginVersionLabel({ version: "v1.0.0" }), "manifest v1.0.0");
  assert.equal(pluginVersionLabel({ placeholder: true, version: "Preview" }), "");
});

test("SHIBUMI remains a non-installable placeholder", () => {
  const shibumi = catalog.plugins.find((plugin) => plugin.id === "hancore.shibumi");
  assert.equal(shibumi?.placeholder, true);
  assert.equal(shibumi?.installCommand, "");
});
