# Omarchy Plugin Marketplace Plan

> This is the living implementation and security roadmap. The code, tests, workflows, `AGENTS.md`, and public security documentation remain authoritative when behavior differs from this document.

## Purpose

The Omarchy Plugin Marketplace helps users discover and install community plugins while keeping publication, verification, and security decisions transparent.

The marketplace is designed to remain simple to operate:

- a static, framework-free frontend;
- a curated `registry.json` and generated `site/catalog.json`;
- GitHub Issues and GitHub Actions for submissions and verification;
- GitHub Pages for publication;
- no execution of community repository code by marketplace workflows; and
- no new backend, database, or runtime dependency for the security roadmap.

The existing engagement service remains separate from catalog trust. Stars, hearts, views, copies, sorting, and engagement events must not influence verification.

## Security statement

A commit SHA proves identity and integrity, not safety. It shows which source snapshot was checked and prevents that snapshot from being silently substituted during publication. It does not prove that the source contains no malicious behavior or unknown vulnerability.

`Verified` therefore means only:

> Automated checks passed for the exact listed commit. This is not a security audit.

It must never mean that a plugin is certified, guaranteed safe, endorsed, or covered when installation obtains a different commit.

## Operating principles

1. **Treat community content as data.** Never import, source, evaluate, spawn, or otherwise execute community repository files in marketplace automation.
2. **Bind trust to immutable facts.** Repository, full commit SHA, plugin IDs, policy version, enforcement mode, and scan result must match exactly.
3. **Fail closed.** Missing, stale, malformed, incomplete, or mismatched evidence results in `Unverified`.
4. **No manual verification override.** A maintainer cannot set an editable `verified` flag or bypass a non-passing baseline.
5. **Separate analysis from publication.** Read-only scanning and write-capable publication use separate jobs and immutable checked artifacts.
6. **Keep policy centralized.** Rule definitions, capabilities, outcomes, enforcement, marker formats, and workflow dispositions have one owner.
7. **Preserve existing product behavior.** Security work must not alter engagement counters, events, sorting, or unrelated marketplace behavior.
8. **Measure stricter policies before release.** New enforcement must be backtested against the complete listing corpus before it can replace the current policy.

## Achieved

### Marketplace and catalog

- The marketplace is a responsive static site built with vanilla HTML, CSS, and JavaScript.
- Search, typed filters, deterministic sorting, pagination, plugin details, installation commands, and copy feedback are implemented.
- The curated registry is the persistent source of listing facts.
- The generated catalog preserves last-known-good state for recoverable source failures.
- Manifest identity, repository URLs, categories, curated tags, preview assets, and catalog invariants are validated automatically.
- Preview images are bounded, validated, and converted to optimized local assets.
- New and updated states are derived from listing and manifest timestamps rather than manual ranking.
- Community submissions use a structured GitHub Issue form and still require maintainer approval before initial listing.

### Engagement

- Public stars, hearts, views, and copy counts are displayed without accounts or credentials.
- Event bodies contain only the catalog plugin ID and a fixed action type.
- The existing Cloudflare service applies origin restrictions, input validation, transactional counters, caching, and best-effort rate limits.
- Verification does not read or modify engagement state.

### Automated Security Baseline V3

The current implementation remains **Security Baseline V3 with selective enforcement**. V4 is a separate future policy change.

The V3 architecture has been split into focused layers:

- centralized policy and limits;
- common error contracts;
- canonical baseline records and markers;
- GitHub snapshot acquisition;
- scan-scope selection;
- static analysis and scanner orchestration;
- report generation and approval handling;
- verification subject resolution;
- registry-to-catalog verification projection; and
- a thin compatibility facade for existing callers.

The scanner currently identifies capabilities and known risk patterns including:

- mutable or unpinned remote acquisition;
- pipe-to-shell and related remote-execution flows;
- download-to-file followed by execution;
- package-manager and installer activity;
- privilege boundaries and `sudoers` policy;
- services and privileged process control;
- executable binaries;
- risky shared temporary-file use; and
- relevant runtime entry points referenced by listed manifests.

