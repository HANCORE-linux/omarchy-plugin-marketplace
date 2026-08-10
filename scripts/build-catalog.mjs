import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const registryPath = resolve(root, "registry.json");
const catalogPath = resolve(root, "site/catalog.json");
const previewDirectory = resolve(root, "site/assets/img/plugins");
const previewParent = dirname(previewDirectory);
export const previewByteLimit = 50 * 1024 * 1024;
export const previewPixelLimit = 40_000_000;
export const previewCardLimit = 720;
export const previewDetailLimit = 1600;
const fileLimit = 1024 * 1024;
const requestTimeout = 15_000;
const accents = ["lime", "amber", "coral", "cyan", "violet", "rose"];
const supportedKinds = new Set(["bar", "bar-widget", "menu", "overlay", "panel", "service"]);
const supportedPreviewFormats = new Set(["png", "jpeg", "webp", "avif", "heif"]);
const defaultPreviewPattern = /^preview\.(?:png|jpe?g|webp|avif)$/i;
export const manifestFieldLimits = Object.freeze({
  id: 128,
  name: 120,
  version: 64,
  author: 120,
  description: 500,
  license: 120,
});
export const maximumManifestVersionLength = manifestFieldLimits.version;
const errorCodes = new Set([
  "repository-unreachable",
  "manifest-invalid",
  "entry-point-missing",
  "reserved-plugin-id",
  "readme-missing",
  "license-missing",
  "preview-invalid",
  "unsupported-repository-layout",
]);

export const upstreamCheckErrorCodes = Object.freeze([...errorCodes]);

export class CatalogCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatalogCheckError";
    this.code = errorCodes.has(code) ? code : "manifest-invalid";
  }
}

export function assertRecoverableCatalogError(error) {
  if (!(error instanceof CatalogCheckError)) throw error;
  return error;
}

function checkError(code, message) {
  throw new CatalogCheckError(code, message);
}

export function catalogErrorCode(error, fallback = "manifest-invalid") {
  return errorCodes.has(error?.code) ? error.code : fallback;
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "omarchy-plugin-marketplace-catalog-builder",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchWithTimeout(url, options = {}) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(requestTimeout),
    });
  } catch (error) {
    throw new CatalogCheckError(
      "repository-unreachable",
      `Network request failed for ${new URL(url).hostname}: ${error.message}`,
    );
  }
}

export function parseGitHubRepository(repoUrl) {
  let url;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new Error(`Invalid repository URL: ${repoUrl}`);
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error(`Only public HTTPS GitHub repositories are supported: ${repoUrl}`);
  }
  const parts = url.pathname.replace(/^\/|\/$/g, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Repository URL must point to a repository root: ${repoUrl}`);
  }
  return {
    owner: parts[0],
    repository: parts[1].replace(/\.git$/, ""),
    slug: `${parts[0]}/${parts[1].replace(/\.git$/, "")}`,
  };
}

async function githubApi(path, { optional = false } = {}) {
  const response = await fetchWithTimeout(`https://api.github.com${path}`, {
    headers: githubHeaders(),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    throw new CatalogCheckError(
      "repository-unreachable",
      `GitHub API ${response.status}${remaining === "0" ? " (rate limit exhausted)" : ""}`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new CatalogCheckError(
      "repository-unreachable",
      `GitHub API response body could not be read: ${error.message}`,
    );
  }
}

function responseBodyError(label, error) {
  return new CatalogCheckError(
    "repository-unreachable",
    `${label} response body could not be read: ${error.message}`,
  );
}

export async function readLimitedBuffer(response, limit, code, label) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > limit) checkError(code, `${label} exceeds the ${limit}-byte limit`);
  const reader = response.body?.getReader();
  if (!reader) {
    let arrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (error) {
      throw responseBodyError(label, error);
    }
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > limit) checkError(code, `${label} exceeds the ${limit}-byte limit`);
    return buffer;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw responseBodyError(label, error);
    }
    const { done, value } = chunk;
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      try {
        await reader.cancel();
      } catch {
        // The content-size error below remains authoritative.
      }
      checkError(code, `${label} exceeds the ${limit}-byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function rawUrl(repository, commitSha, path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${repository.owner}/${repository.repository}/${commitSha}/${encodedPath}`;
}

async function readSnapshotBuffer(repository, path, commitSha, limit, code) {
  const response = await fetchWithTimeout(rawUrl(repository, commitSha, path), {
    headers: { "User-Agent": "omarchy-plugin-marketplace-catalog-builder" },
  });
  if (!response.ok) {
    checkError(
      snapshotHttpErrorCode(response.status, code),
      `Snapshot file download returned ${response.status}`,
    );
  }
  return readLimitedBuffer(response, limit, code, path);
}

