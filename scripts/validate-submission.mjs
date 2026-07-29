import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  catalogErrorCode,
  inspectSubmission,
} from "./build-catalog.mjs";
import {
  extractRepositoryUrl,
  parseSubmissionBody,
  SubmissionFormatError,
} from "./submission.mjs";

export { extractRepositoryUrl };

const publicValidationMessages = {
  "repository-unreachable": "The repository could not be reached. Please try again later.",
  "manifest-invalid": "The plugin manifest does not match the supported Quattro contract.",
  "entry-point-missing": "A declared Quattro entry-point file is missing.",
  "reserved-plugin-id": "The plugin uses the reserved omarchy.* namespace.",
  "readme-missing": "A README file is required in the repository root.",
  "license-missing": "A license file is required in the repository root.",
  "preview-invalid": "The optional preview image is invalid or exceeds the size limit.",
  "unsupported-repository-layout": "New submissions require one plugin with manifest.json in the repository root.",
  "submission-invalid": "The issue does not match the required plugin submission format.",
};

function safeInline(value) {
  return String(value).replace(/[`<>\r\n]+/g, " ").trim();
}

async function main() {
  const explicitRepo = process.argv.find((argument) => argument.startsWith("--repo="))?.slice(7);
  let repoUrl;
  try {
    repoUrl = explicitRepo || parseSubmissionBody(process.env.ISSUE_BODY).repo;
    const result = await inspectSubmission(repoUrl);
    const manifestList = result.manifests
      .map((manifest) => `- \`${safeInline(manifest.id)}\` — ${safeInline(manifest.name)} ${safeInline(manifest.version)} (\`${safeInline(manifest.path)}\`)`)
      .join("\n");

    console.log(`<!-- marketplace-validation -->
## Marketplace validation

✅ Repository is public and reachable: [${safeInline(result.repository)}](${repoUrl})
✅ Found ${result.manifests.length} valid, uniquely identified plugin manifest${result.manifests.length === 1 ? "" : "s"}
✅ Root README and license files detected
✅ Quattro compatibility passed at commit \`${safeInline(result.commitSha.slice(0, 7))}\`
${result.preview ? "✅ Optional root `preview.png` detected" : "ℹ️ No root `preview.png` detected — the marketplace will use its fallback preview"}

${manifestList}

**Ready for listing review.** Validation checks this commit’s structure and Quattro compatibility; it is not a security review.`);
  } catch (error) {
    const code = error instanceof SubmissionFormatError
      ? error.code
      : catalogErrorCode(error);
    console.error(`Validation failed [${code}]: ${error.message}`);
    console.log(`<!-- marketplace-validation -->
## Marketplace validation

❌ The automated validation could not approve this submission.

**${safeInline(code)}:** ${publicValidationMessages[code]}

Please update the repository or submission and edit this issue to run validation again.`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
