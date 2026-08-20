import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inspectListedPluginSource } from "../scripts/build-catalog.mjs";
import {
  assertPluginUpdateInspection,
  buildPluginUpdateValidationReport,
  listingValidationHistoryEntry,
  parsePluginUpdateRequest,
  pluginUpdateAcknowledgment,
  PluginUpdateError,
  promotePluginUpdateSource,
  publicPluginUpdateFailure,
  replacePluginUpdateSource,
  resolvePluginUpdate,
} from "../scripts/plugin-update.mjs";
import {
  securityBaselineEnforcementMode,
  securityBaselineVersion,
} from "../scripts/security-baseline-policy.mjs";
import { buildSecurityBaselineDetails } from "../scripts/security-baseline-report.mjs";
import { sourceVerification } from "../scripts/verification-status.mjs";

const oldCommit = "a".repeat(40);
const updateCommit = "b".repeat(40);
const oldCheckedAt = "2026-08-18T10:00:00.000Z";
const promotedAt = "2026-08-20T10:00:00.000Z";

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
    "### Update commit",
    "",
    overrides.commitSha || updateCommit,
    "",
    "### Update acknowledgment",
    "",
    overrides.acknowledgment || `- [x] ${pluginUpdateAcknowledgment}`,
  ].join("\n");
}

function storedBaseline(commit = oldCommit, overrides = {}) {
  return {
    schemaVersion: 1,
    version: securityBaselineVersion,
    repository: "example/plugin",
    pluginIds: ["example.plugin"],
    commit,
    checkedAt: commit === oldCommit ? oldCheckedAt : promotedAt,
    outcome: "passed",
    enforcementMode: securityBaselineEnforcementMode,
    findings: [],
    capabilities: [],
    ...overrides,
  };
}

function listedSource(overrides = {}) {
  return {
    repo: "https://github.com/example/plugin",
    type: "plugin-source",
    addedAt: "2026-08-18",
    listedAt: "2026-08-18T10:00:00.000Z",
    listingValidatedCommit: oldCommit,
    listingValidatedAt: "2026-08-18T10:00:00.000Z",
    listingValidatedBranch: "main",
    automatedSecurityBaseline: storedBaseline(),
    plugins: {
      "example.plugin": { category: "System", tags: ["system"] },
    },
    ...overrides,
  };
}

function updateInspection(overrides = {}) {
  return {
    repository: "example/plugin",
    defaultBranch: "main",
    commitSha: updateCommit,
    treeSha: "c".repeat(40),
    manifests: [{
      path: "manifest.json",
      id: "example.plugin",
      name: "Example Plugin",
      version: "2.0.0",
      entryPoints: ["Main.qml"],
    }],
    ...overrides,
  };
}

test("plugin update requests require the exact issue-form contract", () => {
  assert.deepEqual(parsePluginUpdateRequest(requestBody()), {
    pluginId: "example.plugin",
    repository: "example/plugin",
    repoUrl: "https://github.com/example/plugin",
    commitSha: updateCommit,
  });
  assert.throws(
    () => parsePluginUpdateRequest(requestBody({ commitSha: "abc" })),
    (error) => error instanceof PluginUpdateError && error.code === "update-commit-invalid",
  );
  assert.throws(
    () => parsePluginUpdateRequest(requestBody({ acknowledgment: "- [ ] no" })),
    (error) => error instanceof PluginUpdateError
      && error.code === "update-acknowledgment-missing",
  );
  assert.throws(
    () => parsePluginUpdateRequest(requestBody().replace("### Update commit", "### Commit")),
    (error) => error instanceof PluginUpdateError && error.code === "update-fields-invalid",
  );
});

