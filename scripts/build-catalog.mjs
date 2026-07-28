import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile
} from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const registryPath = resolve(root, "registry.json");
const catalogPath = resolve(root, "site/catalog.json");
const previewDirectory = resolve(root, "site/assets/img/plugins");
const previewLimit = 10 * 1024 * 1024;
const accents = ["lime", "amber", "coral", "cyan", "violet", "rose"];

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "omarchy-plugin-marketplace-catalog-builder",
    "X-GitHub-Api-Version": "2026-03-10"
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
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
    slug: `${parts[0]}/${parts[1].replace(/\.git$/, "")}`
  };
}

async function githubApi(path, { optional = false } = {}) {
  const response = await fetch(`https://api.github.com${path}`, { headers: githubHeaders() });
  if (optional && response.status === 404) return null;
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    throw new Error(`GitHub API ${response.status} for ${path}${remaining === "0" ? " (rate limit exhausted)" : ""}`);
  }
  return response.json();
}

async function readGitHubFile(repository, path, branch) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `https://raw.githubusercontent.com/${repository.owner}/${repository.repository}/${encodeURIComponent(branch)}/${encodedPath}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "omarchy-plugin-marketplace-catalog-builder" }
  });
  if (!response.ok) throw new Error(`Raw file download returned ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 1024 * 1024) throw new Error("Manifest exceeds the 1 MB validation limit");
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Manifest exceeds the 1 MB validation limit");
  return text;
}

export function validateManifest(manifest, manifestPath) {
  if (manifest.schemaVersion !== 1) {
    throw new Error(`${manifestPath}: manifest field "schemaVersion" must be exactly 1`);
  }
  const required = ["id", "name", "version", "author", "description"];
  for (const field of required) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      throw new Error(`${manifestPath}: manifest field "${field}" is required`);
    }
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id)) {
    throw new Error(`${manifestPath}: manifest id contains unsupported characters`);
  }
  if (!Array.isArray(manifest.kinds) || manifest.kinds.length === 0 || manifest.kinds.some((kind) => typeof kind !== "string" || !kind.trim())) {
    throw new Error(`${manifestPath}: manifest "kinds" must be a non-empty array of strings`);
  }
  if (!manifest.entryPoints || typeof manifest.entryPoints !== "object" || Array.isArray(manifest.entryPoints)) {
    throw new Error(`${manifestPath}: manifest "entryPoints" must be an object`);
  }
  const entryPoints = Object.values(manifest.entryPoints);
  if (entryPoints.length === 0 || entryPoints.some((entryPoint) => (
    typeof entryPoint !== "string" ||
    !entryPoint.trim() ||
    entryPoint.startsWith("/") ||
    entryPoint.includes("..")
  ))) {
    throw new Error(`${manifestPath}: manifest entry points must be safe relative paths`);
  }
  return manifest;
}

function looksLikePluginManifest(manifest) {
  return manifest && (
    Object.hasOwn(manifest, "schemaVersion") ||
    Object.hasOwn(manifest, "id")
  );
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
  const allowed = ["category", "tags", "accent", "initials", "kind", "status"];
  return Object.fromEntries(allowed.filter((field) => overrides[field] !== undefined).map((field) => [field, overrides[field]]));
}

function previewExtension(url) {
  const extension = extname(new URL(url).pathname).toLowerCase();
  if ([".png", ".webp", ".jpg", ".jpeg"].includes(extension)) return extension;
  throw new Error(`Unsupported preview image extension: ${extension || "none"}`);
}

function pngDimensions(buffer) {
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return {};
}

