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
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import sharp from "sharp";
import {
  catalogVerificationFields,
  projectCatalogVerification,
  projectPluginVerification,
} from "./catalog-verification.mjs";
import { parseGitHubRepository } from "./github-repository.mjs";

export { parseGitHubRepository } from "./github-repository.mjs";

const root = resolve(import.meta.dirname, "..");
const registryPath = resolve(root, "registry.json");
const catalogPath = resolve(root, "site/catalog.json");
const previewDirectory = resolve(root, "site/assets/img/plugins");
const previewParent = dirname(previewDirectory);
const readmeDirectory = resolve(root, "site/assets/readme");
const readmeParent = dirname(readmeDirectory);
export const previewByteLimit = 50 * 1024 * 1024;
export const previewPixelLimit = 40_000_000;
export const previewCardLimit = 720;
export const previewDetailLimit = 1600;
const fileLimit = 1024 * 1024;
export const readmeByteLimit = 256 * 1024;
export const readmeRenderedLimit = 512 * 1024;
const requestTimeout = 15_000;
const accents = ["lime", "amber", "coral", "cyan", "violet", "rose"];
const supportedKinds = new Set(["bar", "bar-widget", "menu", "overlay", "panel", "service"]);
const supportedPreviewFormats = new Set(["png", "jpeg", "webp", "avif", "heif"]);
const builtInTaxonomyTags = Object.freeze({
  "omarchy.agents": ["ai"],
  "omarchy.polkit": ["security"],
});
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

const fatalBuildErrorCodes = new Set([
  "rate-limit-exhausted",
  "github-api-forbidden",
]);

export const upstreamCheckErrorCodes = Object.freeze([...errorCodes]);

export class CatalogCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatalogCheckError";
    this.code = errorCodes.has(code) ? code : "manifest-invalid";
  }
}

export class CatalogBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatalogBuildError";
    this.code = fatalBuildErrorCodes.has(code) ? code : "internal-error";
    this.publicMessage = message;
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
  return errorCodes.has(error?.code) || fatalBuildErrorCodes.has(error?.code)
    ? error.code
    : fallback;
}

