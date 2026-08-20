import { parseGitHubRepository } from "./github-repository.mjs";
import { sourceVerification } from "./verification-status.mjs";
import {
  resolveConfiguredSource,
  VerificationSubjectError,
} from "./verification-subject.mjs";

export const pluginUpdateAcknowledgment = "I understand that only the exact approved update commit can become a verified marketplace snapshot.";
export const pluginUpdateRequestHeadings = Object.freeze([
  "Plugin ID",
  "Repository URL",
  "Update commit",
  "Update acknowledgment",
]);

const pluginIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const fullCommitPattern = /^[a-f0-9]{40}$/i;

export class PluginUpdateError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "PluginUpdateError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function requestSections(body) {
  const text = String(body || "");
  const markers = [...text.matchAll(/^###\s+([^\r\n]+)\s*$/gm)].map((match) => ({
    heading: match[1].trim(),
    start: match.index,
    contentStart: match.index + match[0].length,
  }));
  if (
    markers.length !== pluginUpdateRequestHeadings.length
    || markers.some((marker, index) => marker.heading !== pluginUpdateRequestHeadings[index])
  ) {
    throw new PluginUpdateError(
      "update-fields-invalid",
      "Plugin update fields are missing, reordered, or malformed",
    );
  }
  return Object.fromEntries(markers.map((marker, index) => [
    marker.heading,
    text.slice(marker.contentStart, markers[index + 1]?.start ?? text.length).trim(),
  ]));
}

export function parsePluginUpdateRequest(body) {
  const sections = requestSections(body);
  const pluginId = sections["Plugin ID"];
  if (!pluginIdPattern.test(pluginId)) {
    throw new PluginUpdateError("update-plugin-id-invalid", "Plugin ID is invalid");
  }
  let repository;
  try {
    repository = parseGitHubRepository(sections["Repository URL"]);
  } catch {
    throw new PluginUpdateError(
      "update-repository-invalid",
      "Repository URL is invalid",
    );
  }
  const commitSha = sections["Update commit"].toLowerCase();
  if (!fullCommitPattern.test(commitSha)) {
    throw new PluginUpdateError(
      "update-commit-invalid",
      "Update commit must be a full commit SHA",
    );
  }
  const checkedAcknowledgment = new RegExp(
    `^- \\[x\\] ${pluginUpdateAcknowledgment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "im",
  );
  if (!checkedAcknowledgment.test(sections["Update acknowledgment"])) {
    throw new PluginUpdateError(
      "update-acknowledgment-missing",
      "Plugin update acknowledgment is required",
    );
  }
  return Object.freeze({
    pluginId,
    repository: repository.slug.toLowerCase(),
    repoUrl: `https://github.com/${repository.slug}`,
    commitSha,
  });
}

function mappedSubjectCode(code) {
  return ({
    "verification-plugin-not-listed": "update-plugin-not-listed",
    "verification-source-unsupported": "update-source-unsupported",
    "verification-repository-mismatch": "update-repository-mismatch",
  })[code] || "update-listing-invalid";
}

export function sourceForPluginUpdate(registry, request) {
  try {
    return resolveConfiguredSource(registry, request);
  } catch (error) {
    if (!(error instanceof VerificationSubjectError)) throw error;
    throw new PluginUpdateError(mappedSubjectCode(error.code), error.message, error.context);
  }
}

function sortedPluginIds(value) {
  return [...new Set(value || [])].sort();
}

export function assertPluginUpdateInspection(request, source, inspection, {
  allowCurrentCommit = false,
} = {}) {
  if (
    !inspection
    || String(inspection.repository || "").toLowerCase() !== request.repository
    || String(inspection.commitSha || "").toLowerCase() !== request.commitSha
  ) {
    throw new PluginUpdateError(
      "update-upstream-changed",
      "The repository HEAD no longer matches the requested update commit",
    );
  }
  const configuredPluginIds = Object.keys(source?.plugins || {}).sort();
  const inspectedPluginIds = sortedPluginIds(
    (inspection.manifests || []).map((manifest) => manifest.id),
  );
  if (
    !configuredPluginIds.length
    || JSON.stringify(configuredPluginIds) !== JSON.stringify(inspectedPluginIds)
  ) {
    throw new PluginUpdateError(
      "update-plugin-set-changed",
      "The update commit does not contain the exact configured plugin set",
    );
  }
  if (
    !allowCurrentCommit
    && String(source.listingValidatedCommit || "").toLowerCase() === request.commitSha
  ) {
    throw new PluginUpdateError(
      "update-already-current",
      "The requested commit is already the marketplace listing snapshot",
    );
  }
  return Object.freeze({
    source,
    pluginIds: Object.freeze(configuredPluginIds),
    manifests: Object.freeze([...(inspection.manifests || [])]),
    inspection,
  });
}

export function resolvePluginUpdate(registry, request, inspection, options = {}) {
  const source = sourceForPluginUpdate(registry, request);
  return assertPluginUpdateInspection(request, source, inspection, options);
}

