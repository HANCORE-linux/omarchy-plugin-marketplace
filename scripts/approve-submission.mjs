import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectSubmission, parseGitHubRepository } from "./build-catalog.mjs";
import {
  assertRightsConfirmation,
  hasRightsConfirmation,
  isLegacySubmission,
  parseIssueSubmission,
  parseSubmissionBody,
  rightsStatement,
} from "./submission.mjs";
import { publicSubmissionFailure } from "./submission-feedback.mjs";
import {
  assertApprovalAllowed,
  findLatestSecurityBaseline,
  isConsistentSecurityBaselineSummary,
  securityBaselineEnforcementMode,
  securityBaselineVersion,
} from "./security-baseline.mjs";

export {
  assertRightsConfirmation,
  hasRightsConfirmation,
  isLegacySubmission,
  parseSubmissionBody,
  rightsStatement,
};

export const manualSetupNote = "This plugin requires additional setup before it can be enabled. Follow the upstream installation instructions.";

export class SubmissionApprovalError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "SubmissionApprovalError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function canApprove(permission) {
  return new Set(["admin", "maintain", "write"]).has(String(permission || "").toLowerCase());
}

export function assertApprovedIssueBody(currentBody, approvedBody) {
  if (typeof approvedBody !== "string") {
    throw new SubmissionApprovalError(
      "approval-body-changed",
      "APPROVED_ISSUE_BODY is required",
    );
  }
  if (String(currentBody || "") !== approvedBody) {
    throw new SubmissionApprovalError(
      "approval-body-changed",
      "The submission changed after approval; review it again before reapplying approved-for-listing",
    );
  }
}

export function parseApprovableSubmission(issue) {
  return parseIssueSubmission(issue);
}

export function createRegistrySource({
  submission,
  manifests,
  addedAt,
  listedAt,
  listingValidatedCommit,
  listingValidatedAt,
  listingValidatedBranch,
  automatedSecurityBaseline = null,
  manualSetup = false,
}) {
  if (typeof manualSetup !== "boolean") throw new TypeError("manualSetup must be a boolean");
  if (automatedSecurityBaseline !== null && typeof automatedSecurityBaseline !== "object") {
    throw new TypeError("automatedSecurityBaseline must be an object or null");
  }
  const plugins = Object.fromEntries(
    manifests.map((manifest) => [
      manifest.id,
      {
        category: submission.category,
        tags: submission.tags,
        ...(manualSetup
          ? {
              installation: {
                mode: "manual",
                note: manualSetupNote,
              },
            }
          : {}),
      },
    ]),
  );

  return {
    repo: submission.repo,
    type: "plugin-source",
    addedAt,
    listedAt,
    listingValidatedCommit,
    listingValidatedAt,
    listingValidatedBranch,
    ...(automatedSecurityBaseline ? { automatedSecurityBaseline } : {}),
    plugins,
  };
}

export function createApprovedSecurityBaseline(baseline) {
  if (!baseline || baseline.baselineVersion !== securityBaselineVersion) {
    throw new SubmissionApprovalError(
      "approval-security-baseline-invalid",
      "The automated security baseline metadata is invalid",
    );
  }
  if (
    !/^[a-f0-9]{40}$/.test(baseline.commitSha || "")
    || baseline.enforcementMode !== securityBaselineEnforcementMode
    || !isConsistentSecurityBaselineSummary(baseline)
    || !Number.isFinite(Date.parse(baseline.checkedAt || ""))
  ) {
    throw new SubmissionApprovalError(
      "approval-security-baseline-invalid",
      "The automated security baseline metadata is invalid",
    );
  }
  const record = {
    version: baseline.baselineVersion,
    commit: baseline.commitSha,
    checkedAt: baseline.checkedAt,
    outcome: baseline.outcome,
    enforcementMode: baseline.enforcementMode,
    findings: [...baseline.findings],
    capabilities: [...baseline.capabilities],
  };
  return record;
}

function approvalPluginMetadata(plugins = {}) {
  return Object.fromEntries(
    Object.entries(plugins)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, plugin]) => [
        id,
        {
          category: plugin.category,
          tags: plugin.tags,
          ...(Object.hasOwn(plugin, "installation")
            ? { installation: plugin.installation }
            : {}),
        },
      ]),
  );
}

