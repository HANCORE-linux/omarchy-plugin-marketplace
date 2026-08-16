import {
  CatalogVerificationProjectionError,
  projectCatalogSourceVerification,
} from "./catalog-verification.mjs";
import { parseGitHubRepository } from "./github-repository.mjs";
import { buildSecurityBaselineDetails } from "./security-baseline-report.mjs";
import { runSecurityBaseline } from "./security-baseline-scanner.mjs";
import {
  SecurityBaselineRecordError,
  toStoredSecurityBaselineRecord,
} from "./security-baseline-record.mjs";
import { sourceVerification } from "./verification-status.mjs";
import {
  resolveListedSource,
  resolveVerificationSubject,
  VerificationSubjectError,
} from "./verification-subject.mjs";

export const verificationAcknowledgment = "I understand that automated verification applies only to the exact listed commit and is not a security audit.";
export const verificationRequestHeadings = Object.freeze([
  "Plugin ID",
  "Repository URL",
  "Listed commit",
  "Verification acknowledgment",
]);

const pluginIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const fullCommitPattern = /^[a-f0-9]{40}$/i;
const reportMarker = "<!-- marketplace-plugin-verification -->";

export class PluginVerificationError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "PluginVerificationError";
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
    markers.length !== verificationRequestHeadings.length
    || markers.some((marker, index) => marker.heading !== verificationRequestHeadings[index])
  ) {
    throw new PluginVerificationError(
      "verification-fields-invalid",
      "Verification request fields are missing, reordered, or malformed",
    );
  }
  return Object.fromEntries(markers.map((marker, index) => [
    marker.heading,
    text.slice(marker.contentStart, markers[index + 1]?.start ?? text.length).trim(),
  ]));
}

export function parseVerificationRequest(body) {
  const sections = requestSections(body);
  const pluginId = sections["Plugin ID"];
  if (!pluginIdPattern.test(pluginId)) {
    throw new PluginVerificationError("verification-plugin-id-invalid", "Plugin ID is invalid");
  }

  let repository;
  try {
    repository = parseGitHubRepository(sections["Repository URL"]);
  } catch {
    throw new PluginVerificationError(
      "verification-repository-invalid",
      "Repository URL is invalid",
    );
  }
  const commitSha = sections["Listed commit"].toLowerCase();
  if (!fullCommitPattern.test(commitSha)) {
    throw new PluginVerificationError(
      "verification-commit-invalid",
      "Listed commit must be a full commit SHA",
    );
  }
  const acknowledgment = sections["Verification acknowledgment"];
  const checkedAcknowledgment = new RegExp(
    `^- \\[x\\] ${verificationAcknowledgment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "im",
  );
  if (!checkedAcknowledgment.test(acknowledgment)) {
    throw new PluginVerificationError(
      "verification-acknowledgment-missing",
      "Verification acknowledgment is required",
    );
  }
  return Object.freeze({
    pluginId,
    repository: repository.slug.toLowerCase(),
    repoUrl: `https://github.com/${repository.slug}`,
    commitSha,
  });
}

function sourceRepository(source) {
  try {
    return parseGitHubRepository(source?.repo).slug.toLowerCase();
  } catch {
    return "";
  }
}

export function listedSourceForRequest(registry, request) {
  try {
    return resolveListedSource(registry, request);
  } catch (error) {
    if (!(error instanceof VerificationSubjectError)) throw error;
    throw new PluginVerificationError(error.code, error.message, error.context);
  }
}

function sourcePluginIds(source) {
  const ids = Object.keys(source?.plugins || {});
  if (source?.catalog?.id) ids.push(source.catalog.id);
  return ids.sort();
}

export function verificationBaselineRecord(baseline, source) {
  try {
    return toStoredSecurityBaselineRecord(baseline, {
      expectedRepository: sourceRepository(source),
      expectedCommit: source.listingValidatedCommit,
      pluginIds: sourcePluginIds(source),
    });
  } catch (error) {
    if (!(error instanceof SecurityBaselineRecordError)) throw error;
    throw new PluginVerificationError(
      "verification-baseline-invalid",
      "Automated baseline result is invalid or belongs to another listing",
    );
  }
}

function replaceSource(registry, target, replacement) {
  return {
    ...registry,
    sources: (registry.sources || []).map((source) => source === target ? replacement : source),
  };
}

export function updateCatalogVerification(catalog, source, pluginId = "", options = {}) {
  try {
    return projectCatalogSourceVerification(catalog, source, {
      requiredPluginId: pluginId,
      generatedAt: options.generatedAt || "",
    });
  } catch (error) {
    if (!(error instanceof CatalogVerificationProjectionError)) throw error;
    throw new PluginVerificationError(error.code, error.message);
  }
}