Repository snapshots are read statically at the exact full commit through the GitHub API. Aggregate size and file-count limits are enforced before raw content is fetched where possible. The current aggregate snapshot limit is 8 MiB.

The deterministic baseline outcomes are:

- `passed` — no findings or review capabilities;
- `review-required` — detected capabilities require human judgment, but do not receive a manual Verified override; and
- `needs-fixes` — one or more findings were detected; this always prevents `Verified`, while only selectively blocking findings prevent initial listing approval.

Negative reports include rule or capability identifiers, source evidence, reasons, and accepted remediation. Scan errors and unavailable snapshots remain fail-closed.

### Commit-bound verification for existing listings

A dedicated verification Issue form and workflow are implemented for existing plugin-source listings.

The workflow:

1. accepts an existing plugin ID, repository root URL, and full listed commit SHA;
2. resolves the exact registry source rather than trusting mutable catalog paths;
3. includes every configured plugin ID from a multi-plugin source;
4. scans the exact listed snapshot without executing community code;
5. creates a canonical commit-bound baseline record and public report;
6. projects verification only when the complete source plugin set matches;
7. publishes `Verified` automatically only for a current `passed` result; and
8. leaves every other result `Unverified` without a manual bypass.

Shell-suite listings are intentionally outside the first plugin-source verification workflow.

A successful verification path requires no per-plugin maintainer approval. After the request is opened, analysis, testing, registry/catalog publication, the bot commit to `main`, Pages deployment, reporting, and issue closure are automated.

### Publication safeguards

The verification workflow provides:

- least-privilege job permissions;
- SHA-pinned GitHub Actions;
- read-only analysis followed by a separate write job;
- immutable, uniquely named artifacts;
- explicit expected-file checks and SHA-256 checksums;
- tests against the exact publication bundle;
- issue title, body, state, listing, and base-commit checks;
- refusal to rebase or publish stale artifacts when `main` changes; and
- a pre-deployment check that refuses deployment when `main` is already newer than the tested publication commit.

### Verification projection and display

- `Verified` is derived only from a complete current-version `passed` record matching the exact `listingValidatedCommit`.
- Stale records, extra or missing source plugins, policy mismatches, scan errors, and non-passing outcomes project to `Unverified`.
- The registry does not contain a manually editable `verified` boolean.
- Plugin cards show `Verified` in the passing tone and `Unverified` in the marketplace accent.
- Neither status uses a checkmark or separator.
- Status explanations are available through pointer, keyboard, touch, and assistive technology.
- The public documentation states the exact-commit boundary and explains that verification is not an audit.

### Validation evidence

The V3 verification implementation through release-candidate commit `8ea8db4` produced:

- 147 passing automated tests;
- static JavaScript, YAML, JSON, whitespace, image, and documentation checks;
- independent review with zero findings for the committed verification and README work; and
- a complete V3 listing backtest covering 228 plugin sources and 230 plugin IDs.

Backtest result:

| Result | Sources | Plugin IDs |
| --- | ---: | ---: |
| `passed` | 130 | 130 |
| `review-required` | 97 | 99 |
| `needs-fixes` | 1 | 1 |
| Scan errors | 0 | 0 |

All 131 existing V3 records matched the refactored scanner exactly.

## Release process

The commit-bound verification implementation, card status refinement, and README/documentation refresh use `feature/automated-plugin-verification` as their release branch. Their release always requires these separate gates:

1. explicit push approval;
2. separately approved pull request creation and successful CI;
3. confirmation that the PR is clean and mergeable;
4. explicit merge and deployment approval;
5. squash merge; and
6. Pages, catalog, and engagement smoke checks after deployment.

Actual branch, PR, and deployment state belongs in the corresponding GitHub history rather than this long-lived roadmap.

Security Baseline V4 preparation remains isolated from this V3 verification release and must not be mixed into it without a separate review and decision.

## Manual intervention model

