import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApprovedSecurityBaseline } from "../scripts/approve-submission.mjs";
import {
  checkCommitBinding,
  parseSecurityBaselineMarker,
  SecurityBaselineError,
} from "../scripts/security-baseline.mjs";
import {
  currentSecurityBaselinePolicy,
  securityBaselineDisposition,
  securityBaselineEligibleForMaintainerVerification,
  securityBaselineEligibleForVerifiedListing,
  securityBaselineErrorMarker,
  securityBaselineMarkerPrefix,
  securityBaselineMarkerProtocolVersion,
  securityBaselineVersion,
} from "../scripts/security-baseline-policy.mjs";
import {
  parseStoredSecurityBaselineRecord,
  toStoredSecurityBaselineRecord,
} from "../scripts/security-baseline-record.mjs";
import { verificationBaselineRecord } from "../scripts/plugin-verification.mjs";
import {
  createMaintainerVerificationReview,
  parseMaintainerVerificationReview,
} from "../scripts/verification-review.mjs";

const commit = "a".repeat(40);
const checkedAt = "2026-08-16T12:00:00.000Z";

function passingResult() {
  return {
    schemaVersion: 1,
    baselineVersion: securityBaselineVersion,
    repository: "example/plugin",
    repoUrl: "https://github.com/example/plugin",
    commitSha: commit,
    checkedAt,
    outcome: "passed",
    enforcementMode: currentSecurityBaselinePolicy.enforcementMode,
    findings: [],
    capabilities: [],
    pluginIds: ["example.plugin"],
  };
}

function source() {
  return {
    repo: "https://github.com/example/plugin",
    type: "plugin-source",
    listingValidatedCommit: commit,
    plugins: { "example.plugin": {} },
  };
}

test("security policy owns marker protocol and label disposition", () => {
  assert.equal(
    securityBaselineMarkerPrefix,
    `<!-- marketplace-security-baseline:v${securityBaselineMarkerProtocolVersion} `,
  );
  assert.equal(
    securityBaselineErrorMarker,
    `<!-- marketplace-security-baseline-error:v${securityBaselineMarkerProtocolVersion} -->`,
  );
  assert.equal(securityBaselineDisposition({
    outcome: "passed",
    enforcementMode: currentSecurityBaselinePolicy.enforcementMode,
    findings: [],
    capabilities: [],
  }), "clear");
  assert.equal(securityBaselineDisposition({
    outcome: "needs-fixes",
    enforcementMode: currentSecurityBaselinePolicy.enforcementMode,
    findings: ["sudoers-dangerous-passwordless-command"],
    capabilities: [],
  }), "needs-fixes");
  assert.equal(securityBaselineDisposition({
    outcome: "needs-fixes",
    enforcementMode: currentSecurityBaselinePolicy.enforcementMode,
    findings: ["curl-pipe-shell"],
    capabilities: [],
  }), "review-required");
  const eligibleReview = {
    version: securityBaselineVersion,
    outcome: "review-required",
    enforcementMode: currentSecurityBaselinePolicy.enforcementMode,
    findings: [],
    capabilities: ["privilege"],
  };
  assert.equal(currentSecurityBaselinePolicy.verifiedListingRequired, true);
  assert.equal(securityBaselineEligibleForMaintainerVerification(eligibleReview), true);
  assert.equal(securityBaselineEligibleForVerifiedListing(eligibleReview), true);
  assert.equal(securityBaselineEligibleForVerifiedListing({
    version: securityBaselineVersion,
    outcome: "needs-fixes",
    enforcementMode: currentSecurityBaselinePolicy.enforcementMode,
    findings: ["curl-pipe-shell"],
    capabilities: [],
  }), true);
  for (const value of [
    { outcome: "passed", findings: [], capabilities: [] },
    { outcome: "needs-fixes", findings: ["curl-pipe-shell"], capabilities: [] },
    { outcome: "review-required", findings: [], capabilities: ["privilege"], version: "999" },
  ]) {
    assert.equal(securityBaselineEligibleForMaintainerVerification({
      version: securityBaselineVersion,
      enforcementMode: currentSecurityBaselinePolicy.enforcementMode,
      ...value,
    }), false);
  }
});

test("approval and verification persist one canonical baseline record", () => {
  const options = {
    expectedRepository: "example/plugin",
    expectedCommit: commit,
    pluginIds: ["example.plugin"],
  };
  const canonical = toStoredSecurityBaselineRecord(passingResult(), options);
  const approved = createApprovedSecurityBaseline(passingResult(), options);
  const verified = verificationBaselineRecord(passingResult(), source());
  assert.deepEqual(approved, canonical);
  assert.deepEqual(verified, canonical);
  assert.deepEqual(canonical, {
    schemaVersion: 1,
    version: securityBaselineVersion,
    repository: "example/plugin",
    pluginIds: ["example.plugin"],
    commit,
    checkedAt,
    outcome: "passed",
    enforcementMode: currentSecurityBaselinePolicy.enforcementMode,
    findings: [],
    capabilities: [],
  });
});