export async function analyzeListedPluginVerification({
  body,
  registry,
  catalog,
  runBaseline = runSecurityBaseline,
  token,
  now = () => new Date().toISOString(),
}) {
  const request = parseVerificationRequest(body);
  let subject;
  try {
    subject = resolveVerificationSubject(registry, catalog, request);
  } catch (error) {
    if (!(error instanceof VerificationSubjectError)) throw error;
    throw new PluginVerificationError(error.code, error.message, error.context);
  }
  const source = subject.source;
  if (sourceVerification(source).status === "verified") {
    const nextCatalog = updateCatalogVerification(catalog, source, request.pluginId, {
      generatedAt: now(),
    });
    const changed = nextCatalog !== catalog;
    return Object.freeze({
      status: changed ? "verified" : "already-verified",
      changed,
      request,
      subject,
      source,
      registry,
      catalog: nextCatalog,
      baseline: source.automatedSecurityBaseline,
    });
  }

  const baseline = await runBaseline(source.repo, request.commitSha, {
    token,
    listedPlugins: subject.listedPlugins,
  });
  const record = verificationBaselineRecord(baseline, source);
  if (record.outcome !== "passed") {
    return Object.freeze({
      status: "unverified",
      changed: false,
      request,
      subject,
      source,
      registry,
      catalog,
      baseline: record,
      scanResult: baseline,
    });
  }

  const nextSource = { ...source, automatedSecurityBaseline: record };
  const nextRegistry = replaceSource(registry, source, nextSource);
  const nextCatalog = updateCatalogVerification(catalog, nextSource, request.pluginId, {
    generatedAt: record.checkedAt,
  });
  return Object.freeze({
    status: "verified",
    changed: JSON.stringify(nextRegistry) !== JSON.stringify(registry)
      || JSON.stringify(nextCatalog) !== JSON.stringify(catalog),
    request,
    subject: Object.freeze({ ...subject, source: nextSource }),
    source: nextSource,
    registry: nextRegistry,
    catalog: nextCatalog,
    baseline: record,
    scanResult: baseline,
  });
}

function safeInline(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9._/@:-]+/g, " ")
    .replaceAll("@", "@\u200b")
    .trim()
    .slice(0, 200);
}

export function buildVerificationReport(result) {
  const pluginId = safeInline(result?.request?.pluginId || "plugin");
  const commit = safeInline(result?.request?.commitSha || "").slice(0, 7);
  const lines = [reportMarker, "## Automated plugin verification", ""];
  if (["verified", "already-verified"].includes(result?.status)) {
    lines.push(
      `✅ **Verified** \`${pluginId}\` at listed commit \`${commit}…\`.`,
      "",
      result.status === "already-verified"
        ? "A current passing automated baseline was already recorded."
        : "Automated checks passed and the commit-bound verification record is ready for publication.",
    );
  } else if (result?.status === "unverified") {
    lines.push(
      `⚪ **Unverified** \`${pluginId}\` at listed commit \`${commit}…\`.`,
      "",
      `The automated baseline result was \`${safeInline(result.baseline?.outcome)}\`. A passing result is required for verification.`,
    );
    if (result.scanResult) {
      lines.push(
        "",
        buildSecurityBaselineDetails(result.scanResult, {
          headingLevel: 3,
          context: "verification",
        }),
      );
    }
  } else {
    lines.push(
      "⚠️ **Verification could not complete.**",
      "",
      safeInline(result?.reason || "The request or static scan could not be verified."),
    );
  }
  if ((result?.subject?.pluginIds || []).length > 1) {
    lines.push(
      "",
      `This source-wide result applies to: ${result.subject.pluginIds.map((id) => `\`${safeInline(id)}\``).join(", ")}.`,
    );
  }
  lines.push(
    "",
    "Automated verification applies only to the exact listed commit. It is not a security audit, certification, warranty, or endorsement.",
  );
  return `${lines.join("\n")}\n`;
}

export function publicVerificationFailure(error) {
  const code = String(error?.code || "verification-internal-error");
  const reasons = {
    "verification-fields-invalid": "Use the verification issue form without changing its headings.",
    "verification-plugin-id-invalid": "Enter the exact existing plugin ID.",
    "verification-repository-invalid": "Enter the existing public GitHub repository root URL.",
    "verification-commit-invalid": "Enter the full 40-character listed commit SHA.",
    "verification-acknowledgment-missing": "Confirm the verification acknowledgment.",
    "verification-plugin-not-listed": "The plugin ID does not identify an existing community listing.",
    "verification-source-unsupported": "This first verification workflow supports plugin-source listings, not shell suites.",
    "verification-repository-mismatch": "The repository does not match the existing listing.",
    "verification-commit-mismatch": "Only the existing listed commit can be verified in this workflow.",
    "verification-catalog-listing-missing": "The existing listing is missing from the generated catalog.",
    "verification-catalog-plugin-set-mismatch": "The catalog plugin set does not match the registry source.",
    "verification-baseline-invalid": "The static result could not be bound to the existing listing.",
    "security-baseline-unavailable": "The exact listed commit could not be scanned completely.",
    "security-baseline-scan-limit": "The exact listed commit exceeds a deterministic scan limit.",
  };
  return {
    status: "error",
    changed: false,
    code: Object.hasOwn(reasons, code) ? code : "verification-internal-error",
    reason: reasons[code] || "The verification service could not complete safely.",
  };
}