| Situation | Required intervention |
| --- | --- |
| Start verification for an existing listing | A person opens the structured verification Issue. |
| Current result is `passed` | None after the request; publication and deployment are automatic. |
| Result is `review-required` | A person may inspect the report or coordinate an upstream change, but cannot manually set `Verified`. |
| Result is `needs-fixes` | The plugin author fixes the source, the listing is updated to a new reviewed commit, and verification is requested again. |
| Request is invalid or stale | The requester corrects or retries the Issue. |
| GitHub, scan, CI, or publication failure | A maintainer investigates and retries; status remains fail-closed. |
| Initial listing submission | A maintainer still approves admission to the marketplace. |
| Policy or scanner change | Normal code review, tests, release approval, and backtesting are required. |

## Next goals

### Goal 0 — Release the current V3 verification work

- Push the feature branch only after explicit approval.
- Open a focused pull request only after separate approval.
- Require successful CI and a clean, mergeable PR state.
- Squash-merge only after explicit merge approval.
- Confirm the expected Pages deployment, catalog contents, verification display, and unchanged engagement behavior.

**Exit criterion:** commit-bound verification is live and one controlled existing-listing request completes safely from Issue to published status.

### Goal 1 — Complete separate catalog data-quality rules

Implement these independently from security-policy changes:

- reject duplicate plugin names according to an explicit normalization rule; and
- validate Suggested tags against the curated marketplace vocabulary and selection limits.

**Exit criterion:** duplicates and invalid suggested tags fail with deterministic, actionable feedback without changing existing valid listings unexpectedly.

### Goal 2 — Bind installation to the verified commit

This is the highest-priority security improvement because the current status covers the listed source commit while a mutable installation source may obtain different code.

Planned work:

- determine how each supported installation path can fetch a full immutable commit SHA;
- generate or validate commit-bound installation commands;
- verify archive or downloaded-content hashes where supported;
- reject or clearly distinguish mutable installation paths;
- prevent `Verified` from implying coverage when the actual installation is not commit-bound; and
- preserve a safe migration path for existing listings.

**Exit criterion:** a user selecting a Verified installation receives exactly the source snapshot that passed the baseline, or the UI clearly states that the installation is not verification-bound.

### Goal 3 — Verify the reachable dependency and acquisition closure

Extend static checks beyond the primary repository snapshot:

- require full immutable Git revisions for Git dependencies and submodules;
- require hashes for downloaded scripts, archives, and binaries where practical;
- detect mutable branch, tag, package, and release-asset acquisition;
- inspect lockfiles and installer-declared dependencies as data;
- inventory remote hosts and artifacts reached by installation scripts;
- generate a deterministic source and dependency inventory; and
- fail closed when required dependency identity cannot be established.

No community dependency code may be executed during this process.

**Exit criterion:** a passing result identifies the immutable primary snapshot and every automatically acquired executable input that the supported installer can determine statically.

### Goal 4 — Develop and backtest Security Baseline V4

V4 should be stricter without silently changing V3 semantics.

Candidate V4 controls:

- stronger enforcement for remote execution and unpinned acquisition;
- stricter privileged command and sensitive-system-path rules;
- explicit treatment of persistent services and process control;
- detection of credential access and sensitive user-data paths;
- improved analysis of obfuscated or dynamically assembled commands;
- stricter binary and executable policy;
- network-destination inventory; and
- clearer distinction between review capabilities and blocking findings.

Required safeguards:

- keep V4 records versioned separately from V3;
- backtest the complete listing and submission corpus;
- document every changed outcome with evidence;
- measure false positives and migration impact;
- never weaken the existing dangerous-command enforcement; and
- require separate implementation, review, commit, push, and release approval.

**Exit criterion:** V4 has zero unexplained regressions, deterministic records and reports, complete corpus evidence, and an approved migration plan.

### Goal 5 — Add automated defense-in-depth analysis

Add independent, deterministic signals where they can operate without executing community code or adding a new marketplace backend:

- known-vulnerability checks for declared dependencies;
- secret and credential-pattern detection;
- suspicious binary metadata and string inspection;
- unexpected executable-file detection;
- static network endpoint inventory;
- installer/source consistency checks; and
- repository provenance and archive-state checks.