export function catalogRefreshFailureMessage(repoUrl, error, options = {}) {
  const repository = parseGitHubRepository(repoUrl);
  const safeSegment = (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 100);
  const slug = `${safeSegment(repository.owner)}/${safeSegment(repository.repository)}`;
  const source = options.builtIn ? "Built-in catalog" : "Catalog source";
  return `${source} refresh failed for ${slug} [${catalogErrorCode(error)}].`;
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

export function githubApiFailure(response) {
  const status = Number(response?.status || 0);
  const limit = response?.headers?.get("x-ratelimit-limit") || "unknown";
  const remaining = response?.headers?.get("x-ratelimit-remaining") || "unknown";
  const reset = response?.headers?.get("x-ratelimit-reset") || "";
  const retryAfter = response?.headers?.get("retry-after") || "";
  const resetMilliseconds = /^\d+$/.test(reset) ? Number(reset) * 1000 : Number.NaN;
  const resetDate = Number.isFinite(resetMilliseconds)
    && resetMilliseconds <= 8_640_000_000_000_000
    ? new Date(resetMilliseconds).toISOString()
    : "unknown";
  if (status === 429 || remaining === "0" || (status === 403 && retryAfter)) {
    return new CatalogBuildError(
      "rate-limit-exhausted",
      `GitHub API rate limit exhausted (status ${status}, limit ${limit}, remaining ${remaining}, reset ${reset || "unknown"}, resetAt ${resetDate}${retryAfter ? `, retryAfter ${retryAfter}s` : ""})`,
    );
  }
  if (status === 401 || status === 403) {
    return new CatalogBuildError(
      "github-api-forbidden",
      `GitHub API access was forbidden (status ${status}, limit ${limit}, remaining ${remaining}, reset ${reset || "unknown"}, resetAt ${resetDate})`,
    );
  }
  return null;
}

async function githubApi(path, { optional = false } = {}) {
  const response = await fetchWithTimeout(`https://api.github.com${path}`, {
    headers: githubHeaders(),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) {
    const fatal = githubApiFailure(response);
    if (fatal) throw fatal;
    throw new CatalogCheckError(
      "repository-unreachable",
      `GitHub API ${response.status}`,
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
    headers: githubHeaders(),
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
    if (field === "id" && manifest[field] !== normalized) {
      checkError("manifest-invalid", `${manifestPath}: manifest field "id" must not contain leading or trailing whitespace`);
    }
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
  if (
    manifest.barWidget
    && typeof manifest.barWidget === "object"
    && !Array.isArray(manifest.barWidget)
    && Object.hasOwn(manifest.barWidget, "defaultSection")
    && (
      typeof manifest.barWidget.defaultSection !== "string"
      || !["left", "center", "right"].includes(manifest.barWidget.defaultSection)
    )
  ) {
    checkError(
      "manifest-invalid",
      `${manifestPath}: "barWidget.defaultSection" must be left, center, or right`,
    );
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

export async function resolveSnapshot(source) {
  const repository = parseGitHubRepository(source.repo);
  const metadata = await githubApi(`/repos/${repository.owner}/${repository.repository}`);
  if (metadata.private || metadata.disabled || metadata.archived) {
    checkError("repository-unreachable", `${repository.slug} must be public, active, and unarchived`);
  }
  const branch = source.branch || metadata.default_branch;
  const requestedCommit = source.snapshotCommit;
  if (requestedCommit !== undefined && !/^[a-f0-9]{40}$/i.test(requestedCommit)) {
    checkError("repository-unreachable", `${repository.slug}: snapshotCommit must be a full commit SHA`);
  }
  const commitRef = requestedCommit || branch;
  const commit = await githubApi(
    `/repos/${repository.owner}/${repository.repository}/commits/${encodeURIComponent(commitRef)}`,
  );
  const commitSha = commit.sha;
  const treeSha = commit.commit?.tree?.sha;
  if (!/^[a-f0-9]{40}$/i.test(commitSha || "") || !/^[a-f0-9]{40}$/i.test(treeSha || "")) {
    checkError("repository-unreachable", `${repository.slug}: GitHub returned an invalid snapshot`);
  }
  if (requestedCommit && commitSha.toLowerCase() !== requestedCommit.toLowerCase()) {
    checkError("repository-unreachable", `${repository.slug}: GitHub resolved a different snapshot commit`);
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

function normalizedReleaseTag(value) {
  if (
    typeof value !== "string"
    || !value
    || value.length > 256
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || /[\ud800-\udfff]/u.test(value)
    || /[\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(value)
  ) return null;
  return value;
}

function normalizedReleaseTimestamp(value) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) return null;
  const canonicalTimestamp = new Date(value).toISOString();
  return value === canonicalTimestamp || value === canonicalTimestamp.replace(".000Z", "Z")
    ? value
    : null;
}

function normalizedRepositoryRelease(repository, tagValue, path, publishedAt) {
  const tag = normalizedReleaseTag(tagValue);
  if (!tag || !["releases/tag", "tree"].includes(path)) return null;
  const release = {
    tag,
    url: `https://github.com/${repository.slug}/${path}/${encodeURIComponent(tag)}`,
  };
  const timestamp = normalizedReleaseTimestamp(publishedAt);
  if (timestamp) release.publishedAt = timestamp;
  return release;
}

async function optionalRepositoryRelease(context, fallback) {
  try {
    const release = await githubApi(
      `/repos/${context.repository.owner}/${context.repository.repository}/releases/latest`,
      { optional: true },
    );
    if (release?.tag_name && !release.draft) {
      const normalized = normalizedRepositoryRelease(
        context.repository,
        release.tag_name,
        "releases/tag",
        release.published_at || release.created_at,
      );
      if (normalized) return normalized;
    }
    const tags = await githubApi(
      `/repos/${context.repository.owner}/${context.repository.repository}/tags?per_page=1`,
    );
    if (!tags[0]?.name) return null;
    return normalizedRepositoryRelease(context.repository, tags[0].name, "tree");
  } catch (error) {
    assertRecoverableCatalogError(error);
    return fallback;
  }
}

function preservedRepositoryRelease(source, previousPlugins) {
  const release = previousPlugins.find((plugin) => (
    plugin.repo === source.repo && plugin.repositoryRelease
  ))?.repositoryRelease;
  if (!release || typeof release !== "object" || Array.isArray(release)) return undefined;

  const repository = parseGitHubRepository(source.repo);
  for (const path of ["releases/tag", "tree"]) {
    const normalized = normalizedRepositoryRelease(
      repository,
      release.tag,
      path,
      release.publishedAt,
    );
    if (normalized?.url === release.url) return normalized;
  }
  return undefined;
}

export async function repositoryReleaseForRefresh(
  context,
  source,
  previousPlugins,
  incremental,
) {
  const preserved = preservedRepositoryRelease(source, previousPlugins);
  if (incremental) return optionalRepositoryRelease(context, preserved);
  // Keep the authenticated API budget for exact snapshot checks during full refreshes.
  return preserved;
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

export const readmeSanitizeOptions = Object.freeze({
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ["src", "alt", "width", "height"],
    a: ["href", "name", "target", "rel", "title"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https"] },
  transformTags: {
    a: (_tagName, attribs) => ({
      tagName: "a",
      attribs: { ...attribs, target: "_blank", rel: "noreferrer" },
    }),
  },
});

function resolveReadmeUrl(value, baseUrl) {
  if (!value || !baseUrl) return value;
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) {
    const u = new URL(baseUrl);
    return `${u.origin}${value}`;
  }
  return `${baseUrl}/${value}`;
}

export function renderReadmeHtml(markdown, baseUrl = "") {
  const raw = marked.parse(String(markdown || ""), { async: false });
  const html = sanitizeHtml(raw, {
    ...readmeSanitizeOptions,
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: { ...attribs, href: resolveReadmeUrl(attribs.href, baseUrl), target: "_blank", rel: "noreferrer" },
      }),
      img: (_tagName, attribs) => ({
        tagName: "img",
        attribs: { ...attribs, src: resolveReadmeUrl(attribs.src, baseUrl) },
      }),
    },
  });
  if (html.length > readmeRenderedLimit) {
    return html.slice(0, readmeRenderedLimit);
  }
  return html;
}

function readmePathFor(context) {
  const rootFiles = context.tree.filter((entry) => !entry.path.includes("/") && isBlob(entry));
  const readme = rootFiles.find((entry) => /^readme(?:\.[^/]+)?$/i.test(entry.path));
  return readme?.path || null;
}

async function loadSnapshotReadme(source, context) {
  if (source.type === "builtin" || context.repositoryLayout === "suite") return null;
  const path = readmePathFor(context);
  if (!path) return null;
  const entry = treeEntry(context, path);
  if (!isBlob(entry) || !Number.isFinite(entry.size) || entry.size < 1 || entry.size > readmeByteLimit) {
    return null;
  }
  const buffer = await readSnapshotBuffer(
    context.repository,
    path,
    context.commitSha,
    readmeByteLimit,
    "manifest-invalid",
  );
  const readmeBaseUrl = rawUrl(context.repository, context.commitSha, "").replace(/\/$/, "");
  const html = renderReadmeHtml(buffer.toString("utf8"), readmeBaseUrl);
  if (!html.trim()) return null;
  const fileBase = previewFileBase(context.repository);
  const fileName = `${fileBase}.html`;
  return { fileName, html };
}

async function stageSnapshotReadme(snapshot, stageDirectory) {
  if (!snapshot) return;
  await writeFile(resolve(stageDirectory, snapshot.fileName), snapshot.html);
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

export function communityInstall(source, manifestPath, overrides = {}) {
  const installation = overrides.installation;
  if (installation !== undefined) {
    if (
      manifestPath !== "manifest.json"
      || !installation
      || typeof installation !== "object"
      || Array.isArray(installation)
      || installation.mode !== "manual"
      || typeof installation.note !== "string"
      || !installation.note.trim()
      || Object.keys(installation).some((field) => !["mode", "note"].includes(field))
    ) {
      throw new Error(`${source.repo}: invalid manual installation override`);
    }
    return {
      repositoryLayout: "root-plugin",
      installAvailable: false,
      installCommand: "",
      installNote: installation.note,
    };
  }
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
  const next = {
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
  return projectPluginVerification(next, source);
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
    ...catalogVerificationFields(source),
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
      ...catalogVerificationFields(source),
      manifestPath,
      addedAt,
      listedAt: listingTimestamp(
        overrides.listedAt || source.listedAt,
        addedAt,
        `${context.repository.slug}/${manifest.id}`,
      ),
      ...communityInstall(source, manifestPath, overrides),
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
  const repositoryRelease = preservedRepositoryRelease(source, previous);
  return previous.map((plugin) => {
    const rootInstall = plugin.repositoryLayout === "root-plugin"
      ? communityInstall(
          source,
          plugin.manifestPath || "manifest.json",
          source.plugins?.[plugin.id] || {},
        )
      : null;
    const next = {
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
      ...(rootInstall || {}),
      installAvailable: Boolean(unreachable && rootInstall?.installAvailable),
      installCommand: unreachable && rootInstall ? rootInstall.installCommand : "",
      status: unreachable ? "Status unknown" : "Compatibility failed",
    };
    if (repositoryRelease) next.repositoryRelease = repositoryRelease;
    else delete next.repositoryRelease;
    return projectPluginVerification(next, source);
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
      tags: [...kinds, ...(builtInTaxonomyTags[manifest.id] || [])],
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

async function inspectPluginManifests(context, { submission = false } = {}) {
  const manifestPaths = context.tree
    .filter((entry) => isBlob(entry) && /^(?:[^/]+\/)?manifest\.json$/i.test(entry.path))
    .map((entry) => entry.path)
    .sort();
  if (submission && (manifestPaths.length !== 1 || manifestPaths[0] !== "manifest.json")) {
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
      entryPoints: Object.values(manifest.entryPoints),
    });
  }
  if (!manifests.length) checkError("manifest-invalid", "No valid plugin manifests found");
  return manifests;
}

export async function inspectSubmission(repoUrl) {
  const source = { repo: repoUrl };
  const context = await resolveSnapshot(source);
  validateRepositoryDocs(context);
  const manifests = await inspectPluginManifests(context, { submission: true });
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

export async function inspectListedPluginSource(source) {
  if (source?.type !== "plugin-source") {
    checkError("unsupported-repository-layout", "Plugin updates require a plugin-source listing");
  }
  const context = await resolveSnapshot({
    ...source,
    branch: undefined,
    listingValidatedBranch: undefined,
  });
  const manifests = await inspectPluginManifests(context);
  return {
    repository: context.repository.slug,
    defaultBranch: context.branch,
    commitSha: context.commitSha,
    treeSha: context.treeSha,
    description: context.metadata.description || "",
    license: "repository-file",
    preview: false,
    manifests,
  };
}

async function seedPreviewStage(stageDirectory, sourceDirectory = previewDirectory) {
  await mkdir(stageDirectory, { recursive: true });
  try {
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
      if (entry.isFile()) {
        await copyFile(resolve(sourceDirectory, entry.name), resolve(stageDirectory, entry.name));
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

async function pruneReadmeStage(stageDirectory, plugins) {
  const referenced = new Set();
  for (const plugin of plugins) {
    const value = plugin.readmeHtml;
    if (typeof value === "string" && value.startsWith("assets/readme/")) {
      referenced.add(value.slice("assets/readme/".length));
    }
  }
  for (const existing of await readdir(stageDirectory)) {
    if (!referenced.has(existing)) await unlink(resolve(stageDirectory, existing));
  }
}

async function commitGeneratedFiles(stageDirectory, serializedCatalog, options = {}) {
  const targetCatalogPath = options.catalogPath || catalogPath;
  const targetPreviewDirectory = options.previewDirectory || previewDirectory;
  const targetReadmeDirectory = options.readmeDirectory || readmeDirectory;
  const catalogTemp = `${targetCatalogPath}.tmp-${process.pid}`;
  const previewBackup = `${targetPreviewDirectory}.backup-${process.pid}`;
  const readmeBackup = `${targetReadmeDirectory}.backup-${process.pid}`;
  await writeFile(catalogTemp, serializedCatalog);
  let movedPreview = false;
  let movedReadme = false;
  try {
    await rm(previewBackup, { recursive: true, force: true });
    await rm(readmeBackup, { recursive: true, force: true });
    try {
      await rename(targetPreviewDirectory, previewBackup);
      movedPreview = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(targetReadmeDirectory, readmeBackup);
      movedReadme = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(stageDirectory, targetPreviewDirectory);
    if (options.readmeStageDirectory) {
      await rename(options.readmeStageDirectory, targetReadmeDirectory);
    }
    await rename(catalogTemp, targetCatalogPath);
    await rm(previewBackup, { recursive: true, force: true });
    await rm(readmeBackup, { recursive: true, force: true });
  } catch (error) {
    await rm(catalogTemp, { force: true });
    await rm(targetPreviewDirectory, { recursive: true, force: true });
    await rm(targetReadmeDirectory, { recursive: true, force: true });
    if (movedPreview) await rename(previewBackup, targetPreviewDirectory);
    if (movedReadme) await rename(readmeBackup, targetReadmeDirectory);
    throw error;
  }
}

export function catalogSourcePlan(registry, approvedRepository = "") {
  const sources = registry.sources || [];
  if (!approvedRepository) {
    return { incremental: false, approvedSource: null, refreshSources: sources };
  }
  const approvedRepositoryKey = approvedRepository.toLowerCase();
  const approvedSource = sources.find((source) => (
    parseGitHubRepository(source.repo).slug.toLowerCase() === approvedRepositoryKey
  ));
  if (!approvedSource) {
    throw new Error(`Approved repository ${approvedRepository} is not registered`);
  }
  return { incremental: true, approvedSource, refreshSources: [approvedSource] };
}

export async function buildCatalog(options = {}) {
  const activeRegistryPath = options.registryPath || registryPath;
  const activeCatalogPath = options.catalogPath || catalogPath;
  const activePreviewDirectory = options.previewDirectory || previewDirectory;
  const activePreviewParent = dirname(activePreviewDirectory);
  const registry = JSON.parse(await readFile(activeRegistryPath, "utf8"));
  const approvedRepository = options.approvedRepository
    ?? process.env.MARKETPLACE_APPROVED_REPOSITORY
    ?? "";
  const approvedCommit = options.approvedCommit
    ?? process.env.MARKETPLACE_APPROVED_COMMIT
    ?? "";
  if (Boolean(approvedRepository) !== Boolean(approvedCommit)) {
    throw new Error("Approved repository and commit must be supplied together");
  }
  if (approvedCommit && !/^[a-f0-9]{40}$/i.test(approvedCommit)) {
    throw new Error("Approved commit must be a full commit SHA");
  }
  let approvedSnapshotUsed = false;
  const sourcePlan = catalogSourcePlan(registry, approvedRepository);
  const refreshSourceRepositories = new Set(sourcePlan.refreshSources.map((source) => source.repo));
  const previous = JSON.parse(await readFile(activeCatalogPath, "utf8"));
  const previousPlugins = previous.plugins || [];
  const previousById = new Map(previousPlugins.map((plugin) => [plugin.id, plugin]));
  const plugins = [];
  const warnings = sourcePlan.approvedSource
    ? (previous.warnings || []).filter((warning) => !warning.startsWith(`${sourcePlan.approvedSource.repo}:`))
    : [];
  const checkedAt = new Date().toISOString();
  await mkdir(activePreviewParent, { recursive: true });
  const stageDirectory = await mkdtemp(resolve(activePreviewParent, ".plugins-stage-"));
  await seedPreviewStage(stageDirectory, activePreviewDirectory);
  const activeReadmeDirectory = options.readmeDirectory || readmeDirectory;
  const activeReadmeParent = dirname(activeReadmeDirectory);
  await mkdir(activeReadmeParent, { recursive: true });
  const readmeStageDirectory = await mkdtemp(resolve(activeReadmeParent, ".readme-stage-"));
  await seedPreviewStage(readmeStageDirectory, activeReadmeDirectory);

  try {
    for (const source of registry.sources || []) {
      const pinThisSource = sourcePlan.incremental && refreshSourceRepositories.has(source.repo);
      if (sourcePlan.incremental && !pinThisSource) {
        const preserved = previousPlugins.filter((plugin) => (
          !plugin.builtIn
          && !plugin.placeholder
          && plugin.repo === source.repo
        ));
        if (!preserved.length) {
          throw new Error(`${source.repo}: incremental build has no previous catalog state`);
        }
        plugins.push(...preserved);
        continue;
      }
      let context;
      try {
        const contextSource = pinThisSource
          ? { ...source, snapshotCommit: approvedCommit }
          : source;
        context = await resolveSnapshot(contextSource);
        if (pinThisSource) {
          if (
            source.listingValidatedCommit !== approvedCommit
            || source.automatedSecurityBaseline?.commit !== approvedCommit
            || context.commitSha.toLowerCase() !== approvedCommit.toLowerCase()
          ) {
            throw new Error(`${source.repo}: approved snapshot commit mismatch`);
          }
        }
        context.repositoryRelease = await repositoryReleaseForRefresh(
          context,
          source,
          previousPlugins,
          sourcePlan.incremental,
        );
        validateRepositoryDocs(context);
        let readmeHtmlPath = "";
        try {
          const readmeSnapshot = await loadSnapshotReadme(source, context);
          if (readmeSnapshot) {
            await stageSnapshotReadme(readmeSnapshot, readmeStageDirectory);
            readmeHtmlPath = `assets/readme/${readmeSnapshot.fileName}`;
          }
        } catch (readmeError) {
          if (readmeError instanceof CatalogCheckError) {
            console.error(`${source.repo}: readme fetch skipped (${readmeError.code})`);
          } else {
            console.error(`${source.repo}: readme fetch failed`);
          }
        }
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
          { ...plugin, ...(readmeHtmlPath ? { readmeHtml: readmeHtmlPath } : {}) },
          source,
          context,
          previousById.get(plugin.id),
          checkedAt,
        )));
        if (pinThisSource) approvedSnapshotUsed = true;
      } catch (error) {
        if (pinThisSource) throw error;
        assertRecoverableCatalogError(error);
        const preserved = failedSourcePlugins(source, previousPlugins, context, checkedAt, error);
        plugins.push(...preserved);
        const code = catalogErrorCode(error);
        warnings.push(`${source.repo}: ${code}`);
        console.error(catalogRefreshFailureMessage(source.repo, error));
      }
    }

    if (approvedRepository && !approvedSnapshotUsed) {
      throw new Error(`Approved repository ${approvedRepository} was not built`);
    }

    if (sourcePlan.incremental) {
      const preservedBuiltIns = previousPlugins.filter((plugin) => plugin.builtIn);
      if ((registry.builtInSources || []).length && !preservedBuiltIns.length) {
        throw new Error("Incremental build has no previous built-in catalog state");
      }
      plugins.push(...preservedBuiltIns);
    } else {
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
          console.error(catalogRefreshFailureMessage(source.repo, error, { builtIn: true }));
        }
      }
    }

    for (const placeholder of registry.placeholders || []) {
      plugins.push({
        ...placeholder,
        sourceType: "community",
        placeholder: true,
        verificationStatus: "unverified",
      });
      const warning = `${placeholder.name} is intentionally displayed as a placeholder.`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }

    if (new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length) {
      throw new Error("Catalog contains duplicate plugin IDs");
    }
    await prunePreviewStage(stageDirectory, plugins);
    await pruneReadmeStage(readmeStageDirectory, plugins);
    const projectedCatalog = projectCatalogVerification(registry, { plugins });
    const nextContent = {
      stateSchemaVersion: 2,
      mode: "production",
      plugins: projectedCatalog.plugins,
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
    await commitGeneratedFiles(stageDirectory, serialized, {
      catalogPath: activeCatalogPath,
      previewDirectory: activePreviewDirectory,
      readmeDirectory: activeReadmeDirectory,
      readmeStageDirectory,
    });
    console.log(
      `${changed ? "Updated" : "Validated"} ${plugins.length} plugins from ${
        (registry.sources || []).length + (registry.builtInSources || []).length
      } registered sources (${approvedRepository ? "1 source refreshed" : "full refresh"}).`,
    );
  } catch (error) {
    await rm(stageDirectory, { recursive: true, force: true });
    await rm(readmeStageDirectory, { recursive: true, force: true });
    throw error;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  buildCatalog().catch((error) => {
    console.error(`Catalog build failed [${catalogErrorCode(error, "internal-error")}].`);
    if (error instanceof CatalogBuildError) console.error(error.publicMessage);
    process.exitCode = 1;
  });
}
