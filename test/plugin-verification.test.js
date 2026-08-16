import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  analyzeListedPluginVerification,
  buildVerificationReport,
  listedSourceForRequest,
  parseVerificationRequest,
  PluginVerificationError,
  updateCatalogVerification,
  verificationAcknowledgment,
  verificationBaselineRecord,
} from "../scripts/verify-listed-plugin.mjs";
import {
  securityBaselineEnforcementMode,
  securityBaselineVersion,
} from "../scripts/security-baseline-policy.mjs";
import { catalogVerificationFields } from "../scripts/catalog-verification.mjs";
import { sourceVerification } from "../scripts/verification-status.mjs";

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const checkedAt = "2026-08-16T12:00:00.000Z";

function requestBody(overrides = {}) {
  return [
    "### Plugin ID",
    "",
    overrides.pluginId || "example.plugin",
    "",
    "### Repository URL",
    "",
    overrides.repoUrl || "https://github.com/example/plugin",
    "",
    "### Listed commit",
    "",
    overrides.commitSha || commit,
    "",
    "### Verification acknowledgment",
    "",
    overrides.acknowledgment || `- [x] ${verificationAcknowledgment}`,
  ].join("\n");
}

function source(overrides = {}) {
  return {
    repo: "https://github.com/example/plugin",
    type: "plugin-source",
    addedAt: "2026-08-01",
    listedAt: "2026-08-01T10:00:00.000Z",
    listingValidatedCommit: commit,
    listingValidatedAt: "2026-08-01T10:00:00.000Z",
    listingValidatedBranch: "main",
    plugins: { "example.plugin": { category: "System", tags: ["system"] } },
    ...overrides,
  };
}

function baseline(overrides = {}) {
  return {
    schemaVersion: 1,
    baselineVersion: securityBaselineVersion,
    repository: "example/plugin",
    repoUrl: "https://github.com/example/plugin",
    commitSha: commit,
    checkedAt,
    outcome: "passed",
    enforcementMode: securityBaselineEnforcementMode,
    blocksApproval: false,
    findings: [],
    capabilities: [],
    ...overrides,
  };
}

function storedBaseline(overrides = {}) {
  return {
    schemaVersion: 1,
    version: securityBaselineVersion,
    repository: "example/plugin",
    pluginIds: ["example.plugin"],
    commit,
    checkedAt,
    outcome: "passed",
    enforcementMode: securityBaselineEnforcementMode,
    findings: [],
    capabilities: [],
    ...overrides,
  };
}

function catalog() {
  return {
    generatedAt: "2026-08-16T10:00:00.000Z",
    stateSchemaVersion: 1,
    mode: "production",
    plugins: [{
      id: "example.plugin",
      name: "Example",
      repo: "https://github.com/example/plugin",
      sourceType: "community",
      manifestPath: "manifest.json",
    }, {
      id: "other.plugin",
      name: "Other",
      repo: "https://github.com/other/plugin",
      sourceType: "community",
      verificationStatus: "unverified",
    }],
    warnings: [],
  };
}

test("verification status is derived only from a current passing commit-bound baseline", () => {
  const verifiedSource = source({ automatedSecurityBaseline: storedBaseline() });
  assert.deepEqual(sourceVerification(verifiedSource), {
    status: "verified",
    baselineVersion: securityBaselineVersion,
    commit,
    checkedAt,
  });
  assert.deepEqual(sourceVerification(source({ automatedSecurityBaseline: {
    ...storedBaseline(),
    schemaVersion: undefined,
    repository: undefined,
    pluginIds: undefined,
  } })), {
    status: "verified",
    baselineVersion: securityBaselineVersion,
    commit,
    checkedAt,
  });
  assert.deepEqual(catalogVerificationFields(verifiedSource), {
    verificationStatus: "verified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: commit,
    verificationCheckedAt: checkedAt,
  });

  for (const automatedSecurityBaseline of [
    null,
    storedBaseline({ version: String(Number(securityBaselineVersion) - 1) }),
    storedBaseline({ enforcementMode: "review-only" }),
    storedBaseline({ outcome: "review-required", capabilities: ["service-management"] }),
    storedBaseline({ outcome: "needs-fixes", findings: ["curl-pipe-shell"] }),
    storedBaseline({ commit: otherCommit }),
    storedBaseline({ repository: undefined }),
    storedBaseline({ pluginIds: undefined }),
    storedBaseline({ repository: "other/plugin" }),
    storedBaseline({ pluginIds: ["other.plugin"] }),
    storedBaseline({ checkedAt: "not-a-date" }),
    storedBaseline({ findings: null }),
    storedBaseline({ capabilities: null }),
  ]) {
    assert.deepEqual(sourceVerification(source({ automatedSecurityBaseline })), {
      status: "unverified",
    });
  }
});