test("plugin updates bind repository HEAD and the complete configured plugin set", () => {
  const request = parsePluginUpdateRequest(requestBody());
  const source = listedSource();
  const registry = { sources: [source] };
  const subject = resolvePluginUpdate(registry, request, updateInspection());
  assert.equal(subject.source, source);
  assert.deepEqual(subject.pluginIds, ["example.plugin"]);
  assert.throws(
    () => assertPluginUpdateInspection(
      request,
      source,
      updateInspection({ commitSha: "d".repeat(40) }),
    ),
    (error) => error.code === "update-upstream-changed",
  );
  assert.throws(
    () => assertPluginUpdateInspection(
      request,
      source,
      updateInspection({ manifests: [
        ...updateInspection().manifests,
        { id: "example.extra", path: "extra/manifest.json" },
      ] }),
    ),
    (error) => error.code === "update-plugin-set-changed",
  );
  assert.throws(
    () => resolvePluginUpdate(
      { sources: [listedSource({ listingValidatedCommit: updateCommit })] },
      request,
      updateInspection(),
    ),
    (error) => error.code === "update-already-current",
  );
});

test("verified update promotion preserves prior evidence and atomically replaces the snapshot", () => {
  const source = listedSource();
  const nextSource = promotePluginUpdateSource(source, updateInspection(), {
    automatedSecurityBaseline: storedBaseline(updateCommit),
    promotedAt,
  });
  assert.equal(nextSource.listingValidatedCommit, updateCommit);
  assert.equal(nextSource.listingValidatedAt, promotedAt);
  assert.equal(nextSource.listingValidatedBranch, "main");
  assert.equal(nextSource.automatedSecurityBaseline.commit, updateCommit);
  assert.equal(nextSource.maintainerVerificationReview, undefined);
  assert.deepEqual(nextSource.listingValidationHistory, [
    listingValidationHistoryEntry(source, promotedAt),
  ]);
  assert.equal(
    nextSource.listingValidationHistory[0].automatedSecurityBaseline,
    source.automatedSecurityBaseline,
  );
  assert.equal(sourceVerification(nextSource).status, "verified");

  const registry = { sources: [source], retiredPluginIds: [] };
  const nextRegistry = replacePluginUpdateSource(registry, source, nextSource);
  assert.equal(nextRegistry.sources[0], nextSource);
  assert.deepEqual(nextRegistry.retiredPluginIds, []);
  assert.equal(registry.sources[0], source);
});

test("plugin update promotion rejects unverified or same-commit evidence", () => {
  assert.throws(
    () => promotePluginUpdateSource(listedSource(), updateInspection(), {
      automatedSecurityBaseline: storedBaseline(updateCommit, {
        outcome: "needs-fixes",
        findings: ["remote-download-execution"],
      }),
      promotedAt,
    }),
    (error) => error.code === "update-verification-invalid",
  );
  assert.throws(
    () => promotePluginUpdateSource(
      listedSource({ listingValidatedCommit: updateCommit }),
      updateInspection(),
      { automatedSecurityBaseline: storedBaseline(updateCommit), promotedAt },
    ),
    (error) => error.code === "update-already-current",
  );
});

test("listed-source inspection reads current HEAD without executing community code", async () => {
  const source = listedSource();
  const treeSha = "c".repeat(40);
  const manifest = {
    schemaVersion: 1,
    id: "example.plugin",
    name: "Example Plugin",
    version: "2.0.0",
    author: "Example",
    description: "Example update",
    license: "MIT",
    kinds: ["service"],
    entryPoints: { service: "Main.qml" },
  };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.github.com/repos/example/plugin") {
      return new Response(JSON.stringify({
        private: false,
        disabled: false,
        archived: false,
        default_branch: "main",
      }), { status: 200 });
    }
    if (url === "https://api.github.com/repos/example/plugin/commits/main") {
      return new Response(JSON.stringify({
        sha: updateCommit,
        commit: { tree: { sha: treeSha } },
      }), { status: 200 });
    }
    if (url === `https://api.github.com/repos/example/plugin/git/trees/${treeSha}?recursive=1`) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644", size: 300 },
          { path: "Main.qml", type: "blob", mode: "100644", size: 20 },
        ],
      }), { status: 200 });
    }
    if (url === `https://raw.githubusercontent.com/example/plugin/${updateCommit}/manifest.json`) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(JSON.stringify(manifest))) },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const inspection = await inspectListedPluginSource(source);
    assert.equal(inspection.commitSha, updateCommit);
    assert.deepEqual(inspection.manifests.map((item) => item.id), ["example.plugin"]);
    assert.equal(requests.some((url) => url.includes("actions") || url.includes("workflows")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin update reports are exact-commit, actionable, and fail closed", () => {
  const request = parsePluginUpdateRequest(requestBody());
  const report = buildPluginUpdateValidationReport({
    ...assertPluginUpdateInspection(request, listedSource(), updateInspection()),
    request,
  });
  assert.match(report, /marketplace-update-validation/);
  assert.match(report, /Ready for verified update review/);
  assert.match(report, new RegExp(updateCommit.slice(0, 7)));
  assert.match(
    buildSecurityBaselineDetails({
      commitSha: updateCommit,
      outcome: "needs-fixes",
      findings: [{
        title: "Finding",
        ruleId: "finding",
        why: "Why",
        evidence: [{ path: "Main.qml", line: 1, snippet: "bad" }],
        actions: ["Fix it"],
      }],
    }, { context: "update" }),
    /selectively blocking findings that cannot be accepted through `approved-and-verified`/,
  );
  assert.equal(
    publicPluginUpdateFailure({ code: "update-plugin-set-changed" }).code,
    "update-plugin-set-changed",
  );
});