test("maintainer verification review is separate from canonical automated facts", () => {
  const baseline = toStoredSecurityBaselineRecord({
    ...passingResult(),
    outcome: "review-required",
    capabilities: [{ id: "privilege" }],
  }, {
    expectedRepository: "example/plugin",
    expectedCommit: commit,
    pluginIds: ["example.plugin"],
  });
  const reviewedBaseline = {
    ...baseline,
    checkedAt: "2026-08-16T11:00:00.000Z",
  };
  const review = createMaintainerVerificationReview(baseline, {
    reviewedBaseline,
    reviewer: "hancore",
    requestEventId: 44001,
    requestedAt: "2026-08-16T11:30:00.000Z",
    reviewedAt: "2026-08-16T13:00:00.000Z",
  });
  assert.equal(review.baselineOutcome, "review-required");
  assert.equal(review.requestEventId, 44001);
  assert.equal(review.reviewedBaselineCheckedAt, reviewedBaseline.checkedAt);
  assert.deepEqual(review.findings, []);
  assert.deepEqual(review.capabilities, ["privilege"]);
  assert.deepEqual(parseMaintainerVerificationReview(review, baseline), review);
  assert.equal(parseMaintainerVerificationReview({ ...review, commit: "b".repeat(40) }, baseline), null);
});

test("current stored-record schema requires repository and plugin identity", () => {
  assert.throws(
    () => toStoredSecurityBaselineRecord(passingResult()),
    (error) => error.code === "security-baseline-record-invalid",
  );
  assert.throws(
    () => toStoredSecurityBaselineRecord({
      ...passingResult(),
      pluginIds: ["other.plugin"],
    }, {
      expectedRepository: "example/plugin",
      expectedCommit: commit,
      pluginIds: ["example.plugin"],
    }),
    (error) => error.code === "security-baseline-record-invalid",
  );
});

test("legacy records require source attachment and hydrate into stable current records", () => {
  const canonical = toStoredSecurityBaselineRecord(passingResult(), {
    expectedRepository: "example/plugin",
    expectedCommit: commit,
    pluginIds: ["example.plugin"],
  });
  const {
    schemaVersion,
    repository,
    pluginIds,
    ...legacy
  } = canonical;
  assert.equal(parseStoredSecurityBaselineRecord(legacy), null);
  const hydrated = parseStoredSecurityBaselineRecord(legacy, {
    expectedRepository: "example/plugin",
    expectedCommit: commit,
    pluginIds: ["example.plugin"],
  });
  assert.deepEqual(hydrated, canonical);
  assert.deepEqual(parseStoredSecurityBaselineRecord(hydrated), canonical);
});

test("security dependency direction keeps domain and approval free of catalog and scanner infrastructure", async () => {
  const root = new URL("../", import.meta.url);
  const files = Object.fromEntries(await Promise.all([
    "scripts/github-repository.mjs",
    "scripts/security-baseline-policy.mjs",
    "scripts/security-baseline-error.mjs",
    "scripts/security-baseline-limits.mjs",
    "scripts/security-baseline-record.mjs",
    "scripts/security-github-snapshot.mjs",
    "scripts/security-baseline-scope.mjs",
    "scripts/security-baseline-analysis.mjs",
    "scripts/security-baseline-approval.mjs",
    "scripts/verification-status.mjs",
    "scripts/verification-review.mjs",
    "scripts/catalog-verification.mjs",
    "scripts/verification-subject.mjs",
    "scripts/plugin-verification.mjs",
    "scripts/security-baseline-scanner.mjs",
    "scripts/security-baseline.mjs",
  ].map(async (path) => [path, await readFile(new URL(path, root), "utf8")])));

  for (const path of [
    "scripts/github-repository.mjs",
    "scripts/security-baseline-policy.mjs",
    "scripts/security-baseline-error.mjs",
    "scripts/security-baseline-limits.mjs",
    "scripts/security-baseline-record.mjs",
    "scripts/security-github-snapshot.mjs",
    "scripts/security-baseline-scope.mjs",
    "scripts/security-baseline-analysis.mjs",
    "scripts/security-baseline-approval.mjs",
    "scripts/verification-status.mjs",
    "scripts/verification-review.mjs",
    "scripts/catalog-verification.mjs",
    "scripts/verification-subject.mjs",
    "scripts/plugin-verification.mjs",
  ]) {
    assert.doesNotMatch(files[path], /node:fs|\bsharp\b|build-catalog\.mjs/);
  }
  assert.doesNotMatch(files["scripts/security-baseline-scanner.mjs"], /node:fs|\bsharp\b|build-catalog\.mjs/);
  assert.match(files["scripts/security-baseline-scanner.mjs"], /from "\.\/security-baseline-analysis\.mjs"/);
  assert.match(files["scripts/security-baseline-scanner.mjs"], /from "\.\/security-baseline-scope\.mjs"/);
  assert.match(files["scripts/security-baseline-scope.mjs"], /from "\.\/security-github-snapshot\.mjs"/);
  assert.doesNotMatch(files["scripts/security-baseline-approval.mjs"], /security-baseline-scanner/);
  assert.match(files["scripts/security-baseline.mjs"], /export \* from "\.\/security-baseline-scanner\.mjs"/);
  assert.ok(files["scripts/security-baseline.mjs"].split("\n").length < 80);
});

test("security facade preserves the common error contract", () => {
  assert.throws(
    () => checkCommitBinding(commit, "b".repeat(40)),
    (error) => error instanceof SecurityBaselineError && error.code === "approval-upstream-changed",
  );
  assert.throws(
    () => parseSecurityBaselineMarker(`${securityBaselineMarkerPrefix}bm90LWpzb24 -->`),
    (error) => error instanceof SecurityBaselineError && error.code === "approval-security-baseline-invalid",
  );
});

test("validation workflow consumes verified publication policy instead of reconstructing enforcement", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/validate-submission.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /jq -r '\.verifiedPublicationDisposition'/);
  assert.match(workflow, /BASELINE_DISPOSITION/);
  assert.doesNotMatch(workflow, /BASELINE_BLOCKS_APPROVAL|baseline_blocks_approval|passed\) disposition=/);
  assert.match(workflow, /marketplace-security-baseline:v\[0-9\]\+/);
});
