#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ogExtension, renderPageOg, renderPluginOg } from "./og-render.mjs";
import { ogAssetPrefix, pluginPageHtml, pluginPathPrefix, validPluginPathId } from "./og-pages.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const siteDirectory = join(root, "site");
const catalogPath = join(siteDirectory, "catalog.json");
const shellPath = join(siteDirectory, "plugin.html");
const ogDirectory = join(siteDirectory, ...ogAssetPrefix.split("/"));
const pluginOgDirectory = join(ogDirectory, pluginPathPrefix);
const pluginPageDirectory = join(siteDirectory, pluginPathPrefix);

// Static pages keep their own social preview so every entry point shares one visual system.
export const staticPageOg = [
  {
    file: "index",
    eyebrow: "Community registry",
    title: "discover omarchy plugins",
    description: "Browse community-built plugins for Omarchy Quattro. Inspect the source, copy the command, and shape your shell around the way you work.",
    footnote: "omarchy plugin add <repository>",
  },
  {
    file: "explore",
    eyebrow: "Community registry",
    title: "explore community plugins",
    description: "Semantic communities, shared authors, and catalog growth across the Omarchy plugin marketplace.",
    footnote: "omarchyplugins.com/explore.html",
  },
  {
    file: "develop",
    eyebrow: "Development",
    title: "develop a custom plugin",
    description: "Build, test, and package a custom Omarchy Quattro plugin locally before publishing it to the marketplace.",
    footnote: "omarchy plugin dev link ./my-plugin",
  },
  {
    file: "publish",
    eyebrow: "Publishing",
    title: "publish your plugin",
    description: "Submit a public plugin repository to the community marketplace and follow the automated validation flow.",
    footnote: "omarchyplugins.com/publish.html",
  },
  {
    file: "plugin",
    eyebrow: "Community registry",
    title: "omarchy plugin details",
    description: "Inspect the source, verification state, and installation command for a community plugin.",
    footnote: "omarchy plugin add <repository>",
  },
];

async function inParallel(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function readPreview(plugin) {
  const path = String(plugin.previewImage || "").trim();
  if (!/^assets\/img\/plugins\/[a-z0-9._-]+\.webp$/iu.test(path)) return null;
  try {
    return await readFile(join(siteDirectory, ...path.split("/")));
  } catch {
    return null;
  }
}

export async function buildOg({ concurrency = 8, log = console.log } = {}) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!Array.isArray(catalog.plugins)) throw new Error("site/catalog.json has no plugin list");
  const shell = await readFile(shellPath, "utf8");

  await rm(ogDirectory, { recursive: true, force: true });
  await rm(pluginPageDirectory, { recursive: true, force: true });
  await mkdir(pluginOgDirectory, { recursive: true });

  await inParallel(staticPageOg, concurrency, async (page) => {
    await writeFile(join(ogDirectory, `${page.file}${ogExtension}`), await renderPageOg(page));
  });

  const plugins = catalog.plugins.filter((plugin) => validPluginPathId(plugin?.id));
  const skipped = catalog.plugins.length - plugins.length;
  if (skipped > 0) throw new Error(`${skipped} catalog plugins have an id that cannot become a static path`);

  let previews = 0;
  await inParallel(plugins, concurrency, async (plugin) => {
    const preview = await readPreview(plugin);
    if (preview) previews += 1;
    const image = await renderPluginOg(plugin, preview);
    await writeFile(join(pluginOgDirectory, `${plugin.id}${ogExtension}`), image);
    const pageDirectory = join(pluginPageDirectory, plugin.id);
    await mkdir(pageDirectory, { recursive: true });
    await writeFile(join(pageDirectory, "index.html"), pluginPageHtml(shell, plugin));
  });

  log(
    `Generated ${plugins.length} plugin social previews (${previews} from upstream screenshots), `
    + `${plugins.length} plugin pages, and ${staticPageOg.length} static page previews.`,
  );
  return { plugins: plugins.length, previews, pages: staticPageOg.length };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  await buildOg();
}
