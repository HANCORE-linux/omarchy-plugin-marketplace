import { githubRepositoryKey } from "./github-repository.mjs";
import { SecurityBaselineError } from "./security-baseline-error.mjs";
import {
  securityBaselineBlockingLabels,
  securityBaselineEligibleForVerifiedListing,
  securityBaselineEnforcementMode,
} from "./security-baseline-policy.mjs";

const blockingLabels = new Set(securityBaselineBlockingLabels);

export class SecurityBaselineApprovalError extends SecurityBaselineError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = "SecurityBaselineApprovalError";
  }
}

function fullCommit(value, code) {
  const commit = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new SecurityBaselineApprovalError(code, "A full 40-character commit SHA is required");
  }
  return commit;
}

function labelNames(labels) {
  return (labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean);
}

export function checkBlockingLabels(labels) {
  const found = labelNames(labels).find((label) => blockingLabels.has(label));
  if (found) {
    throw new SecurityBaselineApprovalError(
      "approval-blocking-label",
      `Approval is blocked by the "${found}" label`,
      { label: found },
    );
  }
}

export function checkCommitBinding(baselineSha, currentSha) {
  const baseline = fullCommit(baselineSha, "approval-security-baseline-invalid");
  const current = fullCommit(currentSha, "approval-upstream-changed");
  if (baseline !== current) {
    throw new SecurityBaselineApprovalError(
      "approval-upstream-changed",
      "The upstream repository changed after the automated security baseline",
      { baselineSha: baseline, currentSha: current },
    );
  }
}

export function assertApprovalAllowed(issue, baseline, currentInspection, repoUrl) {
  checkBlockingLabels(issue?.labels);
  if (!baseline) {
    throw new SecurityBaselineApprovalError(
      "approval-security-baseline-missing",
      "Approval requires an automated security baseline result",
    );
  }
  const expectedRepository = githubRepositoryKey(repoUrl);
  if (
    baseline.repository.toLowerCase() !== expectedRepository
    || baseline.enforcementMode !== securityBaselineEnforcementMode
  ) {
    throw new SecurityBaselineApprovalError(
      "approval-security-baseline-invalid",
      "The automated security baseline belongs to a different repository",
    );
  }
  if (!securityBaselineEligibleForVerifiedListing(baseline)) {
    throw new SecurityBaselineApprovalError(
      "approval-security-needs-fixes",
      "Verified publication requires a passing baseline or an eligible selectively reviewed result",
    );
  }
  checkCommitBinding(baseline.commitSha, currentInspection?.commitSha);
}
