import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSecurityBaseline } from "../scripts/security-baseline-analysis.mjs";
import {
  securityBaselineBlocksApproval,
  securityBaselineCapabilityCatalog,
  securityBaselineEnforcementMode,
  securityBaselineOutcome,
  securityBaselineRuleCatalog,
  securityBaselineVersion,
} from "../scripts/security-baseline-policy.mjs";

const corpusUrl = new URL("./fixtures/security-baseline-v4/corpus.json", import.meta.url);
const planUrl = new URL("./fixtures/security-baseline-v4/BACKTEST_PLAN.md", import.meta.url);
const checkedAt = "2026-08-16T12:00:00.000Z";
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const commitPattern = /^[a-f0-9]{40}$/;
const caseIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const classifications = new Set([
  "boundary",
  "candidate-negative",
  "candidate-positive",
  "complexity",
  "coverage-decision",
  "known-v3-false-positive",
]);
const expectedCaseIds = Object.freeze([
  "bounded-control-flow-complexity",
  "control-flow-keeps-shared-temp-possibility",
  "control-flow-overwrites-shared-temp-path",
  "heredoc-command-text-is-not-executed",
  "issue-122-non-shell-shared-temp-state",
  "issue-146-shared-temp-shell-state",
  "negated-readme-shared-temp-prose",
  "normalized-path-escapes-shared-tmp",
  "normalized-path-remains-under-shared-tmp",
  "quoted-shared-temp-path-write",
  "quoted-shared-temp-prose",
  "var-tmp-is-outside-shared-tmp-scope",
]);

function assertExactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}

