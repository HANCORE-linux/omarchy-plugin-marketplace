# Automated Security Baseline

These guidelines apply to every plugin author, marketplace contributor, and maintainer who submits a plugin or changes submission, validation, approval, registry, or catalog behavior.

**This is not a security audit, certification, warranty, or endorsement.**

## Purpose and limits

The Automated Security Baseline is a deterministic listing-time check. It identifies only the documented static patterns in this file. It does not perform general data-flow analysis, prove that a plugin is safe, or attempt to stop a motivated attacker.

The baseline does not execute plugin code. It reads selected files from the exact full commit SHA produced by submission validation. Plugins remain unsandboxed upstream code, and users must still inspect the source and decide whether to trust it.

## Scan scope and limits

The scan includes recognized script and configuration formats, the root README, manifest entry points, executable files, and relevant extensionless files. Test, fixture, dependency, generated-documentation, and similar excluded directories are not treated as runtime source unless a required entry point selects a file explicitly.

A complete result is limited to:

- 1,000 relevant files
- 8 MiB of relevant text in total
- 512 KiB per relevant text file

Executable files are probed for ELF, PE, and Mach-O formats. A detected executable binary produces the `bundled-executable-binary` capability and requires review; the scanner does not claim to inspect its behavior. Unsupported files, truncated trees, exceeded limits, unavailable snapshots, and other incomplete scans fail closed. Approval is not possible without a complete baseline result.

## Deterministic findings

The following patterns produce findings:

- `curl-pipe-shell`: content downloaded with `curl` or `wget` is passed directly to a shell, invoked through an equivalent literal shell path, or written to a file that a later command executes without verification.
- `cargo-git-unpinned`: `cargo install --git` obtains an external repository without a full 40-character `--rev` commit.
- `remote-git-execution-unpinned`: code from an external Git repository is built or executed without first binding it to a full commit and checking out that commit in detached mode.
- `sudoers-dangerous-passwordless-command`: a `NOPASSWD` policy grants `ALL`, an unrestricted shell or interpreter, unrestricted `wg-quick`, or a broad wildcard command surface for high-risk system tools such as `kill`, `systemctl`, or file-management commands.
- `privileged-process-control-from-shared-temp`: a shell runtime reads a PID from a predictable `/tmp` PID file and passes it to privileged process control through `sudo`, `pkexec`, or a privilege wrapper.

External, unpinned remote execution remains a finding. A source or installation path that obtains code only from the submitted repository is not automatically rejected; it produces the `remote-build` capability and requires maintainer review. A passwordless rule for a root-owned purpose-built helper with a fixed command surface is not automatically blocked; it produces the `sudoers-modification` capability and requires complete manual review of the helper and its inputs.

Contributors should remove download-and-execute paths or pin external source to an immutable full commit before execution. Updating a dependency requires a new plugin commit and a new listing-time baseline result. Runtime PID state should use an owner-only directory such as `$XDG_RUNTIME_DIR`, and privileged process control must not trust mutable shared temporary files.

## Review capabilities

The following detected capabilities require maintainer review but are not findings by themselves:

- `installer`
- `package-manager`
- `privilege`: non-negated references to `sudo` or `pkexec`; clearly negated documentation such as “No sudo or pkexec is required” is excluded.
- `remote-build`
- `bundled-executable-binary`
- `service-management`: systemd service unit files and references to `systemctl` or `systemd-run`; ordinary properties or strings containing `.service` are excluded.
- `sudoers-modification`: sudoers policy files or commands and documentation that install, validate, or remove a sudoers policy.

Capabilities describe deterministic evidence, not intent or safety.

## Outcomes and selective enforcement

The outcome is derived only from findings and capabilities:

- `passed`: no documented finding or review capability was detected.
- `review-required`: one or more review capabilities were detected without a finding.
- `needs-fixes`: one or more documented findings were detected.

The baseline currently runs in `selective` enforcement mode:

- `review-required` adds `security-review-required` and remains eligible for explicit maintainer approval.
- `needs-fixes` caused only by remote-execution findings adds `security-review-required`; these measured findings remain eligible for explicit maintainer approval while their rules are refined.
- `needs-fixes` containing `sudoers-dangerous-passwordless-command` or `privileged-process-control-from-shared-temp` adds `security-needs-fixes` and blocks approval in both the workflow and approval code.
- Baseline scan failures remain fail closed.

Only an authorized maintainer may approve a review result. A selectively enforced finding has no maintainer bypass: the submitted commit must change and validation must run again. Implementations must not use AI to determine baseline outcomes, enforcement, labels, or approval. Outcomes and automated labels must remain deterministic code paths; listing approval must remain an explicit authorized-maintainer action.

## Exact-SHA binding

Validation, baseline scanning, approval, initial catalog generation, and the pre-publication recheck must all refer to the same exact full commit SHA. A changed branch head invalidates the recorded validation and requires a new run. Initial catalog generation must resolve the approved repository at that commit rather than at a mutable branch or tag.

The registry stores automated baseline facts needed to preserve that binding: baseline version, full commit, scan time, outcome, enforcement mode, finding IDs, and capability IDs. It must not store maintainer identities, review timestamps, or review flags. Human review activity remains in GitHub's issue, label, workflow, and repository history and is not copied into `registry.json`.

## Listing-time check

The stored baseline applies only to the commit approved for initial listing. Scheduled Catalog Refresh remains a separate compatibility process that reads the upstream branch HEAD. It does not rerun or update the stored baseline and must not describe that listing-time result as covering later upstream changes.

## Contributor requirements

Changes to the baseline or its workflow must:

1. Preserve static analysis without executing plugin code.
2. Keep outcomes, labels, evidence, and reports deterministic and independent of AI decisions.
3. Preserve exact-SHA binding and fail-closed scan errors.
4. Document every detected pattern and accepted remediation in this file and in public feedback.
5. Add focused positive, negative, boundary, and tampering tests.
6. Keep the required disclaimer in every baseline result and relevant public documentation.
7. Preserve least-privilege workflow permissions, pinned actions, timeouts, and concurrency controls.
8. Backtest rule or scope changes against the existing registry and report outcome changes and scan failures before enforcement changes.
9. Treat a change to outcomes, enforcement, pattern meaning, or stored schema as a versioned policy decision requiring maintainer review.

Do not weaken, bypass, relabel, or manually fabricate a baseline result to make a submission pass. Correct the source or rerun validation against a new exact commit instead.
