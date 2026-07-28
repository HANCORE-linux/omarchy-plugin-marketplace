import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectSubmission, parseGitHubRepository } from "./build-catalog.mjs";

export function extractRepositoryUrl(issueBody) {
  const match = String(issueBody || "").match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/);
  if (!match) throw new Error("No public GitHub repository URL was found in the submission");
  const parsed = parseGitHubRepository(match[0]);
  return `https://github.com/${parsed.owner}/${parsed.repository}`;
}

function safeInline(value) {
  return String(value).replace(/[`<>\r\n]+/g, " ").trim();
}

async function main() {
  const explicitRepo = process.argv.find((argument) => argument.startsWith("--repo="))?.slice(7);
  let repoUrl;
  try {
    repoUrl = explicitRepo || extractRepositoryUrl(process.env.ISSUE_BODY);
    const result = await inspectSubmission(repoUrl);
    const manifestList = result.manifests
      .map((manifest) => `- \`${safeInline(manifest.id)}\` — ${safeInline(manifest.name)} ${safeInline(manifest.version)} (\`${safeInline(manifest.path)}\`)`)
      .join("\n");

    console.log(`<!-- marketplace-validation -->
## Marketplace validation

✅ Repository is public and reachable: [${safeInline(result.repository)}](${repoUrl})
✅ Found ${result.manifests.length} valid, uniquely identified plugin manifest${result.manifests.length === 1 ? "" : "s"}
${result.license ? `✅ Repository license detected: \`${safeInline(result.license)}\`` : "⚠️ No repository license detected"}
${result.preview ? "✅ Optional root `preview.png` detected" : "ℹ️ No root `preview.png` detected — the marketplace will use its fallback preview"}

${manifestList}

**Ready for maintainer review.** Validation checks structure and metadata; it is not an approval or security audit.`);
  } catch (error) {
    console.log(`<!-- marketplace-validation -->
## Marketplace validation

❌ The automated validation could not approve this submission.

\`${safeInline(error.message)}\`

Please update the repository or submission and edit this issue to run validation again.`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