export function snapshotHttpErrorCode(status, contentErrorCode) {
  return status === 429 || status >= 500
    ? "repository-unreachable"
    : contentErrorCode;
}

async function readSnapshotText(repository, path, commitSha) {
  const buffer = await readSnapshotBuffer(
    repository,
    path,
    commitSha,
    fileLimit,
    "manifest-invalid",
  );
  return buffer.toString("utf8");
}

function treeEntry(context, path) {
  return context.treeByPath.get(path);
}

function isBlob(entry) {
  return entry?.type === "blob" && entry.mode !== "120000";
}

function entryPointKey(kind) {
  return kind === "bar-widget" ? "barWidget" : kind;
}

export function validateManifest(manifest, manifestPath, { community = false } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    checkError("manifest-invalid", `${manifestPath}: manifest must be a JSON object`);
  }
  if (manifest.schemaVersion !== 1) {
    checkError("manifest-invalid", `${manifestPath}: manifest field "schemaVersion" must be exactly 1`);
  }
  const required = ["id", "name", "version", "author", "description"];
  for (const field of required) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      checkError("manifest-invalid", `${manifestPath}: manifest field "${field}" is required`);
    }
    const normalized = manifest[field].trim();
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
      checkError("manifest-invalid", `${manifestPath}: manifest field "${field}" contains control characters`);
    }
    if (community && normalized.length > manifestFieldLimits[field]) {
      checkError(
        "manifest-invalid",
        `${manifestPath}: manifest field "${field}" must not exceed ${manifestFieldLimits[field]} characters`,
      );
    }
    manifest[field] = normalized;
  }
  if (manifest.license !== undefined) {
    if (typeof manifest.license !== "string" || !manifest.license.trim()) {
      checkError("manifest-invalid", `${manifestPath}: manifest field "license" must be a non-empty string`);
    }
    const normalizedLicense = manifest.license.trim();
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalizedLicense)) {
      checkError("manifest-invalid", `${manifestPath}: manifest field "license" contains control characters`);
    }
    if (community && normalizedLicense.length > manifestFieldLimits.license) {
      checkError(
        "manifest-invalid",
        `${manifestPath}: manifest field "license" must not exceed ${manifestFieldLimits.license} characters`,
      );
    }
    manifest.license = normalizedLicense;
  }
  if (
    !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id)
    || manifest.id.includes("..")
  ) {
    checkError("manifest-invalid", `${manifestPath}: manifest id contains unsupported characters`);
  }
  if (community && manifest.id !== manifest.id.toLowerCase()) {
    checkError("manifest-invalid", `${manifestPath}: community manifest ids must use lowercase characters`);
  }
  if (community && manifest.id.toLowerCase().startsWith("omarchy.")) {
    checkError("reserved-plugin-id", `${manifestPath}: the omarchy.* namespace is reserved`);
  }
  if (
    !Array.isArray(manifest.kinds)
    || manifest.kinds.length === 0
    || manifest.kinds.some((kind) => typeof kind !== "string" || !supportedKinds.has(kind))
  ) {
    checkError("manifest-invalid", `${manifestPath}: manifest "kinds" contains unsupported values`);
  }
  if (!manifest.entryPoints || typeof manifest.entryPoints !== "object" || Array.isArray(manifest.entryPoints)) {
    checkError("manifest-invalid", `${manifestPath}: manifest "entryPoints" must be an object`);
  }
  for (const kind of manifest.kinds) {
    if (!Object.hasOwn(manifest.entryPoints, entryPointKey(kind))) {
      checkError("entry-point-missing", `${manifestPath}: entry point for "${kind}" is missing`);
    }
  }
  const entryPoints = Object.values(manifest.entryPoints);
  if (
    entryPoints.length === 0
    || entryPoints.some((entryPoint) => (
      typeof entryPoint !== "string"
      || !entryPoint.trim()
      || entryPoint.startsWith("/")
      || entryPoint.includes("..")
      || /[\\:\r\n\0]/.test(entryPoint)
    ))
  ) {
    checkError("manifest-invalid", `${manifestPath}: entry points must be safe relative paths`);
  }
  return manifest;
}

function validateManifestFiles(manifest, manifestPath, context, { community = false } = {}) {
  validateManifest(manifest, manifestPath, { community });
  const pluginRoot = manifestPath.includes("/") ? dirname(manifestPath) : "";
  const prefix = pluginRoot ? `${pluginRoot}/` : "";
  const entries = context.tree.filter((entry) => !pluginRoot || entry.path.startsWith(prefix));
  if (entries.some((entry) => entry.mode === "120000")) {
    checkError("manifest-invalid", `${manifestPath}: symlinks are not allowed in plugin folders`);
  }
  for (const path of Object.values(manifest.entryPoints)) {
    if (!isBlob(treeEntry(context, `${prefix}${path}`))) {
      checkError("entry-point-missing", `${manifestPath}: declared entry point is missing`);
    }
  }
  return manifest;
}