export function addRegistrySource(
  registry,
  source,
  existingPluginIds = [],
  retiredPluginIds = [],
) {
  const sources = Array.isArray(registry.sources) ? registry.sources : [];
  const candidate = parseGitHubRepository(source.repo).slug.toLowerCase();
  const existingSource = sources.find(
    (entry) => parseGitHubRepository(entry.repo).slug.toLowerCase() === candidate,
  );
  if (existingSource) {
    const existingIds = Object.keys(existingSource.plugins || {}).sort();
    const candidateIds = Object.keys(source.plugins || {}).sort();
    if (JSON.stringify(existingIds) !== JSON.stringify(candidateIds)) {
      throw new SubmissionApprovalError(
        "approval-source-changed",
        `${source.repo} is already registered with a different plugin set`,
      );
    }
    if (
      JSON.stringify(approvalPluginMetadata(existingSource.plugins))
      === JSON.stringify(approvalPluginMetadata(source.plugins))
    ) {
      return registry;
    }
    throw new SubmissionApprovalError(
      "approval-metadata-changed",
      `${source.repo} is already registered with different listing metadata`,
    );
  }

  const existing = new Set(existingPluginIds);
  const retired = new Set(retiredPluginIds);
  for (const pluginId of Object.keys(source.plugins)) {
    if (retired.has(pluginId)) {
      throw new SubmissionApprovalError(
        "plugin-id-retired",
        `Plugin ID "${pluginId}" was used by a previous listing`,
        { pluginId },
      );
    }
    if (existing.has(pluginId)) {
      throw new SubmissionApprovalError(
        "plugin-id-listed",
        `Plugin ID "${pluginId}" is already listed`,
        { pluginId },
      );
    }
  }

  return { ...registry, sources: [...sources, source] };
}

async function githubApi(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "omarchy-plugin-marketplace-approval",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} for ${path}`);
  }
  return response.json();
}

async function githubIssueComments(repositoryName, issueNumber, token) {
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await githubApi(
      `/repos/${repositoryName}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      token,
    );
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new SubmissionApprovalError(
    "approval-security-baseline-invalid",
    "The submission has too many comments to locate its security baseline safely",
  );
}

function safeMarkdownText(value) {
  return String(value)
    .replace(/[<>`\r\n]+/g, " ")
    .trim()
    .replaceAll("\\", "\\\\")
    .replace(/([*_\[\]()~|])/g, "\\$1")
    .replaceAll("@", "@\u200b");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseManualSetupApproval(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("MANUAL_SETUP must be true or false");
}

export async function recheckApprovalState({
  repositoryName,
  issueNumber,
  token,
  approvedIssueBody,
  repoUrl,
  approver,
  expectedManualSetup,
}) {
  const [issue, inspection, comments, permission] = await Promise.all([
    githubApi(`/repos/${repositoryName}/issues/${issueNumber}`, token),
    inspectSubmission(repoUrl),
    githubIssueComments(repositoryName, issueNumber, token),
    githubApi(
      `/repos/${repositoryName}/collaborators/${encodeURIComponent(approver)}/permission`,
      token,
    ),
  ]);
  if (issue.pull_request || issue.state !== "open") {
    throw new SubmissionApprovalError(
      "approval-issue-closed",
      "Approval requires an open submission issue",
    );
  }
  if (!canApprove(permission.permission)) {
    throw new SubmissionApprovalError(
      "approval-permission-denied",
      `${approver} does not have write permission to approve submissions`,
    );
  }
  assertApprovedIssueBody(issue.body, approvedIssueBody);
  const labels = new Set((issue.labels || []).map((label) => typeof label === "string" ? label : label.name));
  for (const required of ["submission", "validated", "approved-for-listing"]) {
    if (!labels.has(required)) {
      throw new SubmissionApprovalError(
        "approval-label-missing",
        `Issue #${issueNumber} is missing the "${required}" label`,
      );
    }
  }
  if (
    typeof expectedManualSetup === "boolean"
    && labels.has("manual-setup") !== expectedManualSetup
  ) {
    throw new SubmissionApprovalError(
      "approval-label-changed",
      "The manual-setup label changed after approval started",
    );
  }
  const baseline = findLatestSecurityBaseline(comments);
  assertApprovalAllowed(issue, baseline, inspection, repoUrl);
  return { issue, inspection, baseline };
}