test("plugin update workflows preserve read-only analysis and atomic publication boundaries", async () => {
  const root = new URL("../", import.meta.url);
  const [validation, approval, updateScript, validationScript, baselineCli, issueForm] = await Promise.all([
    readFile(new URL(".github/workflows/validate-plugin-update.yml", root), "utf8"),
    readFile(new URL(".github/workflows/approve-submission.yml", root), "utf8"),
    readFile(new URL("scripts/approve-plugin-update.mjs", root), "utf8"),
    readFile(new URL("scripts/validate-plugin-update.mjs", root), "utf8"),
    readFile(new URL("scripts/security-baseline.mjs", root), "utf8"),
    readFile(new URL(".github/ISSUE_TEMPLATE/update-plugin.yml", root), "utf8"),
  ]);
  assert.match(validation, /types: \[opened, edited, reopened\]/);
  assert.match(validation, /group:.*plugin-catalog-writes/);
  assert.match(validation, /permissions:\s+contents: read\s+issues: read/);
  assert.match(validation, /npm ci[\s\S]*validate-plugin-update\.mjs[\s\S]*security-baseline\.mjs/);
  assert.match(validation, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(validation, /actions\/download-artifact@[a-f0-9]{40}/);
  assert.equal((validation.match(/GH_REPO: \$\{\{ github\.repository \}\}/g) || []).length, 2);
  assert.match(validation, /sha256sum --check SHA256SUMS/);
  assert.match(validation, /remove_label approved-and-verified/);
  assert.match(validation, /\.verifiedPublicationDisposition/);
  assert.doesNotMatch(validation, /contents: write|push origin/);

  assert.match(approval, /contains\(github\.event\.issue\.labels\.\*\.name, 'plugin-update'\)/);
  assert.match(approval, /node scripts\/approve-plugin-update\.mjs/);
  assert.match(approval, /PUBLICATION_KIND[\s\S]*Update \$\{PLUGIN_NAME\} plugin/);
  assert.match(approval, /required_type_label=plugin-update/);
  assert.match(updateScript, /runSecurityBaseline[\s\S]*listedPlugins:[\s\S]*manifestPathHint: manifest\.path[\s\S]*createApprovedVerificationEvidence/);
  assert.match(validationScript, /listedPlugins:[\s\S]*pluginId: manifest\.id[\s\S]*manifestPathHint: manifest\.path/);
  assert.match(baselineCli, /listedPlugins: metadata\.listedPlugins/);
  assert.match(updateScript, /promotePluginUpdateSource[\s\S]*replacePluginUpdateSource/);
  assert.match(updateScript, /expectedBaselineCommentId[\s\S]*allowCurrentCommit: true/);
  assert.doesNotMatch(updateScript, /child_process|exec\(|spawn\(|shell:/);

  assert.match(issueForm, /title: "\[Update\]: "/);
  assert.match(issueForm, /label: Update commit/);
  assert.match(issueForm, new RegExp(pluginUpdateAcknowledgment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
