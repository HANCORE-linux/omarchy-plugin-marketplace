import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  catalogErrorCode,
  inspectSubmission,
} from "./build-catalog.mjs";
import {
  extractRepositoryUrl,
  parseIssueSubmission,
} from "./submission.mjs";
import { publicSubmissionFailure } from "./submission-feedback.mjs";

export { extractRepositoryUrl };

export class SubmissionValidationError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "SubmissionValidationError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function repositorySlug(value) {
  try {
    return new URL(value).pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function assertSubmissionIsUnlisted(result, catalog, retiredPluginIds = []) {
  const plugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
  const submittedRepository = String(result?.repository || "").toLowerCase();
  if (plugins.some((plugin) => repositorySlug(plugin.repo) === submittedRepository)) {
    throw new SubmissionValidationError(
      "submission-repository-listed",
      "Repository is already listed",
    );
  }
  const listedIds = new Set(plugins.map((plugin) => plugin.id));
  const retiredIds = new Set(retiredPluginIds);
  for (const manifest of result?.manifests || []) {
    if (retiredIds.has(manifest.id)) {
      throw new SubmissionValidationError(
        "plugin-id-retired",
        `Plugin ID "${manifest.id}" was used by a previous listing`,
        { pluginId: manifest.id },
      );
    }
    if (listedIds.has(manifest.id)) {
      throw new SubmissionValidationError(
        "plugin-id-listed",
        `Plugin ID "${manifest.id}" is already listed`,
        { pluginId: manifest.id },
      );
    }
  }
}

function safeInline(value) {
  return String(value).replace(/[`<>\r\n]+/g, " ").trim();
}

function safeMarkdownText(value) {
  return safeInline(value)
    .replaceAll("\\", "\\\\")
    .replace(/([*_\[\]()~|])/g, "\\$1")
    .replaceAll("@", "@\u200b");
}

export async function writeValidationMetadata(path, repoUrl, result) {
  if (!path) return;
  const metadata = {
    schemaVersion: 1,
    repoUrl,
    repository: result.repository,
    defaultBranch: result.defaultBranch,
    commitSha: result.commitSha,
    pluginIds: (result.manifests || []).map((manifest) => manifest.id).sort(),
    listedPlugins: (result.manifests || []).map((manifest) => ({
      pluginId: manifest.id,
      manifestPathHint: manifest.path,
    })),
    entryPoints: [...new Set(
      (result.manifests || []).flatMap((manifest) => manifest.entryPoints || []),
    )].sort(),
  };
  await writeFile(resolve(path), `${JSON.stringify(metadata, null, 2)}\n`);
}

async function main() {
  const explicitRepo = process.argv.find((argument) => argument.startsWith("--repo="))?.slice(7);
  let repoUrl;
  try {
    repoUrl = explicitRepo || parseIssueSubmission({
      title: process.env.ISSUE_TITLE,
      body: process.env.ISSUE_BODY,
      createdAt: process.env.ISSUE_CREATED_AT,
    }).repo;
    const result = await inspectSubmission(repoUrl);
    const root = resolve(import.meta.dirname, "..");
    const [catalog, registry] = await Promise.all([
      readFile(resolve(root, "site/catalog.json"), "utf8").then(JSON.parse),
      readFile(resolve(root, "registry.json"), "utf8").then(JSON.parse),
    ]);
    assertSubmissionIsUnlisted(result, catalog, registry.retiredPluginIds);
    await writeValidationMetadata(process.env.VALIDATION_METADATA_PATH, repoUrl, result);
    const manifestList = result.manifests
      .map((manifest) => `- \`${safeInline(manifest.id)}\` — ${safeMarkdownText(manifest.name)} ${safeMarkdownText(manifest.version)} (\`${safeInline(manifest.path)}\`)`)
      .join("\n");

    console.log(`<!-- marketplace-validation -->
## Marketplace validation

✅ Repository is public and reachable: [${safeInline(result.repository)}](${repoUrl})
✅ Found ${result.manifests.length} valid, uniquely identified plugin manifest${result.manifests.length === 1 ? "" : "s"}
✅ Root README and license files detected
✅ Quattro compatibility passed at commit \`${safeInline(result.commitSha.slice(0, 7))}\`
${result.preview ? "✅ Optional root preview detected" : "ℹ️ No supported root preview detected — the marketplace will use its fallback preview"}

${manifestList}

**Ready for listing review.** Validation checks this commit’s structure and Quattro compatibility; it is not a security review.`);
  } catch (error) {
    const failureError = error instanceof Error ? error : new Error("Unknown validation failure");
    if (!failureError.code) {
      failureError.code = catalogErrorCode(failureError, "validation-internal-error");
    }
    const failure = publicSubmissionFailure(failureError);
    console.error(`Validation failed [${failure.code}]`);
    console.log(`<!-- marketplace-validation -->
## Marketplace validation

❌ **Validation failed:** ${failure.reason}

${failure.action}`);
    process.exitCode = failure.code === "validation-internal-error" ? 2 : 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
