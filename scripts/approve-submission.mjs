import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectSubmission, parseGitHubRepository } from "./build-catalog.mjs";
import { extractRepositoryUrl } from "./validate-submission.mjs";

export const rightsStatement =
  "I confirm that I own or have permission to submit this plugin and its preview assets.";
const legacyRightsStatement =
  "I have the right to distribute this plugin and its assets under the declared license.";
const rightsConfirmationIntroducedAt = Date.parse("2026-07-28T10:58:48Z");

const allowedCategories = new Set([
  "Appearance",
  "Desktop",
  "Developer Tools",
  "Hardware",
  "Productivity",
  "System",
  "Widgets",
  "Other",
]);

function section(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(body || "").match(
    new RegExp(`###\\s+${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n###\\s+|$)`, "i"),
  );
  if (!match) throw new Error(`Submission is missing the "${heading}" field`);
  return match[1].trim();
}

export function parseSubmission(issueBody) {
  const repo = extractRepositoryUrl(issueBody);
  const category = section(issueBody, "Category");
  if (!allowedCategories.has(category)) {
    throw new Error(`Unsupported submission category "${category}"`);
  }

  const tags = section(issueBody, "Tags")
    .split(",")
    .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);
  if (!tags.length || tags.length > 5) {
    throw new Error("Submissions require between one and five tags");
  }
  if (tags.some((tag) => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag))) {
    throw new Error("Tags may contain only lowercase letters, numbers, and hyphens");
  }

  return { repo, category, tags: [...new Set(tags)] };
}

export function hasRightsConfirmation(issue, comments = []) {
  const statements = [rightsStatement, legacyRightsStatement];
  const checkedInBody = statements.some((statement) => {
    const escaped = statement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`-\\s*\\[[xX]\\]\\s*${escaped}`, "i").test(issue.body || "");
  });
  if (checkedInBody) return true;

  const author = String(issue.user?.login || "").toLowerCase();
  return comments.some((comment) =>
    String(comment.user?.login || "").toLowerCase() === author
    && statements.some((statement) =>
      String(comment.body || "").toLowerCase().includes(statement.toLowerCase())
    )
  );
}

export function canApprove(permission) {
  return new Set(["admin", "maintain", "write"]).has(String(permission || "").toLowerCase());
}

export function assertApprovedIssueBody(currentBody, approvedBody) {
  if (typeof approvedBody !== "string") {
    throw new Error("APPROVED_ISSUE_BODY is required");
  }
  if (String(currentBody || "") !== approvedBody) {
    throw new Error(
      "The submission changed after approval; review it again before reapplying approved-for-listing",
    );
  }
}

export function isLegacySubmission(issue) {
  const createdAt = Date.parse(issue.created_at || "");
  return Number.isFinite(createdAt) && createdAt < rightsConfirmationIntroducedAt;
}

export function createRegistrySource({
  submission,
  manifests,
  addedAt,
  listedAt,
  listingValidatedCommit,
  listingValidatedAt,
  listingValidatedBranch,
}) {
  const plugins = Object.fromEntries(
    manifests.map((manifest) => [
      manifest.id,
      {
        category: submission.category,
        tags: submission.tags,
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
    plugins,
  };
}

export function addRegistrySource(registry, source, existingPluginIds = []) {
  const sources = Array.isArray(registry.sources) ? registry.sources : [];
  const candidate = parseGitHubRepository(source.repo).slug.toLowerCase();
  const existingSource = sources.find(
    (entry) => parseGitHubRepository(entry.repo).slug.toLowerCase() === candidate,
  );
  if (existingSource) {
    const existingIds = Object.keys(existingSource.plugins || {}).sort();
    const candidateIds = Object.keys(source.plugins || {}).sort();
    if (JSON.stringify(existingIds) === JSON.stringify(candidateIds)) return registry;
    throw new Error(`${source.repo} is already registered with a different plugin set`);
  }

  const existing = new Set(existingPluginIds);
  for (const pluginId of Object.keys(source.plugins)) {
    if (existing.has(pluginId)) throw new Error(`Plugin id "${pluginId}" is already listed`);
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

async function githubApiPages(path, token) {
  const results = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await githubApi(`${path}${separator}per_page=100&page=${page}`, token);
    results.push(...batch);
    if (batch.length < 100) return results;
  }
  throw new Error("GitHub pagination exceeded the 2,000-item safety limit");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repositoryName = requiredEnvironment("GITHUB_REPOSITORY");
  const approver = requiredEnvironment("APPROVER_LOGIN");
  const issueNumber = Number.parseInt(requiredEnvironment("ISSUE_NUMBER"), 10);
  const approvedIssueBody = process.env.APPROVED_ISSUE_BODY;
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("ISSUE_NUMBER must be positive");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName)) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }

  const permission = await githubApi(
    `/repos/${repositoryName}/collaborators/${encodeURIComponent(approver)}/permission`,
    token,
  );
  if (!canApprove(permission.permission)) {
    throw new Error(`${approver} does not have write permission to approve submissions`);
  }

  const issue = await githubApi(`/repos/${repositoryName}/issues/${issueNumber}`, token);
  if (issue.pull_request || issue.state !== "open") throw new Error("Approval requires an open submission issue");
  assertApprovedIssueBody(issue.body, approvedIssueBody);
  const labels = new Set((issue.labels || []).map((label) => typeof label === "string" ? label : label.name));
  for (const required of ["submission", "validated", "approved-for-listing"]) {
    if (!labels.has(required)) throw new Error(`Issue #${issueNumber} is missing the "${required}" label`);
  }

  const comments = await githubApiPages(
    `/repos/${repositoryName}/issues/${issueNumber}/comments`,
    token,
  );
  if (!hasRightsConfirmation(issue, comments) && !isLegacySubmission(issue)) {
    throw new Error(`The submitter has not confirmed: ${rightsStatement}`);
  }

  const submission = parseSubmission(issue.body);
  const inspection = await inspectSubmission(submission.repo);
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
  });
  const nextRegistry = addRegistrySource(
    registry,
    source,
    (catalog.plugins || []).map((plugin) => plugin.id),
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
    await appendFile(output, `plugin_id=${firstPlugin.id}\nplugin_name=${safeName}\n`);
  }
  console.log(
    `Approved issue #${issueNumber}: added ${inspection.manifests.length} plugin manifest(s) from ${submission.repo}`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`Approval failed: ${error.message}`);
    process.exitCode = 1;
  });
}