function assertUniqueStrings(values, label) {
  assert.ok(Array.isArray(values) && values.length > 0, label);
  assert.ok(values.every((value) => typeof value === "string" && value.trim() === value && value), label);
  assert.equal(new Set(values).size, values.length, label);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function readCorpus() {
  return JSON.parse(await readFile(corpusUrl, "utf8"));
}

function resultSummary(result) {
  return {
    outcome: result.outcome,
    findings: result.findings.map((finding) => finding.ruleId),
    capabilities: result.capabilities.map((capability) => capability.id),
    blocksApproval: result.blocksApproval,
  };
}

function validateProvenance(provenance, entry) {
  assert.equal(typeof provenance, "object", entry.id);
  if (provenance.kind === "synthetic-reproduction") {
    assertExactKeys(provenance, ["kind"], `${entry.id} synthetic provenance`);
    return;
  }
  assert.equal(provenance.kind, "issue-derived-minimal-reproduction", entry.id);
  assertExactKeys(
    provenance,
    ["kind", "marketplaceIssue", "repository", "commitSha", "sourcePaths"],
    `${entry.id} issue provenance`,
  );
  assert.ok(Number.isSafeInteger(provenance.marketplaceIssue) && provenance.marketplaceIssue > 0, entry.id);
  assert.match(provenance.repository, repositoryPattern, entry.id);
  assert.match(provenance.commitSha, commitPattern, entry.id);
  assertUniqueStrings(provenance.sourcePaths, `${entry.id} source paths`);
  assert.equal(provenance.repository, entry.snapshot.repository, entry.id);
  assert.equal(provenance.commitSha, entry.snapshot.commitSha, entry.id);
}

function validateFindingCommentary(entry) {
  const hasCommentary = Object.hasOwn(entry, "findingCommentary");
  if (!hasCommentary) {
    assert.notEqual(entry.classification, "known-v3-false-positive", entry.id);
    return;
  }
  assert.ok(entry.expectedV3.findings.length > 0, entry.id);
  assert.ok(Array.isArray(entry.findingCommentary) && entry.findingCommentary.length > 0, entry.id);
  const commentaryIds = entry.findingCommentary.map(({ ruleId }) => ruleId);
  assert.equal(new Set(commentaryIds).size, commentaryIds.length, entry.id);
  assert.ok(commentaryIds.every((ruleId) => entry.expectedV3.findings.includes(ruleId)), entry.id);
  for (const commentary of entry.findingCommentary) {
    assertExactKeys(commentary, ["ruleId", "submitter", "maintainer"], `${entry.id} finding commentary`);
    assert.ok(Object.hasOwn(securityBaselineRuleCatalog, commentary.ruleId), entry.id);
    assert.ok(typeof commentary.submitter === "string" && commentary.submitter.length > 20, entry.id);
    assert.ok(typeof commentary.maintainer === "string" && commentary.maintainer.length > 20, entry.id);
  }
}

function validateExpectedV3(expected, entry) {
  assertExactKeys(
    expected,
    ["outcome", "findings", "capabilities", "blocksApproval"],
    `${entry.id} expected V3`,
  );
  assert.ok(["passed", "review-required", "needs-fixes"].includes(expected.outcome), entry.id);
  assert.ok(Array.isArray(expected.findings), entry.id);
  assert.ok(Array.isArray(expected.capabilities), entry.id);
  assert.equal(new Set(expected.findings).size, expected.findings.length, entry.id);
  assert.equal(new Set(expected.capabilities).size, expected.capabilities.length, entry.id);
  assert.ok(expected.findings.every((id) => Object.hasOwn(securityBaselineRuleCatalog, id)), entry.id);
  assert.ok(expected.capabilities.every((id) => Object.hasOwn(securityBaselineCapabilityCatalog, id)), entry.id);
  assert.equal(expected.outcome, securityBaselineOutcome(expected.findings, expected.capabilities), entry.id);
  assert.equal(typeof expected.blocksApproval, "boolean", entry.id);
  assert.equal(securityBaselineBlocksApproval({
    outcome: expected.outcome,
    enforcementMode: securityBaselineEnforcementMode,
    findings: expected.findings,
    capabilities: expected.capabilities,
  }), expected.blocksApproval, entry.id);
}

test("the V4 foundation corpus is inert, bounded, and structurally valid", async () => {
  const raw = await readFile(corpusUrl, "utf8");
  assert.ok(Buffer.byteLength(raw) < 128 * 1024);
  const corpus = JSON.parse(raw);
  assertExactKeys(
    corpus,
    [
      "schemaVersion",
      "description",
      "characterizedBaselineVersion",
      "characterizedEnforcementMode",
      "cases",
    ],
    "corpus schema",
  );
  assert.equal(corpus.schemaVersion, 1);
  assert.match(corpus.description, /inert offline V3 characterization/i);
  assert.match(corpus.description, /must never be executed/i);
  assert.equal(corpus.characterizedBaselineVersion, securityBaselineVersion);
  assert.equal(corpus.characterizedEnforcementMode, securityBaselineEnforcementMode);
  assert.ok(Array.isArray(corpus.cases));
  assert.deepEqual(corpus.cases.map((entry) => entry.id).sort(), [...expectedCaseIds]);
  assert.equal(new Set(corpus.cases.map((entry) => entry.id)).size, corpus.cases.length);

  for (const entry of corpus.cases) {
    const expectedEntryKeys = [
      "id",
      "classification",
      "coverage",
      "provenance",
      "snapshot",
      "expectedV3",
      ...(Object.hasOwn(entry, "findingCommentary") ? ["findingCommentary"] : []),
    ];
    assertExactKeys(entry, expectedEntryKeys, `${entry.id || "case"} schema`);
    assert.match(entry.id, caseIdPattern);
    assert.ok(classifications.has(entry.classification), entry.id);
    assertUniqueStrings(entry.coverage, `${entry.id} coverage`);
    assertExactKeys(entry.snapshot, ["repository", "commitSha", "files"], `${entry.id} snapshot`);
    assert.match(entry.snapshot.repository, repositoryPattern, entry.id);
    assert.match(entry.snapshot.commitSha, commitPattern, entry.id);
    assert.ok(Array.isArray(entry.snapshot.files) && entry.snapshot.files.length > 0, entry.id);
    assert.ok(entry.snapshot.files.length <= 8, entry.id);
    assert.ok(
      entry.snapshot.files.reduce((total, file) => total + Buffer.byteLength(file.content || ""), 0) < 64 * 1024,
      entry.id,
    );
    const paths = new Set();
    for (const fixtureFile of entry.snapshot.files) {
      assertExactKeys(fixtureFile, ["path", "mode", "content"], `${entry.id} fixture file`);
      assert.equal(typeof fixtureFile.path, "string", entry.id);
      assert.ok(fixtureFile.path && !fixtureFile.path.startsWith("/"), entry.id);
      assert.ok(!fixtureFile.path.split("/").includes(".."), entry.id);
      assert.doesNotMatch(fixtureFile.path, /[\\\0]/, entry.id);
      assert.ok(["100644", "100755"].includes(fixtureFile.mode), entry.id);
      assert.equal(typeof fixtureFile.content, "string", entry.id);
      assert.equal(paths.has(fixtureFile.path), false, entry.id);
      paths.add(fixtureFile.path);
    }
    validateProvenance(entry.provenance, entry);
    validateExpectedV3(entry.expectedV3, entry);
    validateFindingCommentary(entry);
  }
});

test("the V4 foundation corpus preserves current modular V3 outcomes", async () => {
  const corpus = await readCorpus();
  for (const entry of corpus.cases) {
    const files = deepFreeze(structuredClone(entry.snapshot.files));
    const before = structuredClone(files);
    const result = buildSecurityBaseline({
      repository: entry.snapshot.repository,
      repoUrl: `https://github.com/${entry.snapshot.repository}`,
      commitSha: entry.snapshot.commitSha,
      files,
    }, { checkedAt });
    assert.deepEqual(resultSummary(result), entry.expectedV3, entry.id);
    assert.deepEqual(files, before, `${entry.id} input mutation`);
    assert.equal(result.baselineVersion, securityBaselineVersion, entry.id);
    assert.equal(result.enforcementMode, securityBaselineEnforcementMode, entry.id);
  }
});

test("the V4 offline backtest plan preserves analysis and acquisition boundaries", async () => {
  const plan = await readFile(planUrl, "utf8");
  assert.match(plan, /Status: foundation only/);
  assert.match(plan, /Never import, source, evaluate, spawn, or otherwise execute those bytes/);
  assert.match(plan, /require explicit maintainer approval before any live corpus acquisition/);
  assert.match(plan, /pure `buildSecurityBaseline` input contract from `security-baseline-analysis\.mjs`/);
  assert.match(plan, /must not change the active V3 constants/);
  assert.match(plan, /independent in-memory copies/);
  assert.match(plan, /This foundation does not select V4 findings/);
});
