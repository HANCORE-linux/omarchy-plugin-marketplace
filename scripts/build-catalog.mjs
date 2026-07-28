import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const registry = JSON.parse(await readFile(resolve(root, "registry.json"), "utf8"));
const catalogPath = resolve(root, "site/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));

const repos = new Set((registry.sources || []).map((source) => source.repo));
const sourceByRepo = new Map((registry.sources || []).map((source) => [source.repo, source]));
const errors = [];
const previewWarnings = [];

function githubRepository(repoUrl) {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com") return null;
    const [owner, repository] = url.pathname.replace(/^\/|\/$/g, "").split("/");
    if (!owner || !repository) return null;
    return { owner, repository: repository.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

async function findRootPreview(repoUrl) {
  const repository = githubRepository(repoUrl);
  if (!repository) return null;

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "omarchy-plugin-marketplace-catalog-builder"
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const endpoint = `https://api.github.com/repos/${repository.owner}/${repository.repository}/contents/preview.png`;
  const response = await fetch(endpoint, { headers });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);

  const file = await response.json();
  return file.type === "file" && file.download_url ? file.download_url : null;
}

for (const plugin of catalog.plugins || []) {
  if (!plugin.id || !plugin.name || !plugin.repo) errors.push(`Invalid catalog entry: ${plugin.id || "unknown"}`);
  if (!plugin.placeholder && !repos.has(plugin.repo)) errors.push(`${plugin.id}: repository is missing from registry`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  const previewByRepo = new Map();

  for (const repo of repos) {
    try {
      previewByRepo.set(repo, await findRootPreview(repo));
    } catch (error) {
      previewWarnings.push(`Preview scan failed for ${repo}: ${error.message}`);
    }
  }

  for (const plugin of catalog.plugins || []) {
    const source = sourceByRepo.get(plugin.repo);
    if (plugin.placeholder || (!source?.previewImage && !previewByRepo.has(plugin.repo))) continue;
    const previewImage = source?.previewImage || previewByRepo.get(plugin.repo);
    if (previewImage) {
      plugin.previewImage = previewImage;
      plugin.previewSource = source?.previewImage ? "registry" : "repository-root";
      if (source?.previewWidth) plugin.previewWidth = source.previewWidth;
      else delete plugin.previewWidth;
      if (source?.previewHeight) plugin.previewHeight = source.previewHeight;
      else delete plugin.previewHeight;
    } else if (plugin.previewSource === "repository-root" || plugin.previewSource === "registry") {
      delete plugin.previewImage;
      delete plugin.previewSource;
      delete plugin.previewWidth;
      delete plugin.previewHeight;
    }
  }

  catalog.warnings = [
    ...(catalog.warnings || []).filter((warning) => !warning.startsWith("Preview scan failed for ")),
    ...previewWarnings
  ];
  catalog.generatedAt = new Date().toISOString();
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  const previews = [...previewByRepo.values()].filter(Boolean).length;
  console.log(`Validated ${catalog.plugins.length} plugins from ${repos.size} registered sources; found ${previews} root preview image(s).`);
}
