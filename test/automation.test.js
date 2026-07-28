import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  addRegistrySource,
  assertApprovedIssueBody,
  canApprove,
  createRegistrySource,
  hasRightsConfirmation,
  isLegacySubmission,
  parseSubmission,
  rightsStatement,
} from "../scripts/approve-submission.mjs";
import {
  discoveredPlugins,
  isListedPlugin,
  parseGitHubRepository,
  validateManifest,
} from "../scripts/build-catalog.mjs";
import { extractRepositoryUrl } from "../scripts/validate-submission.mjs";

test("GitHub repository URLs are normalized and restricted", () => {
  assert.deepEqual(
    parseGitHubRepository("https://github.com/example/omarchy-plugin.git"),
    { owner: "example", repository: "omarchy-plugin", slug: "example/omarchy-plugin" }
  );
  assert.throws(() => parseGitHubRepository("http://github.com/example/plugin"), /Only public HTTPS/);
  assert.throws(() => parseGitHubRepository("https://gitlab.com/example/plugin"), /Only public HTTPS/);
  assert.throws(() => parseGitHubRepository("https://github.com/example/plugin/tree/main"), /repository root/);
});

test("entry modules and their shared dependency use one cache key", async () => {
  const root = new URL("../", import.meta.url);
  const files = {
    index: await readFile(new URL("site/index.html", root), "utf8"),
    plugin: await readFile(new URL("site/plugin.html", root), "utf8"),
    publish: await readFile(new URL("site/publish.html", root), "utf8"),
    app: await readFile(new URL("site/assets/js/app.js", root), "utf8"),
    pluginJs: await readFile(new URL("site/assets/js/plugin.js", root), "utf8"),
    publishJs: await readFile(new URL("site/assets/js/publish.js", root), "utf8"),
  };
  const keys = [
    files.index.match(/app\.js\?v=([^"']+)/)?.[1],
    files.plugin.match(/plugin\.js\?v=([^"']+)/)?.[1],
    files.publish.match(/publish\.js\?v=([^"']+)/)?.[1],
    files.app.match(/shared\.js\?v=([^"']+)/)?.[1],
    files.pluginJs.match(/shared\.js\?v=([^"']+)/)?.[1],
    files.publishJs.match(/shared\.js\?v=([^"']+)/)?.[1],
  ];
  assert.ok(keys.every(Boolean));
  assert.equal(new Set(keys).size, 1);
  assert.match(files.index, /<title>Browse Plugins \| Omarchy Plugins<\/title>/);
  assert.match(files.plugin, /<title>Plugin Details \| Omarchy Plugins<\/title>/);
  assert.match(files.publish, /<title>Publish a Plugin \| Omarchy Plugins<\/title>/);
  assert.match(files.pluginJs, /document\.title = `\$\{plugin\.name\} \| Omarchy Plugins`/);
  assert.match(files.index, /class="market-hero-ray"[\s\S]*<canvas width="400" height="300" aria-hidden="true"><\/canvas>/);
  assert.match(files.app, /function setupHeroRay\(\)/);
  assert.match(files.app, /sourcePointCount = 6000/);
  assert.match(files.app, /"ORIGINAL"[\s\S]*"COCOON"[\s\S]*"STORM"[\s\S]*"RAY"[\s\S]*"BIRD"[\s\S]*"WING"/);
  assert.match(files.index, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(files.app, /const logoScale = Math\.min\(markBounds\.width \/ 650, markBounds\.height \/ 140\)/);
  assert.doesNotMatch(files.app, /const scaleX = markBounds|const scaleY = markBounds/);
});

test("automation deploys refreshed catalogs and uses listing-specific approval", async () => {
  const root = new URL("../", import.meta.url);
  const approve = await readFile(
    new URL(".github/workflows/approve-submission.yml", root),
    "utf8",
  );
  const refresh = await readFile(
    new URL(".github/workflows/refresh-catalog.yml", root),
    "utf8",
  );
  const deploy = await readFile(
    new URL(".github/workflows/deploy-pages.yml", root),
    "utf8",
  );
  const validate = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  assert.match(approve, /approved-for-listing/);
  assert.doesNotMatch(approve, /label\.name == 'approved'/);
  assert.match(approve, /APPROVED_ISSUE_BODY:\s+\$\{\{ github\.event\.issue\.body \}\}/);
  assert.match(approve, /git diff --cached --quiet/);
  assert.match(refresh, /actions\/upload-pages-artifact@/);
  assert.match(refresh, /actions\/deploy-pages@/);
  for (const workflow of [approve, refresh]) {
    assert.match(
      workflow,
      /group: plugin-catalog-writes\s+cancel-in-progress: false\s+queue: max/,
    );
  }
  for (const workflow of [approve, refresh, deploy]) {
    assert.match(
      workflow,
      /group: github-pages-deployments\s+cancel-in-progress: false\s+queue: max/,
    );
  }
  for (const workflow of [approve, refresh, deploy]) {
    const deployStart = workflow.indexOf("\n  deploy:\n");
    assert.ok(deployStart > 0);
    const followingJob = workflow.slice(deployStart + 1).search(/\n  [a-z][a-z0-9-]*:\n/i);
    const deployJob = followingJob < 0
      ? workflow.slice(deployStart)
      : workflow.slice(deployStart, deployStart + 1 + followingJob);
    assert.doesNotMatch(workflow.slice(0, deployStart), /actions\/upload-pages-artifact@/);
    assert.match(deployJob, /group: github-pages-deployments/);
    assert.match(deployJob, /ref: main/);
    const checkoutAt = deployJob.indexOf("actions/checkout@");
    const buildAt = deployJob.indexOf("run: npm run build");
    const testAt = deployJob.indexOf("run: npm test");
    const uploadAt = deployJob.indexOf("actions/upload-pages-artifact@");
    const deployAt = deployJob.indexOf("actions/deploy-pages@");
    assert.ok(checkoutAt > 0);
    assert.ok(checkoutAt < buildAt);
    assert.ok(buildAt < testAt);
    assert.ok(testAt < uploadAt);
    assert.ok(uploadAt < deployAt);
  }
  for (const workflow of [approve, refresh, deploy]) {
    assert.ok(workflow.indexOf("run: npm run build") < workflow.indexOf("run: npm test"));
  }
  assert.match(validate, /group: validate-submission-\$\{\{ github\.event\.issue\.number \}\}/);
  assert.match(validate, /timeout-minutes:/);
  assert.match(validate, /marketplace-validation/);
  assert.match(validate, /issues\/comments\/\$\{COMMENT_ID\}/);
  assert.doesNotMatch(validate, /--edit-last/);
  for (const workflow of [approve, refresh, deploy, validate]) {
    const actionUses = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    assert.ok(actionUses.length > 0);
    assert.ok(actionUses.every((action) => /@[a-f0-9]{40}$/.test(action)));
  }
});

test("submission issue bodies yield a normalized repository URL", () => {
  const body = "### Repository URL\n\nhttps://github.com/example/omarchy-plugin.git\n\n### Category\nDesktop";
  assert.equal(extractRepositoryUrl(body), "https://github.com/example/omarchy-plugin");
  assert.throws(() => extractRepositoryUrl("No repository supplied"), /No public GitHub repository URL/);
});

test("approval fields are parsed from the submission issue", () => {
  const body = [
    "### Repository URL",
    "",
    "https://github.com/example/omarchy-plugin.git",
    "",
    "### Category",
    "",
    "Developer Tools",
    "",
    "### Tags",
    "",
    "Command Palette, shell, shell",
  ].join("\n");

  assert.deepEqual(parseSubmission(body), {
    repo: "https://github.com/example/omarchy-plugin",
    category: "Developer Tools",
    tags: ["command-palette", "shell"],
  });
  assert.throws(
    () => parseSubmission(body.replace("Developer Tools", "Unlisted")),
    /Unsupported submission category/,
  );
});

test("distribution rights require a checked box or confirmation by the submitter", () => {
  const issue = {
    user: { login: "plugin-author" },
    body: `- [ ] ${rightsStatement}`,
  };
  assert.equal(hasRightsConfirmation(issue), false);
  assert.equal(
    hasRightsConfirmation(issue, [{
      user: { login: "someone-else" },
      body: rightsStatement,
    }]),
    false,
  );
  assert.equal(
    hasRightsConfirmation(issue, [{
      user: { login: "plugin-author" },
      body: `Confirmed: ${rightsStatement}`,
    }]),
    true,
  );
  assert.equal(
    hasRightsConfirmation({ ...issue, body: `- [x] ${rightsStatement}` }),
    true,
  );
  assert.equal(
    hasRightsConfirmation(issue, [{
      user: { login: "plugin-author" },
      body: "I have the right to distribute this plugin and its assets under the declared license.",
    }]),
    true,
  );
});

test("only maintainers with write access can approve submissions", () => {
  for (const permission of ["write", "maintain", "admin"]) {
    assert.equal(canApprove(permission), true);
  }
  for (const permission of ["read", "triage", "none", undefined]) {
    assert.equal(canApprove(permission), false);
  }
});

test("approval processes exactly the issue body seen when the label was applied", () => {
  const approved = "### Repository URL\n\nhttps://github.com/example/plugin\n";
  assert.doesNotThrow(() => assertApprovedIssueBody(approved, approved));
  assert.throws(
    () => assertApprovedIssueBody(
      approved.replace("example/plugin", "attacker/replacement"),
      approved,
    ),
    /changed after approval/,
  );
  assert.throws(
    () => assertApprovedIssueBody(`${approved}\n`, approved),
    /changed after approval/,
  );
  assert.throws(
    () => assertApprovedIssueBody(approved, undefined),
    /APPROVED_ISSUE_BODY is required/,
  );
});

test("only submissions predating the rights checkbox receive legacy handling", () => {
  assert.equal(isLegacySubmission({ created_at: "2026-07-28T10:49:00Z" }), true);
  assert.equal(isLegacySubmission({ created_at: "2026-07-28T10:59:00Z" }), false);
  assert.equal(isLegacySubmission({}), false);
});

test("approved submissions become registry sources without duplicates", () => {
  const source = createRegistrySource({
    submission: {
      repo: "https://github.com/Example/omarchy-plugin",
      category: "Desktop",
      tags: ["overview", "workspaces"],
    },
    manifests: [
      { id: "example.overview", name: "Overview" },
      { id: "example.switcher", name: "Switcher" },
    ],
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedBranch: "main",
  });

  assert.deepEqual(source, {
    repo: "https://github.com/Example/omarchy-plugin",
    type: "plugin-source",
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedBranch: "main",
    plugins: {
      "example.overview": {
        category: "Desktop",
        tags: ["overview", "workspaces"],
      },
      "example.switcher": {
        category: "Desktop",
        tags: ["overview", "workspaces"],
      },
    },
  });
  assert.deepEqual(addRegistrySource({ sources: [] }, source), { sources: [source] });
  assert.deepEqual(addRegistrySource({ sources: [source] }, source), { sources: [source] });
  assert.throws(
    () => addRegistrySource(
      { sources: [source] },
      {
        ...source,
        plugins: {
          ...source.plugins,
          "example.extra": { category: "Desktop", tags: ["extra"] },
        },
      },
    ),
    /different plugin set/,
  );
  assert.throws(
    () => addRegistrySource({ sources: [] }, source, ["example.overview"]),
    /already listed/,
  );
});

test("registry plugin IDs are an explicit publication allowlist", () => {
  const source = {
    plugins: {
      "example.approved": { category: "Desktop", tags: ["approved"] },
    },
  };
  assert.equal(isListedPlugin(source, "example.approved"), true);
  assert.equal(isListedPlugin(source, "example.added-later"), false);
  assert.equal(isListedPlugin({}, "example.added-later"), false);
});

test("catalog discovery ignores manifests added after listing approval", async () => {
  const approved = {
    schemaVersion: 1,
    id: "example.approved",
    name: "Approved",
    version: "1.0.0",
    author: "Example",
    description: "The plugin approved for marketplace listing.",
    kinds: ["overlay"],
    entryPoints: { overlay: "Main.qml" },
  };
  const addedLater = {
    ...approved,
    id: "example.added-later",
    name: "Added later",
  };
  const tree = [
    { path: "manifest.json", type: "blob", mode: "100644" },
    { path: "Main.qml", type: "blob", mode: "100644" },
    { path: "extra/manifest.json", type: "blob", mode: "100644" },
    { path: "extra/Main.qml", type: "blob", mode: "100644" },
  ];
  const context = {
    repository: { owner: "example", repository: "plugins", slug: "example/plugins" },
    commitSha: "a".repeat(40),
    tree,
    treeByPath: new Map(tree.map((entry) => [entry.path, entry])),
    metadata: {},
  };
  const source = {
    repo: "https://github.com/example/plugins",
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T12:00:00.000Z",
    plugins: {
      "example.approved": { category: "Desktop", tags: ["approved"] },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(
    JSON.stringify(String(url).includes("/extra/") ? addedLater : approved),
    { status: 200 },
  );
  try {
    const result = await discoveredPlugins(source, context, null);
    assert.deepEqual(result.map((plugin) => plugin.id), ["example.approved"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin manifests require stable marketplace identity fields", () => {
  const manifest = {
    schemaVersion: 1,
    id: "example.weather",
    name: "Weather",
    version: "1.0.0",
    author: "Example",
    description: "Weather in the Omarchy bar.",
    kinds: ["bar-widget"],
    entryPoints: { barWidget: "Widget.qml" }
  };
  assert.equal(validateManifest(manifest, "manifest.json"), manifest);
  assert.throws(
    () => validateManifest({ ...manifest, description: "" }, "manifest.json"),
    /description/
  );
  assert.throws(
    () => validateManifest({ ...manifest, kinds: "overlay" }, "manifest.json"),
    /unsupported values/
  );
  assert.throws(
    () => validateManifest({ ...manifest, schemaVersion: 0 }, "manifest.json"),
    /exactly 1/
  );
  assert.throws(
    () => validateManifest({ ...manifest, entryPoints: { barWidget: "../Outside.qml" } }, "manifest.json"),
    /safe relative paths/
  );
  assert.throws(
    () => validateManifest({ ...manifest, id: "omarchy.fake" }, "manifest.json", { community: true }),
    /reserved/
  );
  assert.throws(
    () => validateManifest({ ...manifest, entryPoints: {} }, "manifest.json"),
    /entry point/
  );
});

test("generated source plugins retain manifest paths and local preview assets", async () => {
  const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));
  const omni = catalog.plugins.find((plugin) => plugin.id === "omni");
  const lacuna = catalog.plugins.find((plugin) => plugin.id === "lacuna.shell-suite");
  assert.equal(omni.manifestPath, "omni/manifest.json");
  assert.match(lacuna.previewImage, /^assets\/img\/plugins\//);
});
