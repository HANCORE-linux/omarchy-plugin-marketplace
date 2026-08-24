import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeListedPluginVerification,
  buildVerificationReport,
  PluginVerificationError,
  revokeMaintainerVerification,
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

function authenticatedEventRequest(prefix) {
  const requested = process.env[`${prefix}_REQUESTED`] || "false";
  if (requested === "false") return null;
  const eventIdValue = process.env[`${prefix}_EVENT_ID`] || "";
  const eventId = Number.parseInt(eventIdValue, 10);
  const reviewer = process.env[`${prefix}_REVIEWER`]?.trim();
  const requestedAt = process.env[`${prefix}_REQUESTED_AT`] || "";
  if (
    requested !== "true"
    || !reviewer
    || !/^[1-9][0-9]*$/.test(eventIdValue)
    || !Number.isSafeInteger(eventId)
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(reviewer)
    || !Number.isFinite(Date.parse(requestedAt))
  ) {
    throw new Error(`${prefix} workflow metadata is invalid`);
  }
  return Object.freeze({ reviewer, requestEventId: eventId, requestedAt });
}

async function main() {
  const registryPath = requiredArgument("registry");
  const catalogPath = requiredArgument("catalog");
  const outputDirectory = requiredArgument("output-dir");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const body = process.env.ISSUE_BODY || "";
  const maintainerReview = await maintainerReviewRequest();
  const standardInstallationApproval = authenticatedEventRequest("STANDARD_INSTALLATION_APPROVAL");
  const revocationRequest = authenticatedEventRequest("REVOCATION");
  const revocationReviewEventIdValue = process.env.REVOCATION_REVIEW_EVENT_ID || "";
  const revocationReviewEventId = Number.parseInt(revocationReviewEventIdValue, 10);
  if (
    revocationRequest
    && (!/^[1-9][0-9]*$/.test(revocationReviewEventIdValue) || !Number.isSafeInteger(revocationReviewEventId))
  ) {
    throw new Error("REVOCATION review event metadata is invalid");
  }
  let result;
  try {
    result = revocationRequest
      ? revokeMaintainerVerification({
        body,
        registry,
        catalog,
        revocation: {
          revocationEventId: revocationRequest.requestEventId,
          revokedBy: revocationRequest.reviewer,
          revokedAt: revocationRequest.requestedAt,
        },
        reviewRequestEventId: revocationReviewEventId,
      })
      : await analyzeListedPluginVerification({
        body,
        registry,
        catalog,
        token: process.env.GITHUB_TOKEN,
        maintainerReview,
        standardInstallationApproval,
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
    verificationMethod: result.verification?.method || (result.status === "revoked" ? "revoked" : ""),
    maintainerReviewRequested: Boolean(result.maintainerReviewRequested),
    installationChanged: Boolean(result.installationChanged),
    maintainerReviewer: result.maintainerReview?.reviewer || result.verification?.reviewer || result.revocation?.revokedBy || "",
    maintainerReviewEventId: result.maintainerReview?.requestEventId || "",
    maintainerReviewRequestedAt: result.maintainerReview?.requestedAt || "",
    maintainerReviewedAt: result.maintainerReview?.reviewedAt || result.verification?.reviewedAt || "",
    revocationEventId: result.revocation?.revocationEventId || "",
    revocationReviewer: result.revocation?.revokedBy || "",
    revocationAt: result.revocation?.revokedAt || "",
    errorCode: result.code || "",
  }, null, 2)}\n`);
  await writeFile(resolve(outputDirectory, "verification-report.md"), buildVerificationReport(result));

  if (["verified", "revoked"].includes(result.status) && result.changed) {
    await writeAtomic(registryPath, `${JSON.stringify(result.registry, null, 2)}\n`);
    await writeAtomic(catalogPath, `${JSON.stringify(result.catalog, null, 2)}\n`);
  }

  await writeOutput("result", result.status);
  await writeOutput("changed", String(Boolean(result.changed)));
  await writeOutput("plugin_id", result.request?.pluginId || "");
  await writeOutput("commit_sha", result.request?.commitSha || "");
  await writeOutput("verification_method", result.verification?.method || (result.status === "revoked" ? "revoked" : ""));
  await writeOutput("maintainer_review_requested", String(Boolean(result.maintainerReviewRequested)));
  await writeOutput("installation_changed", String(Boolean(result.installationChanged)));
  await writeOutput("revocation_event_id", result.revocation?.revocationEventId || "");
  await writeOutput("revocation_reviewer", result.revocation?.revokedBy || "");
  await writeOutput("revocation_at", result.revocation?.revokedAt || "");
  await writeOutput("error_code", result.code || "");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch(() => {
    console.error("Automated plugin verification failed [verification-internal-error]");
    process.exitCode = 2;
  });
}
