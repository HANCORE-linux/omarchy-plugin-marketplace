import {
  buildSecurityBaseline,
  referencedSudoersPolicyPaths,
} from "./security-baseline-analysis.mjs";
import { resolveSecuritySnapshot } from "./security-baseline-scope.mjs";

export * from "./security-baseline-analysis.mjs";
export { SecurityBaselineError } from "./security-baseline-error.mjs";
export {
  isSecurityScanPath,
  securityFileByteLimit,
  securitySnapshotByteLimit,
  securitySnapshotFileLimit,
} from "./security-baseline-scope.mjs";

export function resolveSubmissionSnapshot(repoUrl, commitSha, options = {}) {
  return resolveSecuritySnapshot(repoUrl, commitSha, {
    ...options,
    referencedPaths: referencedSudoersPolicyPaths,
  });
}

export async function runSecurityBaseline(repoUrl, commitSha, options = {}) {
  const snapshot = await resolveSubmissionSnapshot(repoUrl, commitSha, options);
  return buildSecurityBaseline(snapshot, options);
}
