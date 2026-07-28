import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  addRegistrySource,
  canApprove,
  createRegistrySource,
  hasRightsConfirmation,
  isLegacySubmission,
  parseSubmission,
  rightsStatement,
} from "../scripts/approve-submission.mjs";
import { parseGitHubRepository, validateManifest } from "../scripts/build-catalog.mjs";
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
  });

  assert.deepEqual(source, {
    repo: "https://github.com/Example/omarchy-plugin",
    type: "plugin-source",
    sourceId: "example",
    addedAt: "2026-07-28",
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
  assert.throws(
    () => addRegistrySource({ sources: [source] }, source),
    /already registered/,
  );
  assert.throws(
    () => addRegistrySource({ sources: [] }, source, ["example.overview"]),
    /already listed/,
  );
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
    /non-empty array/
  );
  assert.throws(
    () => validateManifest({ ...manifest, schemaVersion: 0 }, "manifest.json"),
    /exactly 1/
  );
  assert.throws(
    () => validateManifest({ ...manifest, entryPoints: { overlay: "../Outside.qml" } }, "manifest.json"),
    /safe relative paths/
  );
});

test("generated source plugins retain manifest paths and local preview assets", async () => {
  const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));
  const omni = catalog.plugins.find((plugin) => plugin.id === "omni");
  const lacuna = catalog.plugins.find((plugin) => plugin.id === "lacuna.shell-suite");
  assert.equal(omni.manifestPath, "omni/manifest.json");
  assert.match(lacuna.previewImage, /^assets\/img\/plugins\//);
});