function looksLikePluginManifest(manifest) {
  return manifest && (
    Object.hasOwn(manifest, "schemaVersion")
    || Object.hasOwn(manifest, "id")
  );
}

function validateRepositoryDocs(context) {
  const rootFiles = context.tree.filter((entry) => !entry.path.includes("/") && isBlob(entry));
  if (!rootFiles.some((entry) => /^readme(?:\.[^/]+)?$/i.test(entry.path))) {
    checkError("readme-missing", `${context.repository.slug}: a root README is required`);
  }
  if (!rootFiles.some((entry) => /^(?:licen[cs]e|copying)(?:\.[^/]+)?$/i.test(entry.path))) {
    checkError("license-missing", `${context.repository.slug}: a root license file is required`);
  }
}

async function resolveSnapshot(source) {
  const repository = parseGitHubRepository(source.repo);
  const metadata = await githubApi(`/repos/${repository.owner}/${repository.repository}`);
  if (metadata.private || metadata.disabled || metadata.archived) {
    checkError("repository-unreachable", `${repository.slug} must be public, active, and unarchived`);
  }
  const branch = source.branch || metadata.default_branch;
  const commit = await githubApi(
    `/repos/${repository.owner}/${repository.repository}/commits/${encodeURIComponent(branch)}`,
  );
  const commitSha = commit.sha;
  const treeSha = commit.commit?.tree?.sha;
  if (!/^[a-f0-9]{40}$/i.test(commitSha || "") || !/^[a-f0-9]{40}$/i.test(treeSha || "")) {
    checkError("repository-unreachable", `${repository.slug}: GitHub returned an invalid snapshot`);
  }
  const treeResponse = await githubApi(
    `/repos/${repository.owner}/${repository.repository}/git/trees/${treeSha}?recursive=1`,
  );
  if (treeResponse.truncated) {
    checkError("unsupported-repository-layout", `${repository.slug}: repository tree is too large`);
  }
  const tree = treeResponse.tree || [];
  return {
    repository,
    metadata,
    branch,
    commitSha,
    treeSha,
    tree,
    treeByPath: new Map(tree.map((entry) => [entry.path, entry])),
  };
}

async function optionalRepositoryRelease(context) {
  try {
    const release = await githubApi(
      `/repos/${context.repository.owner}/${context.repository.repository}/releases/latest`,
      { optional: true },
    );
    if (release?.tag_name && !release.draft) {
      return {
        tag: release.tag_name,
        url: `https://github.com/${context.repository.slug}/releases/tag/${encodeURIComponent(release.tag_name)}`,
        publishedAt: release.published_at || release.created_at,
      };
    }
    const tags = await githubApi(
      `/repos/${context.repository.owner}/${context.repository.repository}/tags?per_page=1`,
    );
    if (!tags[0]?.name) return null;
    return {
      tag: tags[0].name,
      url: `https://github.com/${context.repository.slug}/tree/${encodeURIComponent(tags[0].name)}`,
    };
  } catch (error) {
    assertRecoverableCatalogError(error);
    return null;
  }
}

function previewPathFor(source, context) {
  if (source.previewPath) return source.previewPath.replace(/^\/+/, "");
  if (source.previewImage) {
    const parsed = new URL(source.previewImage);
    const prefix = `/${context.repository.owner}/${context.repository.repository}/`;
    if (parsed.hostname !== "raw.githubusercontent.com" || !parsed.pathname.startsWith(prefix)) {
      checkError("preview-invalid", `${context.repository.slug}: preview must come from the listed repository`);
    }
    const rest = parsed.pathname.slice(prefix.length).split("/");
    rest.shift();
    return rest.join("/");
  }
  const candidates = context.tree
    .filter((entry) => !entry.path.includes("/") && isBlob(entry) && defaultPreviewPattern.test(entry.path))
    .map((entry) => entry.path);
  const priority = ["preview.png", "preview.webp", "preview.jpg", "preview.jpeg", "preview.avif"];
  return candidates.sort((left, right) => {
    const leftIndex = priority.indexOf(left.toLowerCase());
    const rightIndex = priority.indexOf(right.toLowerCase());
    return leftIndex - rightIndex || left.localeCompare(right);
  })[0] || "";
}

function previewExtension(path) {
  const extension = extname(path).toLowerCase();
  if ([".png", ".webp", ".jpg", ".jpeg", ".avif"].includes(extension)) return extension;
  checkError("preview-invalid", `Unsupported preview image extension: ${extension || "none"}`);
}