test("verification requests require the exact issue-form contract", () => {
  assert.deepEqual(parseVerificationRequest(requestBody()), {
    pluginId: "example.plugin",
    repository: "example/plugin",
    repoUrl: "https://github.com/example/plugin",
    commitSha: commit,
  });
  assert.throws(
    () => parseVerificationRequest(requestBody({ pluginId: "Example Plugin" })),
    (error) => error instanceof PluginVerificationError
      && error.code === "verification-plugin-id-invalid",
  );
  assert.throws(
    () => parseVerificationRequest(requestBody({ repoUrl: "https://example.com/plugin" })),
    (error) => error.code === "verification-repository-invalid",
  );
  assert.throws(
    () => parseVerificationRequest(requestBody({ commitSha: "abc123" })),
    (error) => error.code === "verification-commit-invalid",
  );
  assert.throws(
    () => parseVerificationRequest(requestBody({ acknowledgment: `- [ ] ${verificationAcknowledgment}` })),
    (error) => error.code === "verification-acknowledgment-missing",
  );
  assert.throws(
    () => parseVerificationRequest(requestBody().replace("### Repository URL", "### Repository")),
    (error) => error.code === "verification-fields-invalid",
  );
});

test("verification requests must match one existing registry source exactly", () => {
  const registry = { sources: [source()] };
  const request = parseVerificationRequest(requestBody());
  assert.equal(listedSourceForRequest(registry, request), registry.sources[0]);
  const suite = source({ type: "suite", plugins: {}, catalog: { id: "example.plugin" } });
  assert.throws(
    () => listedSourceForRequest({ sources: [suite] }, request),
    (error) => error.code === "verification-source-unsupported",
  );
  assert.throws(
    () => listedSourceForRequest(registry, { ...request, pluginId: "missing.plugin" }),
    (error) => error.code === "verification-plugin-not-listed",
  );
  assert.throws(
    () => listedSourceForRequest(registry, { ...request, repository: "other/plugin" }),
    (error) => error.code === "verification-repository-mismatch",
  );
  assert.throws(
    () => listedSourceForRequest(registry, { ...request, commitSha: otherCommit }),
    (error) => error.code === "verification-commit-mismatch",
  );
});

test("shell suites are explicitly outside the first plugin-source verification workflow", async () => {
  const suite = source({ type: "suite", plugins: {}, catalog: { id: "example.plugin" } });
  await assert.rejects(
    analyzeListedPluginVerification({
      body: requestBody(),
      registry: { sources: [suite] },
      catalog: catalog(),
      runBaseline: async () => assert.fail("unsupported suites must not be scanned"),
    }),
    (error) => error.code === "verification-source-unsupported",
  );
});