async function cachedPreview(repository, url, configuredDimensions = {}) {
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "raw.githubusercontent.com") {
    throw new Error(`Preview URLs must use raw.githubusercontent.com: ${url}`);
  }

  const extension = previewExtension(url);
  const fileBase = `${repository.owner.toLowerCase()}-${repository.repository.toLowerCase()}`;
  const fileName = `${fileBase}${extension}`;
  const target = resolve(previewDirectory, fileName);
  const response = await fetch(url, {
    headers: { "User-Agent": "omarchy-plugin-marketplace-catalog-builder" }
  });
  if (!response.ok) throw new Error(`Preview download returned ${response.status}: ${url}`);

  const contentType = response.headers.get("content-type") || "";
  if (!/^image\/(png|webp|jpeg)$/i.test(contentType)) {
    throw new Error(`Preview has unsupported content type "${contentType}": ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > previewLimit) {
    throw new Error(`Preview must be between 1 byte and ${previewLimit} bytes: ${url}`);
  }

  await mkdir(previewDirectory, { recursive: true });
  await writeFile(target, buffer);

  for (const existing of await readdir(previewDirectory)) {
    if (existing.startsWith(`${fileBase}.`) && existing !== fileName) {
      await unlink(resolve(previewDirectory, existing));
    }
  }

  const dimensions = extension === ".png" ? pngDimensions(buffer) : {};
  return {
    previewImage: `assets/img/plugins/${fileName}`,
    previewWidth: configuredDimensions.previewWidth || dimensions.width,
    previewHeight: configuredDimensions.previewHeight || dimensions.height
  };
}

async function findRootPreview(repository, branch) {
  const file = await githubApi(
    `/repos/${repository.owner}/${repository.repository}/contents/preview.png?ref=${encodeURIComponent(branch)}`,
    { optional: true }
  );
  return file?.type === "file" ? file.download_url : null;
}

async function sourceContext(source) {
  const repository = parseGitHubRepository(source.repo);
  const metadata = await githubApi(`/repos/${repository.owner}/${repository.repository}`);
  if (metadata.private || metadata.disabled || metadata.archived) {
    throw new Error(`${repository.slug} must be public, active, and unarchived`);
  }

  const tree = await githubApi(
    `/repos/${repository.owner}/${repository.repository}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`
  );
  if (tree.truncated) throw new Error(`${repository.slug}: Git tree is too large to scan safely`);

  const previewUrl = source.previewImage || await findRootPreview(repository, metadata.default_branch);
  const preview = await cachedPreview(repository, previewUrl, source);
  return { repository, metadata, tree: tree.tree || [], preview };
}

function repositoryMetadata(metadata) {
  return {
    license: metadata.license?.spdx_id && metadata.license.spdx_id !== "NOASSERTION"
      ? metadata.license.spdx_id
      : "Unknown",
    stars: metadata.stargazers_count || 0,
    updatedAt: metadata.pushed_at || metadata.updated_at
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

function suitePlugin(source, context) {
  if (!source.catalog?.id || !source.catalog?.name) {
    throw new Error(`${context.repository.slug}: suite sources require catalog.id and catalog.name`);
  }
  return {
    ...source.catalog,
    repo: source.repo,
    addedAt: listingDate(source.catalog.addedAt || source.addedAt, context.repository.slug),
    ...repositoryMetadata(context.metadata),
    ...(context.preview || {})
  };
}

async function discoveredPlugins(source, context) {
  const manifestPaths = context.tree
    .filter((entry) => entry.type === "blob" && /^(?:[^/]+\/)?manifest\.json$/i.test(entry.path))
    .map((entry) => entry.path)
    .sort();

  if (!manifestPaths.length) {
    throw new Error(`${context.repository.slug}: no root or top-level plugin manifests found`);
  }

  const configuredOrder = new Map(
    Object.keys(source.plugins || {}).map((id, index) => [id, index])
  );
  const plugins = [];
  const seenIds = new Set();

  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      manifest = JSON.parse(await readGitHubFile(context.repository, manifestPath, context.metadata.default_branch));
    } catch (error) {
      throw new Error(`${context.repository.slug}/${manifestPath}: ${error.message}`);
    }
    if (!looksLikePluginManifest(manifest)) continue;
    validateManifest(manifest, `${context.repository.slug}/${manifestPath}`);
    if (seenIds.has(manifest.id)) throw new Error(`${context.repository.slug}: duplicate plugin id "${manifest.id}"`);
    seenIds.add(manifest.id);

    const kinds = Array.isArray(manifest.kinds) ? manifest.kinds.map(String) : [];
    const overrides = source.plugins?.[manifest.id] || {};
    const sourceId = source.sourceId || context.repository.owner.toLowerCase();
    plugins.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      version: manifest.version,
      repo: source.repo,
      manifestPath,
      addedAt: listingDate(overrides.addedAt || source.addedAt, `${context.repository.slug}/${manifest.id}`),
      installCommand: `omarchy plugin source add ${source.repo} --as ${sourceId}\nomarchy plugin add ${manifest.id} --from ${sourceId} --enable`,
      installNote: `This adds ${sourceId} as a plugin source, then installs and enables ${manifest.name}.`,
      category: categoryFor(kinds),
      tags: kinds.slice(0, 3).map((kind) => kind.toLowerCase()),
      license: manifest.license || repositoryMetadata(context.metadata).license,
      ...repositoryMetadata(context.metadata),
      accent: accentFor(manifest.id),
      initials: initials(manifest.name),
      kind: kindFor(kinds),
      status: "Available",
      ...(context.preview || {}),
      ...registryPresentation(overrides)
    });
  }

  if (!plugins.length) {
    throw new Error(`${context.repository.slug}: no valid plugin manifests found`);
  }

  for (const configuredId of Object.keys(source.plugins || {})) {
    if (!seenIds.has(configuredId)) {
      throw new Error(`${context.repository.slug}: configured plugin "${configuredId}" has no discoverable manifest`);
    }
  }

  return plugins.sort((left, right) => {
    const leftOrder = configuredOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = configuredOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.name.localeCompare(right.name);
  });
}

export async function inspectSubmission(repoUrl) {
  const repository = parseGitHubRepository(repoUrl);
  const metadata = await githubApi(`/repos/${repository.owner}/${repository.repository}`);
  if (metadata.private || metadata.disabled || metadata.archived) {
    throw new Error("Repository must be public, active, and unarchived");
  }

  const treeResponse = await githubApi(
    `/repos/${repository.owner}/${repository.repository}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`
  );
  if (treeResponse.truncated) throw new Error("Repository tree is too large to validate safely");

  const manifestPaths = (treeResponse.tree || [])
    .filter((entry) => entry.type === "blob" && /^(?:[^/]+\/)?manifest\.json$/i.test(entry.path))
    .map((entry) => entry.path)
    .sort();
  if (!manifestPaths.length) throw new Error("No manifest.json found at the repository root or in a top-level plugin directory");

  const manifests = [];
  const ids = new Set();
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readGitHubFile(repository, manifestPath, metadata.default_branch));
    if (!looksLikePluginManifest(manifest)) continue;
    validateManifest(manifest, `${repository.slug}/${manifestPath}`);
    if (ids.has(manifest.id)) throw new Error(`Duplicate plugin id "${manifest.id}"`);
    ids.add(manifest.id);
    manifests.push({ path: manifestPath, id: manifest.id, name: manifest.name, version: manifest.version });
  }
  if (!manifests.length) throw new Error("No valid plugin manifests found");

  const preview = await findRootPreview(repository, metadata.default_branch);
  return {
    repository: repository.slug,
    defaultBranch: metadata.default_branch,
    description: metadata.description || "",
    license: metadata.license?.spdx_id || null,
    preview: Boolean(preview),
    manifests
  };
}

async function buildCatalog() {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const previous = JSON.parse(await readFile(catalogPath, "utf8"));
  const plugins = [];
  const warnings = [];

  for (const source of registry.sources || []) {
    const context = await sourceContext(source);
    if (source.type === "suite") {
      plugins.push(suitePlugin(source, context));
    } else if (source.type === "plugin-source") {
      plugins.push(...await discoveredPlugins(source, context));
    } else {
      throw new Error(`${context.repository.slug}: unsupported source type "${source.type}"`);
    }
  }

  for (const placeholder of registry.placeholders || []) {
    plugins.push({ ...placeholder, placeholder: true });
    warnings.push(`${placeholder.name} is intentionally displayed as a placeholder and is not installable from the marketplace yet.`);
  }

  const ids = plugins.map((plugin) => plugin.id);
  if (new Set(ids).size !== ids.length) throw new Error("Catalog contains duplicate plugin IDs");

  const nextContent = { mode: "production", plugins, warnings };
  const previousContent = {
    mode: previous.mode,
    plugins: previous.plugins,
    warnings: previous.warnings
  };
  const changed = JSON.stringify(nextContent) !== JSON.stringify(previousContent);
  const next = {
    generatedAt: changed ? new Date().toISOString() : previous.generatedAt,
    ...nextContent
  };
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  const previousSerialized = `${JSON.stringify(previous, null, 2)}\n`;

  if (serialized !== previousSerialized) await writeFile(catalogPath, serialized);
  console.log(
    `${changed ? "Updated" : "Validated"} ${plugins.length} plugins from ${(registry.sources || []).length} registered sources.`
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  buildCatalog().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
