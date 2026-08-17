import { securityBaselineEligibleForMaintainerVerification } from "./security-baseline-policy.mjs";
import { parseStoredSecurityBaselineRecord } from "./security-baseline-record.mjs";

export const maintainerVerificationReviewSchemaVersion = 1;
export const maintainerVerificationLabel = "maintainer-verified";
export const maintainerVerificationExpectationMarkerPrefix = "<!-- marketplace-maintainer-verification-expectation:v1 ";

export class MaintainerVerificationReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MaintainerVerificationReviewError";
    this.code = code;
  }
}

function normalizedStrings(value) {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || !entry || entry !== entry.trim())
    || new Set(value).size !== value.length
  ) return null;
  return [...value];
}

function validReviewer(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function serializeMaintainerVerificationExpectation(baseline) {
  const parsed = parseStoredSecurityBaselineRecord(baseline);
  if (!parsed || !securityBaselineEligibleForMaintainerVerification(parsed)) {
    throw new MaintainerVerificationReviewError(
      "verification-review-expectation-invalid",
      "Maintainer verification expectation is invalid or not eligible",
    );
  }
  const encoded = Buffer.from(JSON.stringify(parsed)).toString("base64url");
  return `${maintainerVerificationExpectationMarkerPrefix}${encoded} -->`;
}

export function parseMaintainerVerificationExpectation(body) {
  const escapedPrefix = maintainerVerificationExpectationMarkerPrefix
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...String(body || "").matchAll(
    new RegExp(`${escapedPrefix}([A-Za-z0-9_-]+) -->`, "g"),
  )];
  if (!matches.length) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(matches.at(-1)[1], "base64url").toString("utf8"));
  } catch {
    throw new MaintainerVerificationReviewError(
      "verification-review-expectation-invalid",
      "Maintainer verification expectation is malformed",
    );
  }
  const parsed = parseStoredSecurityBaselineRecord(decoded);
  if (!parsed || !securityBaselineEligibleForMaintainerVerification(parsed)) {
    throw new MaintainerVerificationReviewError(
      "verification-review-expectation-invalid",
      "Maintainer verification expectation is invalid or not eligible",
    );
  }
  return parsed;
}

export function matchesMaintainerVerificationExpectation(expectation, baseline) {
  if (
    !securityBaselineEligibleForMaintainerVerification(expectation)
    || !securityBaselineEligibleForMaintainerVerification(baseline)
  ) return false;
  return JSON.stringify({
    repository: expectation.repository,
    pluginIds: expectation.pluginIds,
    commit: expectation.commit,
    version: expectation.version,
    outcome: expectation.outcome,
    enforcementMode: expectation.enforcementMode,
    findings: expectation.findings,
    capabilities: expectation.capabilities,
  }) === JSON.stringify({
    repository: baseline.repository,
    pluginIds: baseline.pluginIds,
    commit: baseline.commit,
    version: baseline.version,
    outcome: baseline.outcome,
    enforcementMode: baseline.enforcementMode,
    findings: baseline.findings,
    capabilities: baseline.capabilities,
  });
}

export function parseMaintainerVerificationReview(review, baseline) {
  const pluginIds = normalizedStrings(review?.pluginIds);
  const findings = normalizedStrings(review?.findings);
  const capabilities = normalizedStrings(review?.capabilities);
  const baselinePluginIds = normalizedStrings(baseline?.pluginIds);
  const baselineFindings = normalizedStrings(baseline?.findings);
  const baselineCapabilities = normalizedStrings(baseline?.capabilities);
  if (
    !securityBaselineEligibleForMaintainerVerification(baseline)
    || review?.schemaVersion !== maintainerVerificationReviewSchemaVersion
    || review.baselineOutcome !== "review-required"
    || review.repository !== baseline.repository
    || review.commit !== baseline.commit
    || review.baselineVersion !== baseline.version
    || review.enforcementMode !== baseline.enforcementMode
    || review.baselineCheckedAt !== baseline.checkedAt
    || !pluginIds
    || !baselinePluginIds
    || JSON.stringify(pluginIds) !== JSON.stringify(baselinePluginIds)
    || !findings
    || !baselineFindings
    || findings.length !== 0
    || JSON.stringify(findings) !== JSON.stringify(baselineFindings)
    || !capabilities
    || !baselineCapabilities
    || JSON.stringify(capabilities) !== JSON.stringify(baselineCapabilities)
    || !Number.isSafeInteger(review.requestEventId)
    || review.requestEventId < 1
    || !validTimestamp(review.reviewedBaselineCheckedAt)
    || !validTimestamp(review.requestedAt)
    || !validTimestamp(review.reviewedAt)
    || Date.parse(review.reviewedBaselineCheckedAt) > Date.parse(review.requestedAt)
    || Date.parse(baseline.checkedAt) < Date.parse(review.requestedAt)
    || Date.parse(review.reviewedAt) < Date.parse(baseline.checkedAt)
    || Date.parse(review.reviewedAt) < Date.parse(review.requestedAt)
    || !validReviewer(review.reviewer)
  ) return null;
  return Object.freeze({
    schemaVersion: maintainerVerificationReviewSchemaVersion,
    repository: review.repository,
    pluginIds: Object.freeze([...pluginIds]),
    commit: review.commit,
    baselineVersion: review.baselineVersion,
    enforcementMode: review.enforcementMode,
    baselineCheckedAt: review.baselineCheckedAt,
    baselineOutcome: review.baselineOutcome,
    findings: Object.freeze([...findings]),
    capabilities: Object.freeze([...capabilities]),
    reviewedBaselineCheckedAt: review.reviewedBaselineCheckedAt,
    requestEventId: review.requestEventId,
    requestedAt: review.requestedAt,
    reviewedAt: review.reviewedAt,
    reviewer: review.reviewer,
  });
}

export function createMaintainerVerificationReview(baseline, {
  reviewedBaseline,
  reviewer,
  requestEventId,
  requestedAt,
  reviewedAt,
} = {}) {
  if (!matchesMaintainerVerificationExpectation(reviewedBaseline, baseline)) {
    throw new MaintainerVerificationReviewError(
      "verification-review-expectation-mismatch",
      "Rescanned baseline does not match the maintainer-reviewed expectation",
    );
  }
  const review = {
    schemaVersion: maintainerVerificationReviewSchemaVersion,
    repository: baseline?.repository,
    pluginIds: baseline?.pluginIds,
    commit: baseline?.commit,
    baselineVersion: baseline?.version,
    enforcementMode: baseline?.enforcementMode,
    baselineCheckedAt: baseline?.checkedAt,
    baselineOutcome: baseline?.outcome,
    findings: baseline?.findings,
    capabilities: baseline?.capabilities,
    reviewedBaselineCheckedAt: reviewedBaseline?.checkedAt,
    requestEventId,
    requestedAt,
    reviewedAt,
    reviewer,
  };
  const parsed = parseMaintainerVerificationReview(review, baseline);
  if (!parsed) {
    throw new MaintainerVerificationReviewError(
      "verification-review-invalid",
      "Maintainer verification review is invalid or not eligible",
    );
  }
  return parsed;
}