test("a passing baseline updates only the matching source and catalog plugins", async () => {
  const originalSource = source();
  const registry = {
    sources: [originalSource, source({
      repo: "https://github.com/other/plugin",
      listingValidatedCommit: otherCommit,
      plugins: { "other.plugin": { category: "Other", tags: ["system"] } },
    })],
  };
  const originalCatalog = catalog();
  let calls = 0;
  const result = await analyzeListedPluginVerification({
    body: requestBody(),
    registry,
    catalog: originalCatalog,
    token: "test-token",
    runBaseline: async (repoUrl, commitSha, options) => {
      calls++;
      assert.equal(repoUrl, originalSource.repo);
      assert.equal(commitSha, commit);
      assert.equal(options.token, "test-token");
      assert.deepEqual(options.listedPlugins, [{
        pluginId: "example.plugin",
        manifestPathHint: "manifest.json",
      }]);
      return baseline();
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.status, "verified");
  assert.equal(result.changed, true);
  assert.deepEqual(result.registry.sources[0].automatedSecurityBaseline, storedBaseline());
  assert.equal(result.registry.sources[1], registry.sources[1]);
  assert.equal(result.catalog.generatedAt, checkedAt);
  assert.deepEqual(result.catalog.plugins[0], {
    ...originalCatalog.plugins[0],
    verificationStatus: "verified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: commit,
    verificationCheckedAt: checkedAt,
  });
  assert.equal(result.catalog.plugins[1], originalCatalog.plugins[1]);

  await assert.rejects(
    analyzeListedPluginVerification({
      body: requestBody(),
      registry,
      catalog: {
        ...originalCatalog,
        plugins: originalCatalog.plugins.filter((plugin) => plugin.id !== "example.plugin"),
      },
      runBaseline: async () => baseline(),
    }),
    (error) => error.code === "verification-catalog-listing-missing",
  );
});

test("non-passing baselines stay unchanged and current baselines repair stale catalogs", async () => {
  const registry = { sources: [source()] };
  const originalCatalog = catalog();
  const reviewResult = await analyzeListedPluginVerification({
    body: requestBody(),
    registry,
    catalog: originalCatalog,
    runBaseline: async () => baseline({
      outcome: "review-required",
      capabilities: [{ id: "service-management" }],
    }),
  });
  assert.equal(reviewResult.status, "unverified");
  assert.equal(reviewResult.changed, false);
  assert.equal(reviewResult.registry, registry);
  assert.equal(reviewResult.catalog, originalCatalog);

  const verifiedRegistry = {
    sources: [source({ automatedSecurityBaseline: storedBaseline() })],
  };
  const repaired = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: verifiedRegistry,
    catalog: originalCatalog,
    runBaseline: async () => assert.fail("an already verified source must not be fetched"),
    now: () => checkedAt,
  });
  assert.equal(repaired.status, "verified");
  assert.equal(repaired.changed, true);
  assert.equal(repaired.registry, verifiedRegistry);
  assert.equal(repaired.catalog.generatedAt, checkedAt);
  assert.deepEqual(repaired.catalog.plugins[0], {
    ...originalCatalog.plugins[0],
    verificationStatus: "verified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: commit,
    verificationCheckedAt: checkedAt,
  });

  const buildOrderedCatalog = catalog();
  buildOrderedCatalog.plugins[0] = {
    id: "example.plugin",
    name: "Example",
    repo: "https://github.com/example/plugin",
    sourceType: "community",
    ...catalogVerificationFields(verifiedRegistry.sources[0]),
    manifestPath: "manifest.json",
  };
  const current = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: verifiedRegistry,
    catalog: buildOrderedCatalog,
    runBaseline: async () => assert.fail("an already verified source must not be fetched"),
  });
  assert.equal(current.status, "already-verified");
  assert.equal(current.changed, false);
  assert.equal(current.catalog, buildOrderedCatalog);
});

test("baseline records reject repository, commit, version, and summary tampering", () => {
  const listedSource = source();
  assert.deepEqual(verificationBaselineRecord(baseline(), listedSource), storedBaseline());
  for (const invalid of [
    baseline({ repository: "other/plugin" }),
    baseline({ commitSha: otherCommit }),
    baseline({ baselineVersion: "999" }),
    baseline({ checkedAt: "invalid" }),
    baseline({ outcome: "passed", findings: [{ ruleId: "curl-pipe-shell" }] }),
    baseline({ findings: [{}] }),
    baseline({ findings: [null] }),
    baseline({ findings: null }),
    baseline({ capabilities: {} }),
    baseline({ capabilities: [{ id: "" }] }),
    baseline({ capabilities: [{ id: " service-management" }] }),
  ]) {
    assert.throws(
      () => verificationBaselineRecord(invalid, listedSource),
      (error) => error.code === "verification-baseline-invalid",
    );
  }
});

test("catalog verification refresh removes stale derived fields", () => {
  const staleCatalog = catalog();
  staleCatalog.plugins[0] = {
    ...staleCatalog.plugins[0],
    verificationStatus: "verified",
    verificationBaselineVersion: "1",
    verificationCommit: otherCommit,
    verificationCheckedAt: checkedAt,
  };
  const updated = updateCatalogVerification(staleCatalog, source());
  assert.deepEqual(updated.plugins[0], {
    id: "example.plugin",
    name: "Example",
    repo: "https://github.com/example/plugin",
    sourceType: "community",
    manifestPath: "manifest.json",
    verificationStatus: "unverified",
  });

  assert.throws(
    () => updateCatalogVerification({
      ...staleCatalog,
      plugins: [
        ...staleCatalog.plugins,
        {
          id: "example.stale",
          repo: "https://github.com/example/plugin",
          sourceType: "community",
          manifestPath: "stale/manifest.json",
        },
      ],
    }, source()),
    (error) => error.code === "verification-catalog-plugin-set-mismatch",
  );
});