export function previewFileBase(repository) {
  const owner = repository.owner.toLowerCase();
  const name = repository.repository.toLowerCase();
  return `${owner.length}-${owner}-${name}`;
}

export function validatePreviewMetadata(metadata, label = "Preview") {
  if (
    !supportedPreviewFormats.has(metadata?.format)
    || !Number.isSafeInteger(metadata.width)
    || !Number.isSafeInteger(metadata.height)
    || metadata.width < 1
    || metadata.height < 1
    || metadata.width > previewPixelLimit / metadata.height
  ) {
    checkError(
      "preview-invalid",
      `${label} must be a valid PNG, JPEG, WebP, or AVIF image within the ${previewPixelLimit}-pixel limit`,
    );
  }
  return metadata;
}

export async function optimizePreviewBuffer(buffer, repository) {
  try {
    const image = sharp(buffer, {
      failOn: "error",
      limitInputPixels: previewPixelLimit,
    });
    const metadata = validatePreviewMetadata(
      await image.metadata(),
      `${repository.slug} preview`,
    );
    const card = await image
      .clone()
      .rotate()
      .resize({
        width: previewCardLimit,
        height: previewCardLimit,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 78, alphaQuality: 85, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    const detail = await image
      .clone()
      .rotate()
      .resize({
        width: previewDetailLimit,
        height: previewDetailLimit,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, alphaQuality: 90, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    const fileBase = previewFileBase(repository);
    const cardFileName = `${fileBase}-card.webp`;
    const detailFileName = `${fileBase}-detail.webp`;
    return {
      fileBase,
      outputs: [
        { fileName: cardFileName, buffer: card.data },
        { fileName: detailFileName, buffer: detail.data },
      ],
      metadata: {
        previewImage: `assets/img/plugins/${detailFileName}`,
        previewWidth: detail.info.width,
        previewHeight: detail.info.height,
        previewThumbnail: `assets/img/plugins/${cardFileName}`,
        previewThumbnailWidth: card.info.width,
        previewThumbnailHeight: card.info.height,
        previewSourceWidth: metadata.width,
        previewSourceHeight: metadata.height,
      },
    };
  } catch (error) {
    if (error instanceof CatalogCheckError) throw error;
    checkError("preview-invalid", `${repository.slug}: preview could not be decoded safely`);
  }
}

async function loadSnapshotPreview(source, context) {
  const path = previewPathFor(source, context);
  if (!path) return null;
  const entry = treeEntry(context, path);
  if (!isBlob(entry) || !Number.isFinite(entry.size) || entry.size < 1 || entry.size > previewByteLimit) {
    checkError("preview-invalid", `${context.repository.slug}: preview is missing, linked, or too large`);
  }
  previewExtension(path);
  const buffer = await readSnapshotBuffer(
    context.repository,
    path,
    context.commitSha,
    previewByteLimit,
    "preview-invalid",
  );
  return optimizePreviewBuffer(buffer, context.repository);
}

async function stageSnapshotPreview(snapshot, stageDirectory) {
  if (!snapshot) return;
  for (const output of snapshot.outputs) {
    await writeFile(resolve(stageDirectory, output.fileName), output.buffer);
  }
}

export async function validateBeforeStagingPreview({
  loadPreview,
  validateSource,
  stagePreview,
}) {
  const snapshot = await loadPreview();
  const result = await validateSource(snapshot?.metadata || null);
  if (snapshot) await stagePreview(snapshot);
  return result;
}

function repositoryMetadata(metadata) {
  return {
    stars: metadata.stargazers_count || 0,
    repositoryUpdatedAt: metadata.pushed_at || metadata.updated_at,
  };
}

function listingDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label}: addedAt must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}: addedAt is not a valid calendar date`);
  }
  return value;
}

function listingTimestamp(value, addedAt, label) {
  const timestamp = value || `${addedAt}T00:00:00.000Z`;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label}: listedAt must be a UTC ISO timestamp`);
  }
  return timestamp;
}

function requireListingProvenance(source) {
  if (
    !/^[a-f0-9]{40}$/i.test(source.listingValidatedCommit || "")
    || !source.listingValidatedAt
    || !source.listingValidatedBranch
  ) {
    throw new Error(`${source.repo}: immutable listing validation provenance is missing`);
  }
  return {
    listingValidatedCommit: source.listingValidatedCommit,
    listingValidatedAt: source.listingValidatedAt,
    listingValidatedBranch: source.listingValidatedBranch,
  };
}

function initials(name) {
  return String(name)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function accentFor(id) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return accents[hash % accents.length];
}

