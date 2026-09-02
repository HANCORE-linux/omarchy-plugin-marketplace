import { ogExtension, ogHeight, ogType, ogWidth } from "./og-render.mjs";

export const siteOrigin = "https://plugins.omarchy.org";
export const pluginPathPrefix = "p";
export const ogAssetPrefix = "assets/og";

const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function validPluginPathId(value) {
  const id = String(value ?? "");
  return pluginIdPattern.test(id) && id !== "." && id !== "..";
}

export function escapeAttribute(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export function metaDescription(plugin) {
  const description = String(plugin?.description || "").replace(/\s+/gu, " ").trim();
  const fallback = `${plugin?.name || "This plugin"} is a community plugin listed on the Omarchy plugin marketplace.`;
  const text = description || fallback;
  return text.length > 180 ? `${text.slice(0, 179).replace(/[\s.,;:-]+$/u, "")}…` : text;
}

export function pluginPageUrl(id) {
  return `${siteOrigin}/${pluginPathPrefix}/${id}/`;
}

export function pluginOgImageUrl(id) {
  return `${siteOrigin}/${ogAssetPrefix}/${pluginPathPrefix}/${id}${ogExtension}`;
}

/**
 * Rewrites the document-relative URLs of the shared plugin shell so the same
 * markup works from `/p/<id>/`. Absolute, protocol-relative, and fragment
 * references are left untouched.
 */
export function rebaseDocumentUrls(html, prefix) {
  return html.replace(/(\s(?:href|src)=")([^"]*)"/gu, (match, lead, value) => (
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|$)/iu.test(value) ? match : `${lead}${prefix}${value}"`
  ));
}

function structuredData(plugin) {
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: plugin.name,
    description: metaDescription(plugin),
    url: pluginPageUrl(plugin.id),
    image: pluginOgImageUrl(plugin.id),
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Linux",
    isAccessibleForFree: true,
    ...(plugin.author ? { author: { "@type": "Person", name: plugin.author } } : {}),
    ...(plugin.version ? { softwareVersion: plugin.version } : {}),
    ...(plugin.repo ? { codeRepository: plugin.repo } : {}),
  };
  // Escaping "<" keeps a plugin field from terminating the script element.
  return JSON.stringify(data).replace(/</gu, "\\u003c");
}

export function pluginHeadMarkup(plugin) {
  const title = `${plugin.name} | Omarchy Plugins`;
  const description = metaDescription(plugin);
  const url = pluginPageUrl(plugin.id);
  const image = pluginOgImageUrl(plugin.id);
  const socialTitle = `${plugin.name} — Omarchy plugin`;
  return `<link rel="canonical" href="${escapeAttribute(url)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Omarchy Plugins">
    <meta property="og:url" content="${escapeAttribute(url)}">
    <meta property="og:title" content="${escapeAttribute(socialTitle)}">
    <meta property="og:description" content="${escapeAttribute(description)}">
    <meta property="og:image" content="${escapeAttribute(image)}">
    <meta property="og:image:type" content="${ogType}">
    <meta property="og:image:width" content="${ogWidth}">
    <meta property="og:image:height" content="${ogHeight}">
    <meta property="og:image:alt" content="${escapeAttribute(`${plugin.name} on the Omarchy plugin marketplace`)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeAttribute(socialTitle)}">
    <meta name="twitter:description" content="${escapeAttribute(description)}">
    <meta name="twitter:image" content="${escapeAttribute(image)}">
    <script type="application/ld+json">${structuredData(plugin)}</script>
    <title>${escapeAttribute(title)}</title>`;
}

/**
 * Removes the shell's default social metadata so a generated page carries exactly
 * one canonical link and one Open Graph set.
 */
export function stripSocialMetadata(html) {
  return html.replace(
    /^[ \t]*(?:<meta (?:property="og:|name="twitter:)[^>]*>|<link rel="canonical"[^>]*>)\n/gmu,
    "",
  );
}

/**
 * Builds the static `/p/<id>/index.html` shell for one plugin from the shared
 * `site/plugin.html` document. Only head metadata differs; the detail body is
 * still hydrated by `assets/js/plugin.js` from the catalog.
 */
export function pluginPageHtml(shell, plugin) {
  if (!validPluginPathId(plugin?.id)) {
    throw new Error(`Unsupported plugin id for a static page: ${plugin?.id}`);
  }
  const rebased = stripSocialMetadata(rebaseDocumentUrls(shell, "../../"));
  const withDescription = rebased.replace(
    /<meta name="description" content="[^"]*">/u,
    `<meta name="description" content="${escapeAttribute(metaDescription(plugin))}">`,
  );
  const html = withDescription.replace(
    /<title>[^<]*<\/title>/u,
    pluginHeadMarkup(plugin),
  );
  if (html === withDescription) throw new Error("Plugin shell is missing its <title> element");
  return html;
}