test("multi-plugin repositories use one explicit source-wide verification subject", async () => {
  const multiSource = source({
    plugins: {
      "example.plugin": { category: "Desktop", tags: ["overlay"], manifestPath: "manifest.json" },
      "example.second": { category: "System", tags: ["system"], manifestPath: "second/manifest.json" },
    },
  });
  const multiCatalog = {
    ...catalog(),
    plugins: [
      catalog().plugins[0],
      {
        id: "example.second",
        name: "Second",
        repo: multiSource.repo,
        sourceType: "community",
        manifestPath: "current-second/manifest.json",
      },
    ],
  };
  const result = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: { sources: [multiSource] },
    catalog: multiCatalog,
    runBaseline: async (repoUrl, commitSha, options) => {
      assert.deepEqual(options.listedPlugins, [
        { pluginId: "example.plugin", manifestPathHint: "manifest.json" },
        { pluginId: "example.second", manifestPathHint: "second/manifest.json" },
      ]);
      return baseline();
    },
  });
  assert.deepEqual(result.subject.pluginIds, ["example.plugin", "example.second"]);
  assert.ok(result.catalog.plugins.every((plugin) => plugin.verificationStatus === "verified"));
  assert.match(buildVerificationReport(result), /source-wide result applies to: `example\.plugin`, `example\.second`/);
});

test("verification reports preserve finding evidence and accepted remediation", () => {
  const request = parseVerificationRequest(requestBody());
  const report = buildVerificationReport({
    status: "unverified",
    request,
    baseline: storedBaseline({
      outcome: "needs-fixes",
      findings: ["curl-pipe-shell"],
    }),
    scanResult: baseline({
      outcome: "needs-fixes",
      findings: [{
        ruleId: "curl-pipe-shell",
        title: "Downloaded content is passed directly to a shell",
        why: "Downloaded source is executed immediately.",
        actions: ["Remove the download-and-execute path."],
        evidence: [{ path: "install.sh", line: 4, snippet: "curl example.test | sh" }],
      }],
    }),
  });
  assert.match(report, /curl-pipe-shell/);
  assert.match(report, /install\.sh:4/);
  assert.match(report, /Downloaded source is executed immediately/);
  assert.match(report, /Remove the download-and-execute path/);
  assert.match(report, /Only a later `passed` baseline can produce `Verified`/);
  assert.doesNotMatch(report, /\bapproval\b|\bapprove\b|maintainer review/i);

  const capabilityReport = buildVerificationReport({
    status: "unverified",
    request,
    baseline: storedBaseline({
      outcome: "review-required",
      capabilities: ["service-management"],
    }),
    scanResult: baseline({
      outcome: "review-required",
      capabilities: [{
        id: "service-management",
        title: "Service management",
        why: "The plugin controls a service.",
        evidence: [{ path: "service.sh", line: 2, snippet: "systemctl --user restart example" }],
      }],
    }),
  });
  assert.match(capabilityReport, /cannot produce `Verified`/);
  assert.doesNotMatch(capabilityReport, /\bapproval\b|\bapprove\b|maintainer review/i);
});

test("verification reports state the exact-commit boundary and required disclaimer", () => {
  const request = parseVerificationRequest(requestBody());
  const verified = buildVerificationReport({
    status: "verified",
    request,
    baseline: storedBaseline(),
  });
  assert.match(verified, /✅ \*\*Verified\*\*/);
  assert.match(verified, /exact listed commit/);
  assert.match(verified, /not a security audit, certification, warranty, or endorsement/);

  const unverified = buildVerificationReport({
    status: "unverified",
    request,
    baseline: storedBaseline({ outcome: "review-required", capabilities: ["service-management"] }),
  });
  assert.match(unverified, /⚪ \*\*Unverified\*\*/);
  assert.match(unverified, /review-required/);
});

