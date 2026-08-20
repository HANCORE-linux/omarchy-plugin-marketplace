import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  securityBaselineEnforcementMode,
  securityBaselineVersion,
} from "../scripts/security-baseline-policy.mjs";
import { verificationAcknowledgment } from "../scripts/plugin-verification.mjs";
import { listedSnapshotVerificationAction } from "../scripts/plugin-verification-request.mjs";
import { serializeMaintainerVerificationExpectation } from "../scripts/verification-review.mjs";

const execute = promisify(execFile);
const commit = "a".repeat(40);

function issueBody() {
  return [
    "### Verification action",
    "",
    listedSnapshotVerificationAction,
    "",
    "### Plugin ID",
    "",
    "example.plugin",
    "",
    "### Repository URL",
    "",
    "https://github.com/example/plugin",
    "",
    "### Target commit",
    "",
    commit,
    "",
    "### Verification acknowledgment",
    "",
    `- [x] ${verificationAcknowledgment}`,
  ].join("\n");
}

test("verification CLI repairs a stale catalog and emits deterministic workflow outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plugin-verification-cli-"));
  const registryPath = join(directory, "registry.json");
  const catalogPath = join(directory, "site/catalog.json");
  const outputDirectory = join(directory, "output");
  const githubOutput = join(directory, "github-output.txt");
  await mkdir(join(directory, "site"), { recursive: true });
  const baseline = {
    schemaVersion: 1,
    version: securityBaselineVersion,
    repository: "example/plugin",
    pluginIds: ["example.plugin"],
    commit,
    checkedAt: "2026-08-16T12:00:00.000Z",
    outcome: "passed",
    enforcementMode: securityBaselineEnforcementMode,
    findings: [],
    capabilities: [],
  };
  const registry = {
    sources: [{
      repo: "https://github.com/example/plugin",
      type: "plugin-source",
      listingValidatedCommit: commit,
      automatedSecurityBaseline: baseline,
      plugins: { "example.plugin": {} },
    }],
  };
  const catalog = {
    generatedAt: "2026-08-16T10:00:00.000Z",
    plugins: [{
      id: "example.plugin",
      repo: "https://github.com/example/plugin",
      sourceType: "community",
      manifestPath: "manifest.json",
      verificationStatus: "unverified",
    }],
  };
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(githubOutput, "");

  try {
    await execute(process.execPath, [
      "scripts/verify-listed-plugin.mjs",
      `--registry=${registryPath}`,
      `--catalog=${catalogPath}`,
      `--output-dir=${outputDirectory}`,
    ], {
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        ...process.env,
        ISSUE_BODY: issueBody(),
        GITHUB_OUTPUT: githubOutput,
        GITHUB_TOKEN: "",
      },
    });
    const [result, nextRegistry, nextCatalog, report, outputs] = await Promise.all([
      readFile(join(outputDirectory, "verification-result.json"), "utf8").then(JSON.parse),
      readFile(registryPath, "utf8").then(JSON.parse),
      readFile(catalogPath, "utf8").then(JSON.parse),
      readFile(join(outputDirectory, "verification-report.md"), "utf8"),
      readFile(githubOutput, "utf8"),
    ]);
    assert.equal(result.status, "verified");
    assert.equal(result.changed, true);
    assert.deepEqual(result.affectedPluginIds, ["example.plugin"]);
    assert.deepEqual(result.baselineFindings, []);
    assert.deepEqual(result.baselineCapabilities, []);
    assert.equal(result.verificationMethod, "automated");
    assert.equal(result.maintainerReviewRequested, false);
    assert.deepEqual(nextRegistry, registry);
    assert.equal(nextCatalog.plugins[0].verificationStatus, "verified");
    assert.equal(nextCatalog.plugins[0].verificationCommit, commit);
    assert.match(report, /✅ \*\*Verified\*\*/);
    assert.match(outputs, /^result=verified$/m);
    assert.match(outputs, /^changed=true$/m);
    assert.match(outputs, /^verification_method=automated$/m);
    assert.match(outputs, /^maintainer_review_requested=false$/m);
    assert.match(outputs, new RegExp(`^commit_sha=${commit}$`, "m"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification CLI preserves maintainer review state for handled errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plugin-verification-cli-error-"));
  const registryPath = join(directory, "registry.json");
  const catalogPath = join(directory, "site/catalog.json");
  const outputDirectory = join(directory, "output");
  const githubOutput = join(directory, "github-output.txt");
  const reviewReportPath = join(directory, "maintainer-review-report.md");
  await mkdir(join(directory, "site"), { recursive: true });
  await writeFile(registryPath, "{\"sources\":[]}\n");
  await writeFile(catalogPath, "{\"plugins\":[]}\n");
  await writeFile(githubOutput, "");
  await writeFile(reviewReportPath, `${serializeMaintainerVerificationExpectation({
    schemaVersion: 1,
    version: securityBaselineVersion,
    repository: "example/plugin",
    pluginIds: ["example.plugin"],
    commit,
    checkedAt: "2026-08-16T11:00:00.000Z",
    outcome: "review-required",
    enforcementMode: securityBaselineEnforcementMode,
    findings: [],
    capabilities: ["privilege"],
  })}\n`);

  try {
    await execute(process.execPath, [
      "scripts/verify-listed-plugin.mjs",
      `--registry=${registryPath}`,
      `--catalog=${catalogPath}`,
      `--output-dir=${outputDirectory}`,
    ], {
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        ...process.env,
        ISSUE_BODY: "invalid request",
        GITHUB_OUTPUT: githubOutput,
        GITHUB_TOKEN: "",
        MAINTAINER_REVIEW_REQUESTED: "true",
        MAINTAINER_REVIEWER: "hancore",
        MAINTAINER_REVIEW_EVENT_ID: "44001",
        MAINTAINER_REVIEW_REQUESTED_AT: "2026-08-16T11:30:00.000Z",
        MAINTAINER_REVIEW_REPORT_PATH: reviewReportPath,
      },
    });
    const [result, report, outputs] = await Promise.all([
      readFile(join(outputDirectory, "verification-result.json"), "utf8").then(JSON.parse),
      readFile(join(outputDirectory, "verification-report.md"), "utf8"),
      readFile(githubOutput, "utf8"),
    ]);
    assert.equal(result.status, "error");
    assert.equal(result.maintainerReviewRequested, true);
    assert.doesNotMatch(report, /marketplace-maintainer-verification-expectation:v1/);
    assert.match(report, /edit the open issue or reopen it to run normal verification/);
    assert.match(report, /Only after the bot publishes a new eligible `review-required` report/);
    assert.match(outputs, /^result=error$/m);
    assert.match(outputs, /^maintainer_review_requested=true$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
