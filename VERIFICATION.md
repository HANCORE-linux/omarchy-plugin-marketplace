# Automated Plugin Verification

Automated plugin verification is a deterministic, commit-bound source check for existing community listings.

**Verification is not a security audit, certification, warranty, endorsement, or guarantee that a plugin is safe.** Community plugins remain unsandboxed third-party code.

## Statuses

A community plugin is `Verified` only when the registry contains a complete current-version Automated Security Baseline result that:

- has outcome `passed`,
- has no findings or review capabilities,
- completed without a scan error,
- uses the current enforcement mode, and
- is bound to the exact `listingValidatedCommit` recorded for that listing.

Every other community plugin is `Unverified`. `Unverified` does not mean that a plugin is malicious. It means that no current passing baseline is recorded for the exact listed commit.

The status is derived from immutable listing and baseline facts. The registry does not store a manually editable `verified` flag, maintainer identity, review timestamp, or bypass.

## Requesting verification

Use the [**Request plugin verification** issue form](https://github.com/HANCORE-linux/omarchy-plugin-marketplace/issues/new?template=verify-plugin.yml) for an existing listing. Provide:

- the exact existing plugin ID,
- the existing repository root URL, and
- the full 40-character `listingValidatedCommit`; copy it from the target URL of the **Listing snapshot** GitHub commit link on the plugin detail page.

The first verification workflow accepts only the commit already recorded by the listing. A different commit is a plugin update and is outside this workflow. Multi-plugin repositories are verified source-wide: one request scans every configured plugin manifest at the listed commit and updates every catalog entry from that source. Shell-suite listings are not eligible for this first plugin-source workflow.

The workflow checks that the plugin ID, repository, and commit identify one existing registry source. It resolves every configured plugin ID directly in the exact listing snapshot and forces each declared entry point into the scan. Immutable registry manifest paths are used as hints when available; mutable refreshed catalog paths are never trusted as the authoritative listing-time location. It then reads the exact commit through the GitHub API and runs the Automated Security Baseline statically. Community repository files are treated only as data and are never imported, sourced, spawned, evaluated, or otherwise executed.

If the result is `passed`, the workflow records the canonical commit-bound baseline facts and publishes the derived `Verified` status automatically. Initial approval and later verification use the same stored-record converter. No per-plugin maintainer review or manual override is used for this passing path. If the result is `review-required` or `needs-fixes`, the public verification report includes deterministic rule or capability IDs, source evidence, reasons, and accepted remediation while the listing remains `Unverified`. Unavailable, invalid, or incomplete scans also remain `Unverified` and fail closed.

Editing the issue retries a failed or corrected request. A successful or already-current request is closed automatically.

## Publication safety

The registry is the only persistent source of verification facts. One shared pure projection derives all catalog verification fields for regular builds, failed refreshes, and verification publications.

Analysis runs with read-only marketplace permissions. Registry and catalog changes are produced and tested before entering a write-permission job. The write job does not install dependencies or execute marketplace or community repository code. It verifies the immutable publication artifact and refuses to publish if `main`, the issue, or the expected listing changed after analysis.

The verification workflow preserves the marketplace's single-build and immutable-artifact publication rules. Scan failures and GitHub API limit failures remain fail closed.

## Installation boundary

`Verified` describes only the exact listed source commit. If an installation command obtains a different upstream commit, that installed code is not covered by the status. Automated verification does not claim that mutable branch-head installation is commit-bound.

## Display text

The status explanation is available to pointer, keyboard, touch, and assistive-technology users:

- `Verified`: “Automated checks passed for the listed commit. This is not a security audit.”
- `Unverified`: “No passing automated baseline is recorded for the listed commit. This does not mean the plugin is malicious.”

Community plugin cards show the status on the right side of the lower status row, aligned with the card’s lower-right action. It mirrors the left-side `New` or `Updated` marker: `Verified` uses the passing tone, while `Unverified` uses the marketplace accent. Neither status uses a checkmark or separator. The explanation is available on hover, keyboard focus, and tap, and is included in the control’s accessible name for screen readers.