function kindFor(kinds = []) {
  if (kinds.includes("bar-widget")) return "Bar widget";
  if (kinds.includes("overlay")) return "Overlay";
  if (kinds.includes("panel")) return "Panel";
  if (kinds.includes("bar")) return "Bar";
  if (kinds.includes("service")) return "Service";
  return "Plugin";
}

function categoryFor(kinds = []) {
  if (kinds.includes("bar-widget")) return "Widgets";
  if (kinds.includes("overlay") || kinds.includes("panel") || kinds.includes("bar")) return "Desktop";
  if (kinds.includes("service")) return "System";
  return "Other";
}

function registryPresentation(overrides = {}) {
  const allowed = ["category", "tags", "accent", "initials", "kind"];
  return Object.fromEntries(
    allowed
      .filter((field) => overrides[field] !== undefined)
      .map((field) => [field, overrides[field]]),
  );
}

function repositoryGitUrl(repo) {
  return repo.endsWith(".git") ? repo : `${repo}.git`;
}

function communityInstall(source, manifestPath) {
  if (manifestPath === "manifest.json") {
    return {
      repositoryLayout: "root-plugin",
      installAvailable: true,
      installCommand: `omarchy plugin add ${repositoryGitUrl(source.repo)} --enable`,
      installNote: "Omarchy clones the current upstream repository, validates it locally, and only then installs and enables the plugin.",
    };
  }
  return {
    repositoryLayout: "monorepo",
    installAvailable: false,
    installCommand: "",
    installNote: "Automatic installation is unavailable because this plugin is stored inside a multi-plugin repository without a transactional Omarchy update path.",
  };
}

export function isListedPlugin(source, pluginId) {
  return Object.hasOwn(source.plugins || {}, pluginId);
}

export function successfulState(plugin, source, context, previous, checkedAt) {
  const prior = previous?.id === plugin.id ? previous : null;
  const changedVersion = prior && prior.version !== plugin.version;
  return {
    ...plugin,
    ...requireListingProvenance(source),
    upstreamObservedCommit: context.commitSha,
    upstreamObservedBranch: context.branch,
    upstreamCheckedAt: checkedAt,
    upstreamCheckStatus: "passed",
    upstreamValidatedCommit: context.commitSha,
    upstreamValidatedAt: checkedAt,
    ...(changedVersion
      ? { versionUpdatedAt: checkedAt }
      : prior?.versionUpdatedAt
        ? { versionUpdatedAt: prior.versionUpdatedAt }
        : {}),
    status: plugin.installAvailable ? "Available" : "Manual setup",
  };
}

export function applyVersionState(plugins, previousPlugins, checkedAt) {
  const previousById = new Map((previousPlugins || []).map((plugin) => [plugin.id, plugin]));
  return plugins.map((plugin) => {
    const previous = previousById.get(plugin.id);
    if (!previous || previous.version === plugin.version) {
      return previous?.versionUpdatedAt
        ? { ...plugin, versionUpdatedAt: previous.versionUpdatedAt }
        : plugin;
    }
    return { ...plugin, versionUpdatedAt: checkedAt };
  });
}

function suitePlugin(source, context, preview) {
  if (!source.catalog?.id || !source.catalog?.name) {
    checkError("unsupported-repository-layout", `${context.repository.slug}: suite metadata is incomplete`);
  }
  const addedAt = listingDate(source.catalog.addedAt || source.addedAt, context.repository.slug);
  return {
    ...source.catalog,
    repo: source.repo,
    sourceType: "community",
    addedAt,
    listedAt: listingTimestamp(
      source.catalog.listedAt || source.listedAt,
      addedAt,
      context.repository.slug,
    ),
    repositoryLayout: "suite",
    installAvailable: false,
    installCommand: "",
    installNote: "This repository is a shell suite with its own installer, not an installable Omarchy Quattro plugin repository.",
    license: "See repository",
    ...repositoryMetadata(context.metadata),
    ...(context.repositoryRelease ? { repositoryRelease: context.repositoryRelease } : {}),
    ...(preview || {}),
  };
}

