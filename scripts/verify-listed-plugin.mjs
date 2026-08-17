import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeListedPluginVerification,
  buildVerificationReport,
  PluginVerificationError,
  publicVerificationFailure,
} from "./plugin-verification.mjs";
import { SecurityBaselineError } from "./security-baseline-scanner.mjs";
import { parseMaintainerVerificationExpectation } from "./verification-review.mjs";

export * from "./plugin-verification.mjs";

function requiredArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`--${name} is required`);
  return resolve(value);
}

async function writeAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

async function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

async function maintainerReviewRequest() {
  const requested = process.env.MAINTAINER_REVIEW_REQUESTED || "false";
  if (requested === "false") return null;
  const requestEventId = Number.parseInt(process.env.MAINTAINER_REVIEW_EVENT_ID || "", 10);
  if (
    requested !== "true"
    || !process.env.MAINTAINER_REVIEWER?.trim()
    || !/^[1-9][0-9]*$/.test(process.env.MAINTAINER_REVIEW_EVENT_ID || "")
    || !Number.isSafeInteger(requestEventId)
    || !Number.isFinite(Date.parse(process.env.MAINTAINER_REVIEW_REQUESTED_AT || ""))
    || !process.env.MAINTAINER_REVIEW_REPORT_PATH?.trim()
  ) {
    throw new Error("Maintainer review workflow metadata is invalid");
  }
  const report = await readFile(resolve(process.env.MAINTAINER_REVIEW_REPORT_PATH), "utf8");
  const expectation = parseMaintainerVerificationExpectation(report);
  if (!expectation) throw new Error("Maintainer review report has no eligible expectation");
  return Object.freeze({
    reviewer: process.env.MAINTAINER_REVIEWER.trim(),
    requestEventId,
    requestedAt: process.env.MAINTAINER_REVIEW_REQUESTED_AT,
    expectation,
  });
}

async function main() {
  const registryPath = requiredArgument("registry");
  const catalogPath = requiredArgument("catalog");
  const outputDirectory = requiredArgument("output-dir");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const body = process.env.ISSUE_BODY || "";
  const maintainerReview = await maintainerReviewRequest();
  let result;
  try {
    result = await analyzeListedPluginVerification({
      body,
      registry,
      catalog,
      token: process.env.GITHUB_TOKEN,
      maintainerReview,
    });
  } catch (error) {
    if (!(error instanceof PluginVerificationError) && !(error instanceof SecurityBaselineError)) {
      throw error;
    }
    result = {
      ...publicVerificationFailure(error),
      maintainerReviewRequested: Boolean(maintainerReview),
    };
  }

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "verification-result.json"), `${JSON.stringify({
    schemaVersion: 1,
    status: result.status,
    changed: result.changed,
    pluginId: result.request?.pluginId || "",
    affectedPluginIds: result.subject?.pluginIds || [],
    repository: result.request?.repository || "",
    commitSha: result.request?.commitSha || "",
    baselineVersion: result.baseline?.version || "",
    baselineOutcome: result.baseline?.outcome || "",
    baselineFindings: result.baseline?.findings || [],
    baselineCapabilities: result.baseline?.capabilities || [],
    verificationMethod: result.verification?.method || "",
    maintainerReviewRequested: Boolean(result.maintainerReviewRequested),
    maintainerReviewer: result.maintainerReview?.reviewer || result.verification?.reviewer || "",
    maintainerReviewEventId: result.maintainerReview?.requestEventId || "",
    maintainerReviewRequestedAt: result.maintainerReview?.requestedAt || "",
    maintainerReviewedAt: result.maintainerReview?.reviewedAt || result.verification?.reviewedAt || "",
    errorCode: result.code || "",
  }, null, 2)}\n`);
  await writeFile(resolve(outputDirectory, "verification-report.md"), buildVerificationReport(result));

  if (result.status === "verified" && result.changed) {
    await writeAtomic(registryPath, `${JSON.stringify(result.registry, null, 2)}\n`);
    await writeAtomic(catalogPath, `${JSON.stringify(result.catalog, null, 2)}\n`);
  }

  await writeOutput("result", result.status);
  await writeOutput("changed", String(Boolean(result.changed)));
  await writeOutput("plugin_id", result.request?.pluginId || "");
  await writeOutput("commit_sha", result.request?.commitSha || "");
  await writeOutput("verification_method", result.verification?.method || "");
  await writeOutput("maintainer_review_requested", String(Boolean(result.maintainerReviewRequested)));
  await writeOutput("error_code", result.code || "");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch(() => {
    console.error("Automated plugin verification failed [verification-internal-error]");
    process.exitCode = 2;
  });
}
