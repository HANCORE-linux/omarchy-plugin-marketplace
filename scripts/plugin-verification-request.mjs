import { parseGitHubRepository } from "./github-repository.mjs";

export const listedSnapshotVerificationAction = "Verify the currently listed snapshot";
export const standardInstallationVerificationAction = "Verify the listed snapshot and enable standard installation";
export const upstreamUpdateVerificationAction = "Verify and publish a newer upstream commit";
export const pluginVerificationAcknowledgment = "I understand that only the exact target commit can become a verified marketplace snapshot and that verification is not a security audit.";
export const standardInstallationAcknowledgment = "I confirm that this listed root plugin supports the standard Omarchy installation path and does not require manual setup.";
export const legacyListedSnapshotAcknowledgment = "I understand that automated verification applies only to the exact listed commit and is not a security audit.";
export const pluginVerificationRequestHeadings = Object.freeze([
  "Verification action",
  "Plugin ID",
  "Repository URL",
  "Target commit",
  "Verification acknowledgment",
  "Standard installation acknowledgment",
]);
const previousPluginVerificationRequestHeadings = Object.freeze([
  "Verification action",
  "Plugin ID",
  "Repository URL",
  "Target commit",
  "Verification acknowledgment",
]);
const legacyListedSnapshotHeadings = Object.freeze([
  "Plugin ID",
  "Repository URL",
  "Listed commit",
  "Verification acknowledgment",
]);

const pluginIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const fullCommitPattern = /^[a-f0-9]{40}$/i;

export class PluginVerificationRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PluginVerificationRequestError";
    this.code = code;
  }
}

function requestSections(body, headings) {
  const text = String(body || "");
  const markers = [...text.matchAll(/^###\s+([^\r\n]+)\s*$/gm)].map((match) => ({
    heading: match[1].trim(),
    start: match.index,
    contentStart: match.index + match[0].length,
  }));
  if (
    markers.length !== headings.length
    || markers.some((marker, index) => marker.heading !== headings[index])
  ) {
    throw new PluginVerificationRequestError(
      "request-fields-invalid",
      "Plugin verification fields are missing, reordered, or malformed",
    );
  }
  return Object.fromEntries(markers.map((marker, index) => [
    marker.heading,
    text.slice(marker.contentStart, markers[index + 1]?.start ?? text.length).trim(),
  ]));
}

function parseIdentity(sections, { commitHeading, acknowledgment }) {
  const pluginId = sections["Plugin ID"];
  if (!pluginIdPattern.test(pluginId)) {
    throw new PluginVerificationRequestError("request-plugin-id-invalid", "Plugin ID is invalid");
  }
  let repository;
  try {
    repository = parseGitHubRepository(sections["Repository URL"]);
  } catch {
    throw new PluginVerificationRequestError(
      "request-repository-invalid",
      "Repository URL is invalid",
    );
  }
  const commitSha = sections[commitHeading].toLowerCase();
  if (!fullCommitPattern.test(commitSha)) {
    throw new PluginVerificationRequestError(
      "request-commit-invalid",
      "Target commit must be a full commit SHA",
    );
  }
  const checkedAcknowledgment = new RegExp(
    `^- \\[x\\] ${acknowledgment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "im",
  );
  if (!checkedAcknowledgment.test(sections["Verification acknowledgment"])) {
    throw new PluginVerificationRequestError(
      "request-acknowledgment-missing",
      "Plugin verification acknowledgment is required",
    );
  }
  return {
    pluginId,
    repository: repository.slug.toLowerCase(),
    repoUrl: `https://github.com/${repository.slug}`,
    commitSha,
  };
}

export function parsePluginVerificationIssue(body, { expectedAction } = {}) {
  let sections;
  try {
    sections = requestSections(body, pluginVerificationRequestHeadings);
  } catch (error) {
    if (!(error instanceof PluginVerificationRequestError) || error.code !== "request-fields-invalid") throw error;
    sections = requestSections(body, previousPluginVerificationRequestHeadings);
  }
  const action = sections["Verification action"];
  if (
    ![listedSnapshotVerificationAction, standardInstallationVerificationAction, upstreamUpdateVerificationAction].includes(action)
    || (expectedAction && action !== expectedAction)
  ) {
    throw new PluginVerificationRequestError(
      "request-action-invalid",
      "Select the verification action that matches the requested snapshot",
    );
  }
  if (
    action === standardInstallationVerificationAction
    && sections["Standard installation acknowledgment"] !== `- [x] ${standardInstallationAcknowledgment}`
  ) {
    throw new PluginVerificationRequestError(
      "request-standard-installation-acknowledgment-missing",
      "Standard installation acknowledgment is required",
    );
  }
  return Object.freeze({
    action,
    ...parseIdentity(sections, {
      commitHeading: "Target commit",
      acknowledgment: pluginVerificationAcknowledgment,
    }),
  });
}

export function parseLegacyListedSnapshotVerificationIssue(body) {
  const sections = requestSections(body, legacyListedSnapshotHeadings);
  return Object.freeze({
    action: listedSnapshotVerificationAction,
    ...parseIdentity(sections, {
      commitHeading: "Listed commit",
      acknowledgment: legacyListedSnapshotAcknowledgment,
    }),
  });
}
