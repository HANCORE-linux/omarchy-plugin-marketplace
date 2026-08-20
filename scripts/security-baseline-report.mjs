import {
  securityBaselineErrorMarker,
  verifiedPublicationDisposition,
} from "./security-baseline-policy.mjs";
import { serializeSecurityBaselineMarker } from "./security-baseline-record.mjs";

function safeMarkdownText(value) {
  return String(value || "")
    .replace(/[<>`\r\n]+/g, " ")
    .replaceAll("\\", "\\\\")
    .replace(/([*_\[\]()~|])/g, "\\$1")
    .replaceAll("@", "@\u200b")
    .trim();
}

function commitDisplay(commitSha) {
  return `${commitSha.slice(0, 7)}…`;
}

function evidenceMarkdown(result, entries) {
  return entries.map((entry) => {
    const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
    const url = `https://github.com/${result.repository}/blob/${result.commitSha}/${encodedPath}#L${entry.line}`;
    return `- [\`${safeMarkdownText(entry.path)}:${entry.line}\`](${url})\n\n      ${safeMarkdownText(entry.snippet)}`;
  }).join("\n");
}

function heading(level, text) {
  return `${"#".repeat(level)} ${text}`;
}

export function buildSecurityBaselineDetails(result, {
  headingLevel = 3,
  context = "submission",
} = {}) {
  const verification = context === "verification";
  const update = context === "update";
  const publicationReview = !verification
    && verifiedPublicationDisposition(result) === "review-required";
  const lines = [];
  if (result.outcome === "passed") {
    lines.push(
      `✅ **Automated security baseline passed at commit \`${commitDisplay(result.commitSha)}\`.**`,
      "",
      "No action is required.",
    );
  } else if (result.outcome === "review-required" || publicationReview) {
    lines.push(
      verification
        ? `🟡 **Capabilities prevent automated verification at commit \`${commitDisplay(result.commitSha)}\`.**`
        : `🟡 **Manual review required at commit \`${commitDisplay(result.commitSha)}\`.**`,
      "",
      verification
        ? "No source change is necessarily required. An authorized marketplace maintainer may accept these capabilities for this exact commit; otherwise a later passing automated baseline is required."
        : publicationReview && result.findings.length
          ? "Selective policy permits an authorized marketplace maintainer to accept these non-blocking findings and capabilities for this exact commit through `approved-and-verified`; otherwise apply the accepted fixes."
          : "No change is necessarily required. A marketplace maintainer must review these capabilities before applying `approved-and-verified`.",
      "",
    );
    if (result.findings.length) {
      lines.push(heading(headingLevel, "Findings requiring review"), "");
      for (const finding of result.findings) {
        lines.push(
          heading(headingLevel + 1, `${finding.title} (\`${finding.ruleId}\`)`),
          "",
          finding.why,
          "",
          evidenceMarkdown(result, finding.evidence),
          "",
          "Accepted fixes:",
          ...finding.actions.map((action) => `- ${action}`),
          "",
        );
      }
    }
    if (result.capabilities.length) {
      lines.push(heading(headingLevel, "Capabilities detected"), "");
      for (const item of result.capabilities) {
        lines.push(
          heading(headingLevel + 1, `${item.title} (\`${item.id}\`)`),
          "",
          item.why,
          "",
          evidenceMarkdown(result, item.evidence),
          "",
        );
      }
    }
  } else {
    lines.push(
      verification
        ? `🔴 **Patterns prevent automated verification at commit \`${commitDisplay(result.commitSha)}\`.**`
        : update
          ? `🔴 **Patterns must be fixed before verified update at commit \`${commitDisplay(result.commitSha)}\`.**`
          : `🔴 **Patterns must be fixed before verified listing at commit \`${commitDisplay(result.commitSha)}\`.**`,
      "",
      verification
        ? "These findings prevent an automated passing verification result."
        : update
          ? "This result contains selectively blocking findings that cannot be accepted through `approved-and-verified`."
          : "This result contains selectively blocking findings that cannot be accepted through `approved-and-verified`.",
      "",
    );
    for (const finding of result.findings) {
      lines.push(
        heading(headingLevel, `${finding.title} (\`${finding.ruleId}\`)`),
        "",
        finding.why,
        "",
        evidenceMarkdown(result, finding.evidence),
        "",
        "Accepted fixes:",
        ...finding.actions.map((action) => `- ${action}`),
        "",
      );
    }
    lines.push(verification
      ? "Apply the accepted fixes in a plugin update. Only a later `passed` baseline can produce `Verified`."
      : update
        ? "Fix every selectively blocking finding in a new commit and rerun update validation before requesting approval."
        : "Fix every selectively blocking finding and rerun validation before requesting approval.");
  }
  return lines.join("\n").trim();
}

export function buildSecurityBaselineReport(result, options = {}) {
  return `${[
    serializeSecurityBaselineMarker(result),
    "## Automated security baseline",
    "",
    buildSecurityBaselineDetails(result, options),
    "",
    "This deterministic baseline detects only its documented patterns and is not designed to stop a motivated attacker.",
    "",
    "This is not a security audit, certification, warranty, or endorsement.",
  ].join("\n").trim()}\n`;
}

export function buildSecurityBaselineFailureReport(error, { context = "submission" } = {}) {
  const code = String(error?.code || "security-baseline-unavailable");
  const path = String(error?.context?.path || "")
    .replace(/[^A-Za-z0-9._/-]/g, "")
    .slice(0, 200);
  const scanLimit = code === "security-baseline-scan-limit";
  const detail = scanLimit && path
    ? `The static scan could not safely process \`${path}\` within its configured limits.`
    : scanLimit
      ? "The repository exceeds the limits for a complete static scan."
      : "The repository snapshot could not be scanned completely.";
  return `${securityBaselineErrorMarker}
## Automated security baseline

⚠️ **Baseline could not complete.**

${detail}

No approval is possible until this check completes. If the repository exceeds a scan limit, reduce generated or unrelated runtime files; otherwise edit the ${context === "update" ? "plugin update" : "submission"} issue to retry.

This deterministic baseline detects only its documented patterns and is not designed to stop a motivated attacker.

This is not a security audit, certification, warranty, or endorsement.
`;
}
