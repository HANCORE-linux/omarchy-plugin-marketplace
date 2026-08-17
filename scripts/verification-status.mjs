import { githubRepositoryKey } from "./github-repository.mjs";
import { parseStoredSecurityBaselineRecord } from "./security-baseline-record.mjs";
import { parseMaintainerVerificationReview } from "./verification-review.mjs";

export const pluginVerificationStatuses = Object.freeze(["verified", "unverified"]);

function sourcePluginIds(source) {
  const ids = Object.keys(source?.plugins || {});
  if (source?.catalog?.id) ids.push(source.catalog.id);
  return ids.sort();
}

export function sourceVerification(source) {
  if (source?.type !== "plugin-source") return Object.freeze({ status: "unverified" });
  let repository;
  try {
    repository = githubRepositoryKey(source?.repo);
  } catch {
    return Object.freeze({ status: "unverified" });
  }
  const baseline = parseStoredSecurityBaselineRecord(source?.automatedSecurityBaseline, {
    expectedRepository: repository,
    expectedCommit: source?.listingValidatedCommit,
    pluginIds: sourcePluginIds(source),
  });
  if (!baseline) return Object.freeze({ status: "unverified" });
  const automatic = baseline.outcome === "passed"
    && baseline.findings.length === 0
    && baseline.capabilities.length === 0;
  const review = automatic
    ? null
    : parseMaintainerVerificationReview(source?.maintainerVerificationReview, baseline);
  if (!automatic && !review) return Object.freeze({ status: "unverified" });
  return Object.freeze({
    status: "verified",
    method: automatic ? "automated" : "maintainer-reviewed",
    baselineVersion: baseline.version,
    commit: baseline.commit,
    checkedAt: baseline.checkedAt,
    ...(review ? { reviewedAt: review.reviewedAt, reviewer: review.reviewer } : {}),
  });
}
