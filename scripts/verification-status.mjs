import { githubRepositoryKey } from "./github-repository.mjs";
import { parseStoredSecurityBaselineRecord } from "./security-baseline-record.mjs";

export const pluginVerificationStatuses = Object.freeze(["verified", "unverified"]);

function sourcePluginIds(source) {
  const ids = Object.keys(source?.plugins || {});
  if (source?.catalog?.id) ids.push(source.catalog.id);
  return ids.sort();
}

export function sourceVerification(source) {
  if (source?.type !== "plugin-source") return Object.freeze({ status: "unverified" });
  let repository;
  try {
    repository = githubRepositoryKey(source?.repo);
  } catch {
    return Object.freeze({ status: "unverified" });
  }
  const baseline = parseStoredSecurityBaselineRecord(source?.automatedSecurityBaseline, {
    expectedRepository: repository,
    expectedCommit: source?.listingValidatedCommit,
    pluginIds: sourcePluginIds(source),
  });
  if (
    !baseline
    || baseline.outcome !== "passed"
    || baseline.findings.length
    || baseline.capabilities.length
  ) return Object.freeze({ status: "unverified" });
  return Object.freeze({
    status: "verified",
    baselineVersion: baseline.version,
    commit: baseline.commit,
    checkedAt: baseline.checkedAt,
  });
}