async function main() {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repositoryName = requiredEnvironment("GITHUB_REPOSITORY");
  const approver = requiredEnvironment("APPROVER_LOGIN");
  const issueNumber = Number.parseInt(requiredEnvironment("ISSUE_NUMBER"), 10);
  const approvedIssueBody = process.env.APPROVED_ISSUE_BODY;
  const manualSetup = parseManualSetupApproval(requiredEnvironment("MANUAL_SETUP"));
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("ISSUE_NUMBER must be positive");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName)) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }

  const initialIssue = await githubApi(`/repos/${repositoryName}/issues/${issueNumber}`, token);
  const submission = parseApprovableSubmission(initialIssue);
  const {
    issue,
    inspection,
    baseline: securityBaseline,
  } = await recheckApprovalState({
    repositoryName,
    issueNumber,
    token,
    approvedIssueBody,
    repoUrl: submission.repo,
    approver,
    expectedManualSetup: manualSetup,
  });
  const root = resolve(import.meta.dirname, "..");
  const registryPath = resolve(root, "registry.json");
  const catalogPath = resolve(root, "site/catalog.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const listedAt = new Date().toISOString();
  const addedAt = listedAt.slice(0, 10);
  const source = createRegistrySource({
    submission,
    manifests: inspection.manifests,
    addedAt,
    listedAt,
    listingValidatedCommit: inspection.commitSha,
    listingValidatedAt: listedAt,
    listingValidatedBranch: inspection.defaultBranch,
    automatedSecurityBaseline: createApprovedSecurityBaseline(securityBaseline),
    manualSetup,
  });
  const nextRegistry = addRegistrySource(
    registry,
    source,
    (catalog.plugins || []).map((plugin) => plugin.id),
    registry.retiredPluginIds,
  );

  if (JSON.stringify(nextRegistry) !== JSON.stringify(registry)) {
    const registryTemp = `${registryPath}.tmp-${process.pid}`;
    await writeFile(registryTemp, `${JSON.stringify(nextRegistry, null, 2)}\n`);
    await rename(registryTemp, registryPath);
  }

  const firstPlugin = inspection.manifests[0];
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const safeName = String(firstPlugin.name).replace(/[\r\n]+/g, " ").trim();
    await appendFile(
      output,
      `plugin_id=${firstPlugin.id}\nplugin_name=${safeName}\nplugin_name_markdown=${safeMarkdownText(safeName)}\nsubmission_repo_url=${submission.repo}\nsubmission_repository=${inspection.repository}\napproved_commit=${inspection.commitSha}\n`,
    );
  }
  console.log(
    `Approved issue #${issueNumber}: added ${inspection.manifests.length} plugin manifest(s) from ${submission.repo}`,
  );
}

async function verifyMain() {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repositoryName = requiredEnvironment("GITHUB_REPOSITORY");
  const approver = requiredEnvironment("APPROVER_LOGIN");
  const issueNumber = Number.parseInt(requiredEnvironment("ISSUE_NUMBER"), 10);
  const approvedIssueBody = process.env.APPROVED_ISSUE_BODY;
  const repoUrl = requiredEnvironment("SUBMISSION_REPO_URL");
  const expectedManualSetup = parseManualSetupApproval(
    requiredEnvironment("MANUAL_SETUP"),
  );
  await recheckApprovalState({
    repositoryName,
    issueNumber,
    token,
    approvedIssueBody,
    repoUrl,
    approver,
    expectedManualSetup,
  });
  console.log(`Approval state for issue #${issueNumber} is still current.`);
}

export async function recordApprovalFailure(error, output = process.env.GITHUB_OUTPUT) {
  const failure = publicSubmissionFailure(error, { phase: "approval" });
  if (output) {
    await appendFile(
      output,
      `failure_code=${failure.code}\nfailure_reason=${failure.reason}\nfailure_action=${failure.action}\n`,
    );
  }
  return failure;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const command = process.argv.includes("--verify-current") ? verifyMain : main;
  command().catch(async (error) => {
    const failure = await recordApprovalFailure(error).catch(() => ({
      code: "approval-service-error",
      reason: "The approval service could not complete the submission checks.",
    }));
    console.error(`Approval failed [${failure.code}]`);
    process.exitCode = 1;
  });
}
