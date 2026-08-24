import { parseGitHubRepository } from "./github-repository.mjs";
import { SecurityBaselineError } from "./security-baseline-error.mjs";
import {
  securityAssetProbeByteLimit,
  securityAssetProbeFileLimit,
  securityBinaryProbeByteLimit,
  securityFileByteLimit,
  securitySnapshotByteLimit,
  securitySnapshotFileLimit,
} from "./security-baseline-limits.mjs";
import {
  assertFullCommitSha,
  githubJson,
  isBinaryAssetPath,
  mapWithConcurrency,
  probeSnapshotFile,
  readSnapshotFile,
} from "./security-github-snapshot.mjs";

export {
  securityAssetProbeByteLimit,
  securityAssetProbeFileLimit,
  securityFileByteLimit,
  securitySnapshotByteLimit,
  securitySnapshotFileLimit,
} from "./security-baseline-limits.mjs";

const excludedDirectories = new Set([
  ".github",
  "coverage",
  "docs",
  "fixtures",
  "node_modules",
  "spec",
  "specs",
  "test",
  "tests",
]);
const scannedExtensions = new Set([
  ".bash",
  ".cjs",
  ".desktop",
  ".fish",
  ".js",
  ".lua",
  ".mjs",
  ".pl",
  ".py",
  ".qml",
  ".rb",
  ".service",
  ".sh",
  ".sudoers",
  ".toml",
  ".yaml",
  ".yml",
  ".zsh",
]);
const setupLikeBasename = /(?:install|installer|setup|uninstall)/i;

function isSetupNamedPath(path) {
  const basename = String(path || "").replaceAll("\\", "/").split("/").at(-1) || "";
  return setupLikeBasename.test(basename);
}

export function isRootReadme(path) {
  return !path.includes("/") && /^readme(?:\.[^/]+)?$/i.test(path);
}

export function isSecurityScanPath(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return false;
  if (isRootReadme(normalized)) return true;
  const parts = normalized.toLowerCase().split("/");
  if (parts.slice(0, -1).some((part) => excludedDirectories.has(part))) return false;
  const basename = parts.at(-1);
  const extensionAt = basename.lastIndexOf(".");
  const extension = extensionAt > 0 ? basename.slice(extensionAt) : "";
  if (scannedExtensions.has(extension)) return true;
  if (isBinaryAssetPath(normalized)) return false;
  if (parts[0] === "bin" || parts[0] === "scripts") return extensionAt < 0;
  return isSetupNamedPath(normalized);
}

