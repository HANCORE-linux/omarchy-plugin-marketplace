import {
  securityBaselineBlocksApproval,
  securityBaselineErrorMarker,
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
  const lines = [];
  if (result.outcome === "passed") {
    lines.push(
      `✅ **Automated security baseline passed at commit \`${commitDisplay(result.commitSha)}\`.**`,
      "",
      "No action is required.",
    );
  } else if (result.outcome === "review-required") {
    lines.push(
      verification
        ? `🟡 **Capabilities prevent automated verification at commit \`${commitDisplay(result.commitSha)}\`.**`
        : `🟡 **Manual review required at commit \`${commitDisplay(result.commitSha)}\`.**`,
      "",
      verification
        ? "No source change is necessarily required. An authorized marketplace maintainer may accept these capabilities for this exact commit; otherwise a later passing automated baseline is required."
        : "No change is necessarily required. A marketplace maintainer must review these capabilities before approval.",
      "",
      heading(headingLevel, "Capabilities detected"),
      "",
    );
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
  } else {
    const blocked = securityBaselineBlocksApproval(result);
    lines.push(
      verification
        ? `🔴 **Patterns prevent automated verification at commit \`${commitDisplay(result.commitSha)}\`.**`
        : `🔴 **Patterns requiring maintainer review detected at commit \`${commitDisplay(result.commitSha)}\`.**`,
      "",
      verification
        ? "These findings prevent an automated passing verification result."
        : blocked
          ? "Approval is blocked because selective enforcement applies to at least one critical finding."
          : "These findings require maintainer review but are not part of selective enforcement and do not automatically block approval.",
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
      : blocked
        ? "Fix the blocking path and rerun validation before approval."
        : "Prefer fixing the reported path. A maintainer may approve this exact commit after review.");
  }
  return lines.join("\n").trim();
}

export function buildSecurityBaselineReport(result) {
  return `${[
    serializeSecurityBaselineMarker(result),
    "## Automated security baseline",
    "",
    buildSecurityBaselineDetails(result),
    "",
    "This deterministic baseline detects only its documented patterns and is not designed to stop a motivated attacker.",
    "",
    "This is not a security audit, certification, warranty, or endorsement.",
  ].join("\n").trim()}\n`;
}

export function buildSecurityBaselineFailureReport(error) {
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

No approval is possible until this check completes. If the repository exceeds a scan limit, reduce generated or unrelated runtime files; otherwise edit the submission issue to retry.

This deterministic baseline detects only its documented patterns and is not designed to stop a motivated attacker.

This is not a security audit, certification, warranty, or endorsement.
`;
}