export function listingValidationHistoryEntry(source, supersededAt) {
  const entry = {
    commit: source?.listingValidatedCommit,
    validatedAt: source?.listingValidatedAt,
    branch: source?.listingValidatedBranch,
    supersededAt,
    ...(source?.automatedSecurityBaseline
      ? { automatedSecurityBaseline: source.automatedSecurityBaseline }
      : {}),
    ...(source?.maintainerVerificationReview
      ? { maintainerVerificationReview: source.maintainerVerificationReview }
      : {}),
  };
  if (
    !fullCommitPattern.test(entry.commit || "")
    || !Number.isFinite(Date.parse(entry.validatedAt || ""))
    || !Number.isFinite(Date.parse(entry.supersededAt || ""))
    || typeof entry.branch !== "string"
    || !entry.branch
  ) {
    throw new PluginUpdateError(
      "update-listing-invalid",
      "The current listing provenance cannot be archived safely",
    );
  }
  return Object.freeze(entry);
}

export function promotePluginUpdateSource(source, inspection, {
  automatedSecurityBaseline,
  maintainerVerificationReview = null,
  promotedAt,
}) {
  if (!automatedSecurityBaseline || typeof automatedSecurityBaseline !== "object") {
    throw new PluginUpdateError(
      "update-security-baseline-invalid",
      "A complete update security baseline is required",
    );
  }
  if (!Number.isFinite(Date.parse(promotedAt || ""))) {
    throw new PluginUpdateError("update-time-invalid", "Update promotion time is invalid");
  }
  const currentCommit = String(source?.listingValidatedCommit || "").toLowerCase();
  const promotedCommit = String(inspection?.commitSha || "").toLowerCase();
  if (!fullCommitPattern.test(promotedCommit) || currentCommit === promotedCommit) {
    throw new PluginUpdateError(
      "update-already-current",
      "Update promotion requires a new exact commit",
    );
  }
  if (!Array.isArray(source?.listingValidationHistory || [])) {
    throw new PluginUpdateError(
      "update-history-invalid",
      "Listing validation history is invalid",
    );
  }
  const { maintainerVerificationReview: ignoredReview, ...sourceWithoutReview } = source;
  const nextSource = {
    ...sourceWithoutReview,
    listingValidatedCommit: promotedCommit,
    listingValidatedAt: promotedAt,
    listingValidatedBranch: inspection.defaultBranch,
    automatedSecurityBaseline,
    ...(maintainerVerificationReview ? { maintainerVerificationReview } : {}),
    listingValidationHistory: [
      ...(source.listingValidationHistory || []),
      listingValidationHistoryEntry(source, promotedAt),
    ],
  };
  if (sourceVerification(nextSource).status !== "verified") {
    throw new PluginUpdateError(
      "update-verification-invalid",
      "Promoted update evidence did not produce a commit-bound Verified snapshot",
    );
  }
  return Object.freeze(nextSource);
}

export function replacePluginUpdateSource(registry, source, nextSource) {
  return {
    ...registry,
    sources: (registry?.sources || []).map((candidate) => (
      candidate === source ? nextSource : candidate
    )),
  };
}

function safeInline(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9._/@:-]+/g, " ")
    .replaceAll("@", "@\u200b")
    .trim()
    .slice(0, 200);
}

export function buildPluginUpdateValidationReport(result) {
  const pluginIds = result.pluginIds.map((id) => `\`${safeInline(id)}\``).join(", ");
  return `<!-- marketplace-update-validation -->
## Plugin update validation

✅ Existing plugin source confirmed: [${safeInline(result.request.repository)}](${result.request.repoUrl})
✅ Exact configured plugin set confirmed: ${pluginIds}
✅ Quattro compatibility passed at update commit \`${safeInline(result.request.commitSha.slice(0, 7))}…\`

**Ready for verified update review.** The automated security baseline must complete before a maintainer applies \`approved-and-verified\`. The current verified snapshot remains unchanged until publication succeeds.
`;
}

export function publicPluginUpdateFailure(error) {
  const code = String(error?.code || "update-internal-error");
  const reasons = {
    "update-fields-invalid": "Use the plugin update issue form without changing its headings.",
    "update-plugin-id-invalid": "Enter the exact existing plugin ID.",
    "update-repository-invalid": "Enter the existing public GitHub repository root URL.",
    "update-commit-invalid": "Enter the full 40-character update commit SHA.",
    "update-acknowledgment-missing": "Confirm the plugin update acknowledgment.",
    "update-plugin-not-listed": "The plugin ID does not identify an existing community listing.",
    "update-source-unsupported": "This update workflow supports plugin-source listings, not shell suites.",
    "update-repository-mismatch": "The repository does not match the existing listing.",
    "update-upstream-changed": "The repository HEAD changed or does not match the requested update commit. Update the issue to the current full SHA.",
    "update-plugin-set-changed": "Plugin updates cannot add, remove, or rename configured plugin IDs.",
    "update-compatibility-invalid": "The update commit did not pass marketplace compatibility validation.",
    "update-already-current": "The requested commit is already the marketplace listing snapshot.",
    "update-listing-invalid": "The current marketplace listing cannot be updated safely.",
    "update-security-baseline-invalid": "The update security baseline is missing, stale, or belongs to another snapshot.",
    "update-verification-invalid": "The update evidence did not produce a valid verified snapshot.",
    "security-baseline-unavailable": "The exact update commit could not be scanned completely.",
    "security-baseline-scan-limit": "The exact update commit exceeds a deterministic scan limit.",
  };
  return Object.freeze({
    code: Object.hasOwn(reasons, code) ? code : "update-internal-error",
    reason: reasons[code] || "The plugin update service could not complete safely.",
  });
}