export async function discoveredPlugins(source, context, preview) {
  const manifestPaths = context.tree
    .filter((entry) => isBlob(entry) && /^(?:[^/]+\/)?manifest\.json$/i.test(entry.path))
    .map((entry) => entry.path)
    .sort();
  if (!manifestPaths.length) {
    checkError("unsupported-repository-layout", `${context.repository.slug}: no supported plugin manifests found`);
  }
  const configuredOrder = new Map(
    Object.keys(source.plugins || {}).map((id, index) => [id, index]),
  );
  const plugins = [];
  const seenIds = new Set();
  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      manifest = JSON.parse(
        await readSnapshotText(context.repository, manifestPath, context.commitSha),
      );
    } catch (error) {
      if (error instanceof CatalogCheckError) throw error;
      checkError("manifest-invalid", `${context.repository.slug}/${manifestPath}: invalid JSON`);
    }
    if (!looksLikePluginManifest(manifest)) continue;
    const candidateId = typeof manifest.id === "string" ? manifest.id.trim() : manifest.id;
    if (!isListedPlugin(source, candidateId)) continue;
    validateManifestFiles(manifest, manifestPath, context, { community: true });
    if (seenIds.has(manifest.id)) {
      checkError("manifest-invalid", `${context.repository.slug}: duplicate plugin id`);
    }
    seenIds.add(manifest.id);
    const kinds = manifest.kinds.map(String);
    const overrides = source.plugins?.[manifest.id] || {};
    const addedAt = listingDate(
      overrides.addedAt || source.addedAt,
      `${context.repository.slug}/${manifest.id}`,
    );
    plugins.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      version: manifest.version,
      repo: source.repo,
      sourceType: "community",
      manifestPath,
      addedAt,
      listedAt: listingTimestamp(
        overrides.listedAt || source.listedAt,
        addedAt,
        `${context.repository.slug}/${manifest.id}`,
      ),
      ...communityInstall(source, manifestPath),
      category: categoryFor(kinds),
      tags: kinds.slice(0, 3).map((kind) => kind.toLowerCase()),
      license: manifest.license || "See repository",
      ...repositoryMetadata(context.metadata),
      ...(context.repositoryRelease ? { repositoryRelease: context.repositoryRelease } : {}),
      accent: accentFor(manifest.id),
      initials: initials(manifest.name),
      kind: kindFor(kinds),
      ...(preview || {}),
      ...registryPresentation(overrides),
    });
  }
  if (!plugins.length) {
    checkError("manifest-invalid", `${context.repository.slug}: no valid plugin manifests found`);
  }
  for (const configuredId of Object.keys(source.plugins || {})) {
    if (!seenIds.has(configuredId)) {
      checkError("manifest-invalid", `${context.repository.slug}: configured plugin is missing`);
    }
  }
  return plugins.sort((left, right) => {
    const leftOrder = configuredOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = configuredOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.name.localeCompare(right.name);
  });
}

export function failedSourcePlugins(source, previousPlugins, context, checkedAt, error) {
  const previous = previousPlugins.filter((plugin) => plugin.repo === source.repo);
  if (!previous.length) throw error;
  const code = catalogErrorCode(error);
  const unreachable = code === "repository-unreachable";
  return previous.map((plugin) => {
    const rootInstall = plugin.repositoryLayout === "root-plugin"
      ? communityInstall(source, plugin.manifestPath || "manifest.json")
      : null;
    return {
      ...plugin,
      upstreamCheckedAt: checkedAt,
      upstreamCheckStatus: unreachable ? "unreachable" : "failed",
      upstreamCheckError: code,
      ...(!unreachable && context
        ? {
            upstreamObservedCommit: context.commitSha,
            upstreamObservedBranch: context.branch,
          }
        : {}),
      installAvailable: Boolean(unreachable && rootInstall),
      installCommand: unreachable && rootInstall ? rootInstall.installCommand : "",
      status: unreachable ? "Status unknown" : "Compatibility failed",
    };
  });
}

function builtInCategory(kinds) {
  const labels = {
    bar: "Bars",
    "bar-widget": "Bar widgets",
    overlay: "Overlays",
    service: "Services",
    panel: "Panels",
    menu: "Menus",
  };
  return labels[kinds[0]] || "Other";
}

function builtInKind(kinds) {
  const labels = {
    bar: "Bar",
    "bar-widget": "Bar widget",
    overlay: "Overlay",
    service: "Service",
    panel: "Panel",
    menu: "Menu",
  };
  return kinds.map((kind) => labels[kind] || kind).join(" + ");
}

function builtInCommand(id, kinds) {
  if (kinds.includes("bar-widget")) {
    return { command: `omarchy bar plugin add ${id}`, label: "Add to bar" };
  }
  return { command: `omarchy plugin enable ${id}`, label: "Enable plugin" };
}

