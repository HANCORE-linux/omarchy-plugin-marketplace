import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSecurityBaselineFailureReport,
  buildSecurityBaselineReport,
} from "./security-baseline-report.mjs";
import {
  runSecurityBaseline,
  SecurityBaselineError,
} from "./security-baseline-scanner.mjs";

export * from "./security-baseline-approval.mjs";
export * from "./security-baseline-policy.mjs";
export * from "./security-baseline-record.mjs";
export * from "./security-baseline-report.mjs";
export * from "./security-baseline-scanner.mjs";

function requiredArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new SecurityBaselineError("security-baseline-invalid", `--${name} is required`);
  return value;
}

let reportContext = "submission";

async function main() {
  const metadataPath = requiredArgument("metadata");
  const jsonPath = requiredArgument("json");
  const metadata = JSON.parse(await readFile(resolve(metadataPath), "utf8"));
  if (
    metadata?.schemaVersion !== 1
    || typeof metadata.repoUrl !== "string"
    || typeof metadata.commitSha !== "string"
  ) {
    throw new SecurityBaselineError("security-baseline-invalid", "Validation metadata is invalid");
  }
  reportContext = metadata.context === "update" ? "update" : "submission";
  const result = await runSecurityBaseline(metadata.repoUrl, metadata.commitSha, {
    requiredPaths: metadata.entryPoints,
    ...(Array.isArray(metadata.listedPlugins)
      ? { listedPlugins: metadata.listedPlugins }
      : {}),
  });
  await writeFile(resolve(jsonPath), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(buildSecurityBaselineReport(result, { context: reportContext }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    const code = error?.code || "security-baseline-unavailable";
    process.stdout.write(buildSecurityBaselineFailureReport(error, { context: reportContext }));
    console.error(`Automated security baseline failed [${code}]`);
    process.exitCode = 2;
  });
}