export async function resolveSecuritySnapshot(repoUrl, commitSha, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new SecurityBaselineError("security-baseline-unavailable", "A fetch implementation is required");
  }
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const repository = parseGitHubRepository(repoUrl);
  const expectedCommit = assertFullCommitSha(commitSha);
  const requiredPaths = new Set((options.requiredPaths || []).filter((path) => (
    typeof path === "string"
    && path
    && !path.startsWith("/")
    && !path.includes("..")
  )));
  const metadata = await githubJson(
    `/repos/${repository.owner}/${repository.repository}`,
    { fetchImpl, token },
  );
  if (metadata.private || metadata.disabled || metadata.archived) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      `${repository.slug} must remain public, active, and unarchived`,
    );
  }
  const commit = await githubJson(
    `/repos/${repository.owner}/${repository.repository}/commits/${expectedCommit}`,
    { fetchImpl, token },
  );
  if (String(commit.sha || "").toLowerCase() !== expectedCommit) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      "GitHub did not resolve the requested commit exactly",
    );
  }
  const treeSha = assertFullCommitSha(commit.commit?.tree?.sha, "security-baseline-unavailable");
  const treeResponse = await githubJson(
    `/repos/${repository.owner}/${repository.repository}/git/trees/${treeSha}?recursive=1`,
    { fetchImpl, token },
  );
  if (treeResponse.truncated) {
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      "The repository tree is too large for a complete static scan",
    );
  }
  const tree = treeResponse.tree || [];
  const listedPlugins = options.listedPlugins;
  const manifestHints = Array.isArray(listedPlugins)
    ? listedPlugins.map((listing) => listing?.manifestPathHint).filter(Boolean)
    : [];
  if (
    listedPlugins !== undefined
    && (
      !Array.isArray(listedPlugins)
      || listedPlugins.some((listing) => (
        !listing
        || typeof listing !== "object"
        || Array.isArray(listing)
        || typeof listing.pluginId !== "string"
        || !listing.pluginId
        || typeof listing.manifestPathHint !== "string"
        || (listing.manifestPathHint && !/^(?:[^/]+\/)?manifest\.json$/i.test(listing.manifestPathHint))
      ))
      || new Set(listedPlugins.map((listing) => listing.pluginId)).size !== listedPlugins.length
      || new Set(manifestHints).size !== manifestHints.length
    )
  ) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      "Listed plugins are invalid for the static scan",
    );
  }
  const forcedEntryPoints = new Set();
  if (listedPlugins?.length) {
    const expectedPluginIds = new Set(listedPlugins.map((listing) => listing.pluginId));
    const treeEntries = new Map(tree.map((entry) => [entry.path, entry]));
    const manifestEntries = tree.filter((entry) => (
      /^(?:[^/]+\/)?manifest\.json$/i.test(entry.path)
      && entry.type === "blob"
      && entry.mode !== "120000"
    ));
    if (manifestEntries.length > securitySnapshotFileLimit) {
      throw new SecurityBaselineError(
        "security-baseline-scan-limit",
        "The repository has too many supported plugin manifests for a complete static scan",
      );
    }
    const hintedPaths = listedPlugins.map((listing) => listing.manifestPathHint).filter((path) => (
      treeEntries.get(path)?.type === "blob" && treeEntries.get(path)?.mode !== "120000"
    ));
    const orderedPaths = [
      ...hintedPaths,
      ...manifestEntries.map((entry) => entry.path),
    ].filter((path, index, paths) => paths.indexOf(path) === index);
    const declaredManifestSize = orderedPaths.reduce((sum, path) => {
      const size = Number(treeEntries.get(path)?.size);
      return sum + (Number.isSafeInteger(size) && size >= 0 ? size : securityFileByteLimit);
    }, 0);
    if (declaredManifestSize > securitySnapshotByteLimit) {
      throw new SecurityBaselineError(
        "security-baseline-scan-limit",
        "The supported plugin manifests exceed the static scan size limit",
      );
    }
    const manifests = await mapWithConcurrency(orderedPaths, 8, async (path) => {
      const entry = treeEntries.get(path);
      const file = await readSnapshotFile(repository, expectedCommit, entry, { fetchImpl, token });
      try {
        return { entry, manifest: JSON.parse(file.content) };
      } catch {
        return { entry, manifest: null };
      }
    });
    const foundPluginIds = new Set();
    for (const { entry, manifest } of manifests) {
      if (!expectedPluginIds.has(manifest?.id)) continue;
      if (foundPluginIds.has(manifest.id)) {
        throw new SecurityBaselineError(
          "security-baseline-unavailable",
          `Listed plugin ${manifest.id} has duplicate manifests at the requested commit`,
        );
      }
      const entryPoints = manifest.entryPoints;
      const paths = entryPoints && typeof entryPoints === "object" && !Array.isArray(entryPoints)
        ? Object.values(entryPoints)
        : [];
      if (
        !paths.length
        || paths.some((path) => (
          typeof path !== "string"
          || !path.trim()
          || path.startsWith("/")
          || path.includes("..")
          || /[\\:\r\n\0]/.test(path)
        ))
      ) {
        throw new SecurityBaselineError(
          "security-baseline-unavailable",
          `Listed plugin ${manifest.id} has invalid entry points at the requested commit`,
        );
      }
      const prefix = entry.path.includes("/")
        ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1)
        : "";
      for (const path of paths) {
        const resolvedPath = `${prefix}${path}`;
        const treeEntry = treeEntries.get(resolvedPath);
        if (treeEntry?.type !== "blob" || treeEntry.mode === "120000") {
          throw new SecurityBaselineError(
            "security-baseline-unavailable",
            `Listed plugin ${manifest.id} has a missing entry point at the requested commit`,
          );
        }
        forcedEntryPoints.add(resolvedPath);
      }
      foundPluginIds.add(manifest.id);
    }
    const missingPluginIds = [...expectedPluginIds].filter((id) => !foundPluginIds.has(id));
    if (missingPluginIds.length) {
      throw new SecurityBaselineError(
        "security-baseline-unavailable",
        `Listed plugin ${missingPluginIds[0]} is missing at the requested commit`,
      );
    }
  } else {
    const rootManifestEntry = tree.find((entry) => (
      entry.path === "manifest.json"
      && entry.type === "blob"
      && entry.mode !== "120000"
    ));
    if (rootManifestEntry) {
      const manifestFile = await readSnapshotFile(
        repository,
        expectedCommit,
        rootManifestEntry,
        { fetchImpl, token },
      );
      try {
        const manifest = JSON.parse(manifestFile.content);
        for (const path of Object.values(manifest.entryPoints || {}).filter((path) => (
          typeof path === "string"
          && path
          && !path.startsWith("/")
          && !path.includes("..")
        ))) {
          forcedEntryPoints.add(path);
        }
      } catch {
        throw new SecurityBaselineError(
          "security-baseline-unavailable",
          "The validated root manifest could not be read for the static scan",
        );
      }
    }
  }
  for (const path of requiredPaths) forcedEntryPoints.add(path);
  const binaryAssetProbeEntries = tree.filter((entry) => {
    if (
      entry.type !== "blob"
      || entry.mode === "120000"
      || entry.mode === "100755"
      || !isBinaryAssetPath(entry.path)
      || !isSetupNamedPath(entry.path)
      || forcedEntryPoints.has(entry.path)
    ) return false;
    const parts = entry.path.toLowerCase().split("/");
    const excluded = parts.slice(0, -1).some((part) => excludedDirectories.has(part));
    return !excluded;
  });
  const binaryAssetProbeBytes = binaryAssetProbeEntries.reduce(
    (total, entry) => total + Math.min(Number(entry.size), securityAssetProbeByteLimit),
    0,
  );
  if (
    binaryAssetProbeEntries.length > securityAssetProbeFileLimit
    || binaryAssetProbeBytes > securityAssetProbeByteLimit
  ) {
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      `The repository has more than ${securityAssetProbeFileLimit} setup-named binary asset candidates or exceeds the asset probe budget`,
    );
  }
  const probedBinaryAssets = await mapWithConcurrency(binaryAssetProbeEntries, 8, async (entry) => (
    probeSnapshotFile(repository, expectedCommit, entry, {
      fetchImpl,
      token,
      probeLimit: securityAssetProbeByteLimit,
    })
  ));
  const completeBinaryAssets = probedBinaryAssets.filter((file) => file.binary && file.complete);
  if (completeBinaryAssets.length) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      `A complete setup-named binary asset cannot be excluded from the static scan: ${completeBinaryAssets[0].path}`,
      { path: completeBinaryAssets[0].path },
    );
  }
  const probedTextAssetPaths = new Set(
    probedBinaryAssets
      .filter((file) => !file.binary || !file.complete)
      .map((file) => file.path),
  );
  const entries = tree.filter((entry) => {
    if (entry.type !== "blob" || entry.mode === "120000") return false;
    const parts = entry.path.toLowerCase().split("/");
    const basename = parts.at(-1);
    const forced = forcedEntryPoints.has(entry.path);
    const excluded = parts.slice(0, -1).some((part) => excludedDirectories.has(part));
    if (excluded && !forced) return false;
    const extensionless = !basename.includes(".");
    return isSecurityScanPath(entry.path)
      || entry.mode === "100755"
      || extensionless
      || forced
      || probedTextAssetPaths.has(entry.path);
  });
  if (entries.length > securitySnapshotFileLimit) {
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      `The repository has more than ${securitySnapshotFileLimit} relevant text files`,
    );
  }
  const declaredTextSize = entries.reduce((sum, entry) => (
    sum + (entry.mode === "100755" && Number(entry.size || 0) > securityFileByteLimit
      ? securityBinaryProbeByteLimit
      : Number(entry.size || 0))
  ), 0);
  if (declaredTextSize > securitySnapshotByteLimit) {
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      "The relevant repository text files exceed the static scan size limit",
    );
  }
  const files = await mapWithConcurrency(entries, 8, async (entry) => ({
    ...await readSnapshotFile(repository, expectedCommit, entry, { fetchImpl, token }),
    ...(forcedEntryPoints.has(entry.path) && !isSecurityScanPath(entry.path)
      ? { entryPoint: true }
      : {}),
  }));
  const includedPaths = new Set(entries.map((entry) => entry.path));
  const referencedPolicyPaths = typeof options.referencedPaths === "function"
    ? options.referencedPaths(files, tree)
    : new Set();
  if (!(referencedPolicyPaths instanceof Set)) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      "Referenced security paths are invalid for the static scan",
    );
  }
  const referencedEntries = tree.filter((entry) => (
    referencedPolicyPaths.has(entry.path)
    && entry.type === "blob"
    && entry.mode !== "120000"
    && !includedPaths.has(entry.path)
  ));
  if (entries.length + referencedEntries.length > securitySnapshotFileLimit) {
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      `The repository has more than ${securitySnapshotFileLimit} relevant text files`,
    );
  }
  const referencedSize = referencedEntries.reduce((sum, entry) => sum + Number(entry.size || 0), 0);
  if (declaredTextSize + referencedSize > securitySnapshotByteLimit) {
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      "The relevant repository text files exceed the static scan size limit",
    );
  }
  const referencedFiles = await mapWithConcurrency(referencedEntries, 8, async (entry) => (
    readSnapshotFile(repository, expectedCommit, entry, { fetchImpl, token })
  ));
  return {
    repository: repository.slug,
    repoUrl: `https://github.com/${repository.owner}/${repository.repository}`,
    commitSha: expectedCommit,
    defaultBranch: metadata.default_branch,
    files: [...files, ...referencedFiles],
  };
}