Any external service, analyzer, or new dependency requires a separate architectural and supply-chain review. A third-party score must never become an unchecked verification override.

**Exit criterion:** each added analyzer produces bounded, reproducible evidence and fails closed without weakening the canonical policy result.

### Goal 6 — Introduce declarative plugin capabilities

Evaluate a manifest-level capability declaration for actions such as:

- network access;
- system and user file access;
- privileged commands;
- background services;
- process control;
- downloaded executable content; and
- access to credentials or desktop-session APIs.

The scanner should compare declared capabilities with statically observed behavior. Undeclared sensitive capabilities should prevent a passing result.

Declarations are transparency and policy inputs, not proof that code behaves as declared.

**Exit criterion:** sensitive observed capabilities are either declared and accepted by policy or automatically produce a non-passing result.

### Goal 7 — Add continuous revalidation and automatic revocation

Reduce reliance on one-time requests:

- rescan listings when their validated commit changes;
- rescan when the baseline policy or enforcement mode changes;
- schedule bounded periodic verification of eligible listings;
- automatically invalidate records made stale by a policy upgrade;
- withdraw `Verified` when current evidence no longer passes;
- retain prior reports for traceability; and
- prevent concurrent catalog writers from publishing conflicting state.

No human approval should be required for a deterministic passing revalidation. Non-passing or failed rescans remain `Unverified` and generate actionable reports.

**Exit criterion:** verification state continuously reflects the current listing commit and current policy without manual status editing.

### Goal 8 — Strengthen provenance

Evaluate automated provenance controls:

- verified commit or tag signatures;
- repository ownership and transfer detection;
- GitHub artifact attestations where available;
- reproducible archive hashes;
- source-to-artifact relationships; and
- alerts when previously trusted provenance changes.

Provenance confirms origin and integrity. It must not be described as proof of safe behavior.

**Exit criterion:** provenance facts are commit-bound, machine-verifiable, visible in reports, and never substitute for static policy checks.

### Goal 9 — Evaluate runtime containment

Static analysis cannot reliably detect every malicious behavior or vulnerability. The strongest long-term protection is to limit what a plugin can do when users run it.

Evaluate with the Omarchy/plugin-manager architecture:

- unprivileged installation and execution by default;
- restricted filesystem access;
- opt-in network access;
- process and resource limits;
- denial of credential and SSH-key access by default;
- isolated service definitions; and
- explicit user confirmation for elevated capabilities.

This is a broader platform change and remains outside the current marketplace-only implementation. Marketplace CI must still never execute community plugin code.

**Exit criterion:** feasible containment controls and ownership boundaries are documented and approved before implementation begins.

## Success measures

The roadmap is successful when:

- all verification decisions remain deterministic and reproducible;
- no community code is executed by marketplace workflows;
- every Verified result is bound to an exact repository, commit, source plugin set, policy version, and enforcement mode;
- verified installation paths eventually obtain the exact checked source;
- mutable or unidentified executable dependencies cannot pass unnoticed;
- stale evidence automatically loses Verified status;
- no manual override can convert a non-passing result into Verified;
- stricter rules are supported by complete backtest evidence;
- security changes do not alter engagement behavior; and
- public wording continues to distinguish automated verification from a security audit.

## Non-goals

The marketplace does not claim to provide:

- proof that arbitrary plugin code is harmless;
- a complete security audit, certification, warranty, or endorsement;
- automatic acceptance of new community listings without maintainer review;
- execution of community code in CI for behavioral analysis;
- a new marketplace backend or database for verification;
- a manual Verified override; or
- coverage for code that differs from the exact verified installation boundary.

## Immediate next actions

1. Obtain separate approval before pushing the current feature branch.
2. Complete the PR, CI, mergeability, merge, and deployment gates as separate decisions.
3. Implement duplicate plugin-name and Suggested-tag validation as an isolated change.
4. Design commit-bound installation before expanding the meaning of Verified.
5. Continue V4 development separately and backtest it against the complete corpus.
6. Plan dependency-closure and continuous-revalidation work without executing community code or introducing an unreviewed dependency.
