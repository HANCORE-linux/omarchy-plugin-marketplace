import { githubRepositoryKey } from "./github-repository.mjs";
import { sourceVerification } from "./verification-status.mjs";

export const catalogVerificationFieldNames = Object.freeze([
  "verificationStatus",
  "verificationSnapshotStatus",
  "verificationCoverage",
  "verificationBaselineVersion",
  "verificationCommit",
  "verificationCheckedAt",
  "verificationMethod",
  "verificationReviewedAt",
  "verificationReviewedBy",
]);

export function isCommunityCatalogEntry(plugin) {
  return !Object.hasOwn(plugin || {}, "sourceType") || plugin.sourceType === "community";
}

export class CatalogVerificationProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatalogVerificationProjectionError";
    this.code = code;
  }
}

function sourceCatalogPluginIds(source) {
  if (source?.type === "suite") return source.catalog?.id ? [source.catalog.id] : [];
  return Object.keys(source?.plugins || {}).sort();
}

function assertExactPluginSet(source, plugins) {
  const expected = sourceCatalogPluginIds(source);
  const actual = plugins.map((plugin) => plugin.id).sort();
  if (!expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new CatalogVerificationProjectionError(
      "verification-catalog-plugin-set-mismatch",
      `Catalog plugin set does not match registry source ${githubRepositoryKey(source.repo)}`,
    );
  }
}

export function catalogVerificationFields(source, plugin = null) {
  const verification = sourceVerification(source);
  if (verification.status !== "verified") {
    return {
      verificationStatus: "unverified",
      verificationSnapshotStatus: "unverified",
      verificationCoverage: "unverified",
    };
  }
  const observedCommit = String(
    plugin?.upstreamObservedCommit || plugin?.upstreamValidatedCommit || "",
  ).toLowerCase();
  const updateUnverified = /^[a-f0-9]{40}$/.test(observedCommit)
    && observedCommit !== verification.commit.toLowerCase();
  return {
    verificationStatus: updateUnverified ? "unverified" : "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: updateUnverified ? "update-unverified" : "snapshot-verified",
    verificationBaselineVersion: verification.baselineVersion,
    verificationCommit: verification.commit,
    verificationCheckedAt: verification.checkedAt,
    ...(verification.method === "maintainer-reviewed" ? {
      verificationMethod: "maintainer-reviewed",
      verificationReviewedAt: verification.reviewedAt,
      verificationReviewedBy: verification.reviewer,
    } : {}),
  };
}

export function withoutCatalogVerificationFields(plugin) {
  return Object.fromEntries(
    Object.entries(plugin || {}).filter(([name]) => !catalogVerificationFieldNames.includes(name)),
  );
}

export function projectPluginVerification(plugin, source) {
  const fields = catalogVerificationFields(source, plugin);
  const current = catalogVerificationFieldNames.every((name) => plugin?.[name] === fields[name]);
  if (current) return plugin;
  const projected = {};
  let inserted = false;
  for (const [name, value] of Object.entries(plugin || {})) {
    if (!catalogVerificationFieldNames.includes(name)) {
      projected[name] = value;
      continue;
    }
    if (!inserted) {
      Object.assign(projected, fields);
      inserted = true;
    }
  }
  if (!inserted) Object.assign(projected, fields);
  return projected;
}

export function projectCatalogSourceVerification(catalog, source, {
  requiredPluginId = "",
  generatedAt = "",
} = {}) {
  const repository = githubRepositoryKey(source.repo);
  const matchingPlugins = (catalog?.plugins || []).filter((plugin) => {
    try {
      return !plugin?.placeholder
        && !plugin?.builtIn
        && isCommunityCatalogEntry(plugin)
        && githubRepositoryKey(plugin.repo) === repository;
    } catch {
      return false;
    }
  });
  if (!matchingPlugins.length) {
    throw new CatalogVerificationProjectionError(
      "verification-catalog-listing-missing",
      "The existing listing is missing from the generated catalog",
    );
  }
  assertExactPluginSet(source, matchingPlugins);
  if (requiredPluginId && !matchingPlugins.some((plugin) => plugin.id === requiredPluginId)) {
    throw new CatalogVerificationProjectionError(
      "verification-catalog-listing-missing",
      "The requested plugin is missing from the generated catalog",
    );
  }
  const expectedPluginIds = new Set(sourceCatalogPluginIds(source));
  let changed = false;
  const plugins = catalog.plugins.map((plugin) => {
    let matches = false;
    try {
      matches = !plugin?.placeholder
        && !plugin?.builtIn
        && isCommunityCatalogEntry(plugin)
        && githubRepositoryKey(plugin.repo) === repository
        && expectedPluginIds.has(plugin.id);
    } catch {
      return plugin;
    }
    if (!matches) return plugin;
    const projected = projectPluginVerification(plugin, source);
    if (projected !== plugin) changed = true;
    return projected;
  });
  if (!changed) return catalog;
  return {
    ...catalog,
    ...(generatedAt ? { generatedAt } : {}),
    plugins,
  };
}

export function projectCatalogVerification(registry, catalog, { generatedAt = "" } = {}) {
  const sources = new Map((registry?.sources || []).map((source) => [
    githubRepositoryKey(source.repo),
    source,
  ]));
  for (const [repository, source] of sources) {
    const matchingPlugins = (catalog?.plugins || []).filter((plugin) => (
      !plugin?.placeholder
      && !plugin?.builtIn
      && isCommunityCatalogEntry(plugin)
      && githubRepositoryKey(plugin.repo) === repository
    ));
    assertExactPluginSet(source, matchingPlugins);
  }
  let changed = false;
  const plugins = (catalog?.plugins || []).map((plugin) => {
    if (plugin?.builtIn || !isCommunityCatalogEntry(plugin)) {
      const clean = withoutCatalogVerificationFields(plugin);
      const hadVerificationFields = Object.keys(clean).length !== Object.keys(plugin || {}).length;
      if (hadVerificationFields) changed = true;
      return hadVerificationFields ? clean : plugin;
    }
    if (plugin.placeholder) {
      const projected = {
        ...withoutCatalogVerificationFields(plugin),
        verificationStatus: "unverified",
        verificationSnapshotStatus: "unverified",
        verificationCoverage: "unverified",
      };
      const current = catalogVerificationFieldNames.every((name) => plugin[name] === projected[name]);
      if (!current) changed = true;
      return current ? plugin : projected;
    }
    const source = sources.get(githubRepositoryKey(plugin.repo));
    if (!source) {
      throw new CatalogVerificationProjectionError(
        "verification-catalog-source-missing",
        `Registry source is missing for ${plugin.id || "catalog plugin"}`,
      );
    }
    const projected = projectPluginVerification(plugin, source);
    if (projected !== plugin) changed = true;
    return projected;
  });
  if (!changed) return catalog;
  return {
    ...catalog,
    ...(generatedAt ? { generatedAt } : {}),
    plugins,
  };
}