test("verification issue, workflow, and documentation preserve automatic publication safeguards", async () => {
  const root = new URL("../", import.meta.url);
  const [form, workflow, guide, policy, readme, submissionGuide] = await Promise.all([
    readFile(new URL(".github/ISSUE_TEMPLATE/verify-plugin.yml", root), "utf8"),
    readFile(new URL(".github/workflows/verify-plugin.yml", root), "utf8"),
    readFile(new URL("VERIFICATION.md", root), "utf8"),
    readFile(new URL("SECURITY.md", root), "utf8"),
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("SUBMISSION.md", root), "utf8"),
  ]);
  const readmeNavSpecs = [
    { name: "develop.png", sourceWidth: 416, sourceHeight: 160, displayWidth: 104 },
    { name: "submit.png", sourceWidth: 704, sourceHeight: 160, displayWidth: 176 },
    { name: "verify.png", sourceWidth: 1360, sourceHeight: 160, displayWidth: 340 },
  ];
  const readmeNavAssets = await Promise.all(readmeNavSpecs.map(({ name }) => (
    readFile(new URL(`site/assets/img/readme-nav/${name}`, root))
  )));
  const readmeTagline = await readFile(new URL("site/assets/img/readme-tagline.png", root));
  const readmePreview = await readFile(new URL("preview.png", root));

  for (const asset of [...readmeNavAssets, readmeTagline, readmePreview]) {
    assert.equal(asset.subarray(1, 4).toString("ascii"), "PNG");
  }
  for (const [index, asset] of readmeNavAssets.entries()) {
    const spec = readmeNavSpecs[index];
    assert.deepEqual(
      [asset.readUInt32BE(16), asset.readUInt32BE(20)],
      [spec.sourceWidth, spec.sourceHeight],
      spec.name,
    );
    assert.match(
      readme,
      new RegExp(`readme-nav/${spec.name.replace(".", "\\.")}"[^>]*width="${spec.displayWidth}"`),
      spec.name,
    );
  }
  assert.deepEqual(
    [readmeTagline.readUInt32BE(16), readmeTagline.readUInt32BE(20)],
    [1320, 72],
  );
  assert.deepEqual(
    [readmePreview.readUInt32BE(16), readmePreview.readUInt32BE(20)],
    [1153, 699],
  );

  assert.match(form, /name: Request plugin verification/);
  assert.match(form, /label: Plugin ID[\s\S]*label: Repository URL[\s\S]*label: Listed commit/);
  assert.match(form, new RegExp(verificationAcknowledgment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(workflow, /types: \[opened, edited, reopened\]/);
  assert.match(workflow, /group: \$\{\{ startsWith[\s\S]*'plugin-catalog-writes'/);
  assert.match(workflow, /permissions:\s+contents: read\s+issues: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci[\s\S]*node scripts\/verify-listed-plugin\.mjs/);
  assert.equal((workflow.match(/run: npm test/g) || []).length, 1);
  assert.match(workflow, /npm test[\s\S]*actions\/upload-pages-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /sha256sum --check SHA256SUMS/);
  assert.match(workflow, /permissions:\s+actions: read\s+contents: write\s+issues: read/);
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:\n"), workflow.indexOf("\n  deploy:\n"));
  assert.doesNotMatch(publishJob, /setup-node|npm ci|npm test|node scripts\//);
  assert.match(publishJob, /git fetch origin main[\s\S]*EXPECTED_BASE_COMMIT/);
  assert.match(publishJob, /main changed after the tested verification; refusing to rebase/);
  assert.match(workflow, /git ls-remote[\s\S]*refusing to deploy an older verification artifact/);
  assert.match(workflow, /<!-- marketplace-plugin-verification -->/);
  assert.doesNotMatch(workflow, /personal access token|\bPAT\b/);

  for (const document of [guide, policy]) {
    assert.match(document, /exact (?:listed commit|`listingValidatedCommit`)/i);
    assert.match(document, /not a security audit/i);
    assert.match(document, /Unverified/);
  }
  const requestUrl = "https://github.com/HANCORE-linux/omarchy-plugin-marketplace/issues/new?template=verify-plugin.yml";
  assert.match(guide, new RegExp(requestUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(readme, new RegExp(requestUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(submissionGuide, new RegExp(requestUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(readme, /<p><a[\s\S]*readme-tagline\.png[\s\S]*<\/a><\/p>/);
  assert.doesNotMatch(readme, /<h1>|readme-header\.png|omarchy-wordmark\.png|<img[^>]+\sheight="/);
  assert.match(readme, /readme-tagline\.png" alt="Browse and discover community plugins for Omarchy at omarchyplugins\.com\." width="660"/);
  assert.match(readme, /readme-nav\/develop\.png[\s\S]*readme-nav\/submit\.png[\s\S]*readme-nav\/verify\.png/);
  assert.doesNotMatch(readme, /readme-nav\/(?:browse|contribute)\.png|<kbd>/);
  assert.match(readme, /issues\/new\?template=submit-plugin\.yml/);
  assert.match(readme, /^## Request Automated Plugin Verification$/m);
  assert.doesNotMatch(readme, /neur0map|ryoku-arch/i);
  assert.match(guide, /manual override/i);
  assert.match(guide, /Neither status uses a checkmark or separator/);
  assert.match(guide, /If an installation command obtains a different upstream commit/);
});
