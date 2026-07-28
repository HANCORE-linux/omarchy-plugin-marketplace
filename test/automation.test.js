import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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