async function discoveredBuiltIns(source, context) {
  const manifestRoot = String(source.manifestRoot || "shell/plugins").replace(/^\/|\/$/g, "");
  const prefix = `${manifestRoot}/`;
  const excluded = new Set(source.exclude || []);
  const manifestPaths = context.tree
    .filter((entry) => (
      isBlob(entry)
      && entry.path.startsWith(prefix)
      && /(?:^|\/)(?:manifest|[^/]+\.manifest)\.json$/i.test(entry.path)
    ))
    .map((entry) => entry.path)
    .sort();
  if (!manifestPaths.length) {
    checkError("unsupported-repository-layout", `${context.repository.slug}: no built-in manifests found`);
  }
  const metadata = repositoryMetadata(context.metadata);
  const plugins = await Promise.all(manifestPaths.map(async (manifestPath) => {
    let sourceManifest;
    try {
      sourceManifest = JSON.parse(
        await readSnapshotText(context.repository, manifestPath, context.commitSha),
      );
    } catch (error) {
      if (error instanceof CatalogCheckError) throw error;
      checkError("manifest-invalid", `${context.repository.slug}/${manifestPath}: invalid JSON`);
    }
    const manifest = {
      author: "Omarchy",
      description: `Built-in ${sourceManifest.name || sourceManifest.id || "Omarchy"} plugin`,
      ...sourceManifest,
    };
    validateManifestFiles(manifest, manifestPath, context);
    if (excluded.has(manifest.id)) return null;
    const kinds = manifest.kinds.map(String);
    const officialCommand = builtInCommand(manifest.id, kinds);
    const sourceDirectory = dirname(manifestPath);
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      version: manifest.version,
      repo: source.repo,
      sourceUrl: `${source.repo}/tree/${context.commitSha}/${sourceDirectory}`,
      sourceType: "builtin",
      builtIn: true,
      manifestPath,
      installCommand: "",
      officialCommand: officialCommand.command,
      officialCommandLabel: officialCommand.label,
      installNote: "Included with Omarchy Quattro. No marketplace installation is required.",
      category: builtInCategory(kinds),
      tags: kinds,
      license: "See repository",
      repositoryUpdatedAt: metadata.repositoryUpdatedAt,
      accent: accentFor(manifest.id),
      initials: initials(manifest.name),
      kind: builtInKind(kinds),
      status: "Built in",
    };
  }));
  const visible = plugins.filter(Boolean);
  if (new Set(visible.map((plugin) => plugin.id)).size !== visible.length) {
    checkError("manifest-invalid", `${context.repository.slug}: duplicate built-in plugin IDs`);
  }
  return visible.sort((left, right) => left.name.localeCompare(right.name));
}

export async function inspectSubmission(repoUrl) {
  const source = { repo: repoUrl };
  const context = await resolveSnapshot(source);
  validateRepositoryDocs(context);
  const manifestPaths = context.tree
    .filter((entry) => isBlob(entry) && /^(?:[^/]+\/)?manifest\.json$/i.test(entry.path))
    .map((entry) => entry.path)
    .sort();
  if (manifestPaths.length !== 1 || manifestPaths[0] !== "manifest.json") {
    checkError(
      "unsupported-repository-layout",
      "New submissions require exactly one plugin manifest at the repository root",
    );
  }
  const manifests = [];
  const ids = new Set();
  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      manifest = JSON.parse(
        await readSnapshotText(context.repository, manifestPath, context.commitSha),
      );
    } catch (error) {
      if (error instanceof CatalogCheckError) throw error;
      checkError("manifest-invalid", `${manifestPath}: invalid JSON`);
    }
    if (!looksLikePluginManifest(manifest)) continue;
    validateManifestFiles(manifest, manifestPath, context, { community: true });
    if (ids.has(manifest.id)) checkError("manifest-invalid", "Duplicate plugin id");
    ids.add(manifest.id);
    manifests.push({
      path: manifestPath,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
    });
  }
  if (!manifests.length) checkError("manifest-invalid", "No valid plugin manifests found");
  const preview = await loadSnapshotPreview(source, context);
  return {
    repository: context.repository.slug,
    defaultBranch: context.branch,
    commitSha: context.commitSha,
    treeSha: context.treeSha,
    description: context.metadata.description || "",
    license: "repository-file",
    preview: Boolean(preview),
    manifests,
  };
}

