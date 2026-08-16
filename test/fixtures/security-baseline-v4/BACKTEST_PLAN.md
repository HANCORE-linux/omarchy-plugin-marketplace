# Security Baseline V3/V4 Offline Backtest Plan

Status: foundation only. This document and the adjacent regression corpus do not add a downloader, V4 policy, scanner rule, work budget, or runnable full-corpus backtest.

## Purpose

Security Baseline V4 must be measured against the current modular V3 implementation before any V4 policy can replace or reinterpret V3. The checked-in corpus provides small, inert characterization inputs for that work. It records current V3 behavior, including known limitations, without defining future V4 outcomes.

The retained material was reviewed against the current architecture. Legacy changes to the former monolithic scanner, marker handling, and workflow matching are not part of this foundation because current `security-baseline-policy.mjs`, `security-baseline-record.mjs`, and architecture tests already own those responsibilities.

## Non-negotiable constraints

- Treat every community repository file as inert bytes. Never import, source, evaluate, spawn, or otherwise execute those bytes.
- Keep snapshot acquisition separate from offline analysis and require explicit maintainer approval before any live corpus acquisition.
- Do not require or accept a personal access token.
- Do not perform a registry-wide or open-submission live backtest as part of ordinary tests.
- Resolve each source snapshot by normalized repository identity and a full 40-character commit SHA.
- Give V3 and V4 independent copies of the same verified cached bytes and metadata.
- Keep snapshot caches and generated comparison results outside published marketplace artifacts and out of Git.
- Preserve the current V3 policy, records, markers, projection, approval behavior, and outcomes while V4 is being developed.

## Current modular adapter boundary

The V3 offline adapter must call the pure `buildSecurityBaseline` input contract from `security-baseline-analysis.mjs`. It receives only normalized repository identity, repository URL, full commit SHA, and in-memory file records. It must not receive a filesystem path containing community content or a network-capable fetch implementation.

A future V4 adapter must be versioned independently. It must not change the active V3 constants in `security-baseline-policy.mjs`, reinterpret stored V3 records, or route V3 approval and catalog projection through unfinished V4 logic.

The checked-in foundation test deliberately bypasses:

- `security-github-snapshot.mjs` network transport;
- `security-baseline-scope.mjs` live snapshot resolution;
- `security-baseline-scanner.mjs` orchestration;
- `security-baseline.mjs` CLI and filesystem adapter;
- registry, catalog, approval, verification, and deployment code.

This keeps the fixture contents offline and demonstrates that the corpus characterizes static analysis rather than publication behavior.

## Checked-in regression corpus

`corpus.json` contains bounded, minimal reproductions. Each case includes:

- a stable ID and design classification;
- coverage labels;
- issue-derived or synthetic provenance;
- normalized repository and full commit identity;
- one or more inert in-memory file records; and
- the exact current V3 outcome, finding IDs, capability IDs, and approval-blocking result.

Classifications describe V4 design intent without defining policy:

- `candidate-positive` and `candidate-negative` identify proposed detection boundaries;
- `coverage-decision` identifies behavior that needs an explicit scope decision;
- `known-v3-false-positive` preserves an existing V3 limitation;
- `boundary` records a path or syntax edge; and
- `complexity` records input intended to exercise future bounded analysis.

`expectedV3` is characterization evidence, not a desired V4 result. A known V3 false positive remains recorded as the V3 result so future comparisons explain the delta instead of silently rewriting history. Optional `findingCommentary` is used only when case-specific context adds value beyond the central policy text. Each comment must reference a finding in `expectedV3.findings` and provide distinct submitter and maintainer guidance. Cases without V3 findings cannot carry finding commentary, and generic policy explanations or remediation must not be duplicated here.

## Commit-addressed snapshot cache

A later acquisition tool should use a cache outside the repository by default:

```text
<cache>/
  blobs/sha256/<content-sha256>
  snapshots/<owner>/<repository>/<commit-sha>.json
  snapshots/<owner>/<repository>/<commit-sha>.json.sha256
```

Each versioned snapshot manifest should record:

- normalized repository identity;
- requested full commit SHA and resolved tree SHA;
- deterministic, path-sorted file entries; and
- path, Git mode, declared size, binary classification, and content SHA-256.

The adjacent sidecar stores the SHA-256 digest of the exact canonical manifest bytes. A cache hit is valid only after the sidecar, manifest schema, uniqueness constraints, declared limits, and every referenced blob digest are verified. Missing, duplicate, oversized, truncated, or mismatched data is an error, never a partial snapshot.

Acquisition must stage data in a temporary location and mark a cache entry complete only after the complete manifest and all blobs verify. Acquisition is not part of the offline V3/V4 comparison.

## Identical offline inputs

The comparison runner should:

1. load and verify one cached snapshot;
2. freeze normalized metadata and bytes;
3. create two independent in-memory copies;
4. run the versioned V3 and V4 adapters without network access;
5. record the same snapshot-manifest digest beside both results; and
6. reject a comparison when the adapters report different input digests.

Neither adapter may mutate shared input or read community content through an unrecorded path.

## Deterministic results and deltas

Write one versioned JSON record per snapshot containing:

- repository, full commit SHA, and snapshot-manifest digest;
- V3 and V4 adapter status;
- outcome, finding IDs, and capability IDs for successful adapters;
- stable error code and stage for failed adapters; and
- sorted additions, removals, and outcome/error changes.

An adapter error must not include a partial outcome or partial evidence list. Delta arrays must be deduplicated and lexically sorted. Human-readable text may be generated separately but is not a comparison key.

A run-level summary should count unchanged and changed outcomes, added and removed findings, added and removed capabilities, V3-only errors, V4-only errors, and errors shared by both versions.

## Required implementation gates

Future work remains separately approved and should proceed in this order:

1. preserve the checked-in V3 characterization corpus;
2. define versioned cache and result schemas with tampering tests;
3. implement the offline loader and V3 adapter without live transport;
4. test the runner against only the checked-in corpus;
5. review snapshot acquisition separately before any live request;
6. acquire an explicitly approved commit-addressed corpus without executing community code;
7. implement an independent V4 adapter and policy;
8. backtest the complete listing and submission corpus;
9. explain every changed outcome and scan error; and
10. approve migration and enforcement separately.

This foundation does not select V4 findings, define V4 blocking behavior, bump the active baseline version, acquire repository data, or change marketplace publication behavior.
