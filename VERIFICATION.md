# Plugin Verification

Plugin verification combines a deterministic, commit-bound source check with narrowly scoped maintainer-review paths for new submissions and existing community listings.

**Verification is not a security audit, certification, warranty, endorsement, or guarantee that a plugin is safe.** Community plugins remain unsandboxed third-party code.

## Statuses

A community plugin is `Verified` only when the registry contains one of these exact-commit records:

- a complete current-version Automated Security Baseline result with outcome `passed`, no findings or review capabilities, no scan error, the current enforcement mode, and the exact `listingValidatedCommit`; or
- a canonical maintainer-review attestation for a complete current `review-required` result with no findings or scan error.

The maintainer attestation repeats and must exactly match the baseline repository, source plugin IDs, commit, policy version, enforcement mode, scan time, outcome, empty finding set, and accepted capability set. It also records the authorized reviewer, exact label-event ID, label-request time, and review time.

Every other community plugin is `Unverified`. `Unverified` does not mean that a plugin is malicious. It means that no current automatic or maintainer-reviewed verification record is available for the exact listed commit.

The status is derived from immutable listing, baseline, and review facts. The registry does not store a manually editable `verified` flag.

## Verifying a new submission

Every new submission must be published through the explicit `approved-and-verified` label. `approved-for-listing` is retained only as a historical audit label and no longer triggers publication.

The workflow requires a current bot-authored baseline report to predate the label event, checks the actor's current write permission, verifies the exact issue and repository state, and performs a fresh static scan of the exact validated commit. A fresh `passed` result is stored as automatic verification. A fresh capability-only `review-required` result must match the complete report identity and capability set the maintainer accepted; the workflow then stores the same canonical `maintainerVerificationReview` used by existing-listing verification. Every finding, incomplete scan, stale report, changed commit, changed capability set, or event mismatch blocks initial publication.

Listing, canonical verification evidence, catalog projection, testing, publication, and Pages deployment are one guarded workflow. A successfully published new community plugin therefore starts as `Verified`. This remains an exact-commit statement, not a security audit or guarantee.

## Requesting verification

Use the [**Request plugin verification** issue form](https://github.com/HANCORE-linux/omarchy-plugin-marketplace/issues/new?template=verify-plugin.yml) for an existing listing. Provide:

- the exact existing plugin ID,
- the existing repository root URL, and
- the full 40-character `listingValidatedCommit`; copy it from the target URL of the **Listing snapshot** GitHub commit link on the plugin detail page.

The first verification workflow accepts only the commit already recorded by the listing. A different commit is a plugin update and is outside this workflow. Multi-plugin repositories are verified source-wide: one request scans every configured plugin manifest at the listed commit and updates every catalog entry from that source. Shell-suite listings are not eligible for this first plugin-source workflow.

The workflow checks that the plugin ID, repository, and commit identify one existing registry source. It resolves every configured plugin ID directly in the exact listing snapshot and forces each declared entry point into the scan. Immutable registry manifest paths are used as hints when available; mutable refreshed catalog paths are never trusted as the authoritative listing-time location. It then reads the exact commit through the GitHub API and runs the Automated Security Baseline statically. Community repository files are treated only as data and are never imported, sourced, spawned, evaluated, or otherwise executed.

If the result is `passed`, the workflow records the canonical commit-bound baseline facts and publishes the derived `Verified` status automatically. Initial approval and later verification use the same stored-record converter.

If the result is `review-required`, the bot report includes deterministic capability IDs, source evidence, reasons, and a machine-readable expectation. An authorized marketplace maintainer may inspect that evidence and apply the `maintainer-verified` label to the open verification issue. The workflow requires that exact bot report to predate the label, checks the actor's current write permission, rescans the exact listed commit, and publishes `Verified` only if repository, plugin IDs, commit, policy, enforcement mode, outcome, empty findings, and capability IDs exactly match the report the maintainer saw. Any capability mismatch only publishes a new eligible report and requires a new decision; review that report, then remove and reapply the label. Findings, scan failures, and other ineligible results publish no review expectation. In those cases, edit the open issue or reopen it to run normal verification first, and only remove and reapply the label after the bot publishes a new eligible `review-required` report. The label remains on the issue as an audit trail. Workflow reruns cannot reuse its event. The resulting registry attestation and public catalog identify the verification method as `maintainer-reviewed`.

`needs-fixes`, findings, unavailable snapshots, invalid results, incomplete scans, and scan errors are never eligible for maintainer verification and remain `Unverified` fail closed.

Editing the issue retries a failed or corrected request. A successful, maintainer-reviewed, or already-current request is closed automatically.

## Publication safety

The registry is the only persistent source of verification facts. One shared pure projection derives all catalog verification fields for regular builds, failed refreshes, and verification publications.

Analysis runs with read-only marketplace permissions. A maintainer-review request binds the latest `approved-and-verified` or `maintainer-verified` transition to the exact event ID, actor, and timestamp, checks reviewer write permission, issue contents, the preceding bot report, and the exact fresh scan result, and rechecks that mutable authorization before the publication push. Registry and catalog changes are produced and tested before entering a write-permission job. The write job does not install dependencies or execute marketplace or community repository code. It verifies the immutable publication artifact and refuses to publish if `main`, the issue, review label, reviewer permission, report identity, upstream commit, or expected listing changed after analysis.

The verification workflow preserves the marketplace's single-build and immutable-artifact publication rules. Scan failures and GitHub API limit failures remain fail closed.

## Installation boundary

`Verified` describes only the exact listed source commit. If an installation command obtains a different upstream commit, that installed code is not covered by the status. Neither automatic nor maintainer-reviewed verification claims that mutable branch-head installation is commit-bound.

## Display text

The status explanation is available to pointer, keyboard, touch, and assistive-technology users:

- automatic `Verified`: “Automated checks passed for the listed commit. This is not a security audit.”
- maintainer-reviewed `Verified`: “A marketplace maintainer reviewed the reported capabilities for the listed commit. This is not a security audit.”
- `Unverified`: “No current verification record is available for the listed commit. This does not mean the plugin is malicious.”

Community plugin cards show the status on the right side of the lower status row, aligned with the card’s lower-right action. It mirrors the left-side `New` or `Updated` marker: `Verified` uses the passing tone, while `Unverified` uses the marketplace accent. Neither status uses a checkmark or separator. The explanation is available on hover, keyboard focus, and tap, and is included in the control’s accessible name for screen readers.