async function seedPreviewStage(stageDirectory) {
  await mkdir(stageDirectory, { recursive: true });
  try {
    for (const entry of await readdir(previewDirectory, { withFileTypes: true })) {
      if (entry.isFile()) {
        await copyFile(resolve(previewDirectory, entry.name), resolve(stageDirectory, entry.name));
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function prunePreviewStage(stageDirectory, plugins) {
  const referenced = new Set();
  for (const plugin of plugins) {
    for (const field of ["previewImage", "previewThumbnail"]) {
      const value = plugin[field];
      if (typeof value === "string" && value.startsWith("assets/img/plugins/")) {
        referenced.add(value.slice("assets/img/plugins/".length));
      }
    }
  }
  for (const existing of await readdir(stageDirectory)) {
    if (!referenced.has(existing)) await unlink(resolve(stageDirectory, existing));
  }
}

async function commitGeneratedFiles(stageDirectory, serializedCatalog) {
  const catalogTemp = `${catalogPath}.tmp-${process.pid}`;
  const previewBackup = `${previewDirectory}.backup-${process.pid}`;
  await writeFile(catalogTemp, serializedCatalog);
  let movedPreview = false;
  try {
    await rm(previewBackup, { recursive: true, force: true });
    try {
      await rename(previewDirectory, previewBackup);
      movedPreview = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(stageDirectory, previewDirectory);
    await rename(catalogTemp, catalogPath);
    await rm(previewBackup, { recursive: true, force: true });
  } catch (error) {
    await rm(catalogTemp, { force: true });
    await rm(previewDirectory, { recursive: true, force: true });
    if (movedPreview) await rename(previewBackup, previewDirectory);
    throw error;
  }
}

export async function buildCatalog() {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const previous = JSON.parse(await readFile(catalogPath, "utf8"));
  const previousPlugins = previous.plugins || [];
  const previousById = new Map(previousPlugins.map((plugin) => [plugin.id, plugin]));
  const plugins = [];
  const warnings = [];
  const checkedAt = new Date().toISOString();
  await mkdir(previewParent, { recursive: true });
  const stageDirectory = await mkdtemp(resolve(previewParent, ".plugins-stage-"));
  await seedPreviewStage(stageDirectory);

  try {
    for (const source of registry.sources || []) {
      let context;
      try {
        context = await resolveSnapshot(source);
        context.repositoryRelease = await optionalRepositoryRelease(context);
        validateRepositoryDocs(context);
        const discovered = await validateBeforeStagingPreview({
          loadPreview: () => loadSnapshotPreview(source, context),
          validateSource: (preview) => (
            source.type === "suite"
              ? [suitePlugin(source, context, preview)]
              : source.type === "plugin-source"
                ? discoveredPlugins(source, context, preview)
                : checkError("unsupported-repository-layout", `${source.repo}: unsupported source type`)
          ),
          stagePreview: (snapshot) => stageSnapshotPreview(snapshot, stageDirectory),
        });
        plugins.push(...discovered.map((plugin) => successfulState(
          plugin,
          source,
          context,
          previousById.get(plugin.id),
          checkedAt,
        )));
      } catch (error) {
        assertRecoverableCatalogError(error);
        const preserved = failedSourcePlugins(source, previousPlugins, context, checkedAt, error);
        plugins.push(...preserved);
        const code = catalogErrorCode(error);
        warnings.push(`${source.repo}: ${code}`);
        console.error(`Catalog source refresh failed [${code}].`);
      }
    }

    for (const source of registry.builtInSources || []) {
      try {
        const context = await resolveSnapshot(source);
        plugins.push(...await discoveredBuiltIns(source, context));
      } catch (error) {
        assertRecoverableCatalogError(error);
        const preserved = previousPlugins.filter(
          (plugin) => plugin.builtIn && plugin.repo === source.repo,
        );
        if (!preserved.length) throw error;
        plugins.push(...preserved);
        warnings.push(`${source.repo}: built-in catalog refresh unavailable`);
        console.error(`Built-in catalog refresh failed [${catalogErrorCode(error)}].`);
      }
    }

    for (const placeholder of registry.placeholders || []) {
      plugins.push({ ...placeholder, sourceType: "community", placeholder: true });
      warnings.push(`${placeholder.name} is intentionally displayed as a placeholder.`);
    }

    if (new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length) {
      throw new Error("Catalog contains duplicate plugin IDs");
    }
    await prunePreviewStage(stageDirectory, plugins);
    const nextContent = {
      stateSchemaVersion: 1,
      mode: "production",
      plugins,
      warnings,
    };
    const previousContent = {
      stateSchemaVersion: previous.stateSchemaVersion,
      mode: previous.mode,
      plugins: previous.plugins,
      warnings: previous.warnings,
    };
    const changed = JSON.stringify(nextContent) !== JSON.stringify(previousContent);
    const next = {
      generatedAt: changed ? checkedAt : previous.generatedAt,
      ...nextContent,
    };
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    await commitGeneratedFiles(stageDirectory, serialized);
    console.log(
      `${changed ? "Updated" : "Validated"} ${plugins.length} plugins from ${
        (registry.sources || []).length + (registry.builtInSources || []).length
      } registered sources.`,
    );
  } catch (error) {
    await rm(stageDirectory, { recursive: true, force: true });
    throw error;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  buildCatalog().catch((error) => {
    console.error(`Catalog build failed [${catalogErrorCode(error, "internal-error")}].`);
    process.exitCode = 1;
  });
}
