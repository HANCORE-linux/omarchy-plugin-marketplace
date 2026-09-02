import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { monoFit, monoWidth, monoWrap, useBundledFonts } from "./og-fonts.mjs";

useBundledFonts();
const { default: sharp } = await import("sharp");

export const ogWidth = 1200;
export const ogHeight = 630;
export const ogType = "image/jpeg";
export const ogExtension = ".jpg";

// Mirrors the dark-theme tokens in site/assets/css/style.css.
const palette = {
  background: "#000000",
  panel: "#0b0b0d",
  preview: "#09090b",
  line: "#28282c",
  codeBackground: "#050507",
  text: "#d7d7d9",
  textStrong: "#f0f0f1",
  muted: "#aaaab0",
  faint: "#7d7d84",
  accent: "#ff5a36",
};

const cardAccents = {
  lime: "#b7ef51",
  violet: "#a78bfa",
  amber: "#f4bd62",
  cyan: "#68d6e8",
  coral: "#f18c75",
  blue: "#74a7f7",
  mint: "#69d4a7",
  rose: "#e896ba",
};

// Control characters are never valid XML and only ever arrive from upstream metadata.
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const siteHost = "plugins.omarchy.org";
const font = "JetBrains Mono";
const previewPixelLimit = 40_000_000;
const headerHeight = 76;
const footerTop = 562;
const accentRule = 4;
const splitX = 660;
const gutter = 56;
const columnWidth = splitX - gutter * 2;
const previewWidth = ogWidth - splitX;
const previewHeight = footerTop - headerHeight;

// The marketplace wordmark is composited as a pre-scaled layer rather than an
// inline SVG image, so librsvg never re-decodes it for all 2000+ previews.
const wordmarkRatio = 656 / 192;
const wordmarkSource = readFileSync(
  fileURLToPath(new URL("../site/assets/img/omarchy-wordmark.png", import.meta.url)),
);
const wordmarkCache = new Map();

function wordmarkWidth(height) {
  return Math.round(height * wordmarkRatio);
}

function wordmarkLayer({ x, y, height, opacity = 1 }) {
  const key = `${height}:${opacity}`;
  if (!wordmarkCache.has(key)) {
    const scaled = sharp(wordmarkSource).resize({ height }).ensureAlpha();
    wordmarkCache.set(key, (opacity === 1 ? scaled : scaled.composite([{
      input: { create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 255, b: 255, alpha: opacity } } },
      tile: true,
      blend: "dest-in",
    }])).raw().toBuffer({ resolveWithObject: true }));
  }
  return { layer: wordmarkCache.get(key), left: Math.round(x), top: Math.round(y) };
}

const headerWordmark = { x: gutter, y: (headerHeight - 22) / 2, height: 22 };
const footerWordmark = {
  x: ogWidth - gutter - wordmarkWidth(15),
  y: (footerTop + ogHeight - accentRule) / 2 - 7.5,
  height: 15,
  opacity: 0.6,
};
const pageWatermark = {
  x: ogWidth - gutter - wordmarkWidth(120),
  y: 418,
  height: 120,
  opacity: 0.1,
};

export function cardAccent(name) {
  return cardAccents[name] || cardAccents.lime;
}

// Reproduces color-mix(in srgb, <accent> <ratio>, <base>) from the stylesheet.
function mix(accent, base, ratio) {
  const channels = [1, 3, 5].map((offset) => {
    const from = Number.parseInt(accent.slice(offset, offset + 2), 16);
    const to = Number.parseInt(base.slice(offset, offset + 2), 16);
    return Math.round(from * ratio + to * (1 - ratio)).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function fitSize(value, maxWidth, sizes) {
  return sizes.find((size) => monoWidth(value, size, -size * 0.04) <= maxWidth) ?? sizes.at(-1);
}

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;")
    .replace(controlCharacters, "");
}

function text(value, { x, y, size, fill, weight = 400, tracking = 0, anchor = "start" }) {
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${font}" font-size="${size}"`
    + ` font-weight="${weight}"${tracking ? ` letter-spacing="${tracking}"` : ""}`
    + `${anchor === "start" ? "" : ` text-anchor="${anchor}"`}>${escapeXml(value)}</text>`;
}

function header() {
  return `
  <rect x="0" y="0" width="${ogWidth}" height="${headerHeight}" fill="${palette.panel}"/>
  <line x1="0" y1="${headerHeight - 0.5}" x2="${ogWidth}" y2="${headerHeight - 0.5}" stroke="${palette.line}"/>
  ${text("PLUGIN MARKETPLACE", {
    x: gutter + wordmarkWidth(headerWordmark.height) + 15,
    y: headerHeight / 2 + 5,
    size: 15,
    fill: palette.text,
    weight: 700,
    tracking: 1.7,
  })}
  ${text(siteHost, { x: ogWidth - gutter, y: headerHeight / 2 + 5, size: 14, fill: palette.faint, anchor: "end" })}`;
}

function footer(command) {
  const size = 15;
  const middle = (footerTop + ogHeight - accentRule) / 2;
  return `
  <rect x="0" y="${footerTop}" width="${ogWidth}" height="${ogHeight - footerTop - accentRule}" fill="${palette.panel}"/>
  <line x1="0" y1="${footerTop + 0.5}" x2="${ogWidth}" y2="${footerTop + 0.5}" stroke="${palette.line}"/>
  ${text("›", { x: gutter, y: middle + 5, size, fill: palette.accent, weight: 700 })}
  ${text(monoFit(command, size, ogWidth - gutter * 2 - 190), { x: gutter + 19, y: middle + 5, size, fill: palette.text })}`;
}

function star(x, y, fill) {
  const points = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 === 0 ? 6.5 : 2.7;
    const angle = (Math.PI / 5) * index - Math.PI / 2;
    points.push(`${(x + radius * Math.cos(angle)).toFixed(2)},${(y + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `<polygon points="${points.join(" ")}" fill="${fill}"/>`;
}

function chips(entries, { x, y, accent }) {
  const size = 13;
  const padding = 11;
  const height = 26;
  let offset = x;
  const parts = [];
  for (const entry of entries) {
    const label = String(entry.label || "").trim();
    if (!label) continue;
    const width = Math.round(monoWidth(label, size, entry.tracking || 0)) + padding * 2;
    if (offset + width > x + columnWidth) break;
    const accented = entry.tone === "accent";
    parts.push(`<rect x="${offset + 0.5}" y="${y + 0.5}" width="${width - 1}" height="${height - 1}" fill="${palette.codeBackground}" stroke="${accented ? accent : palette.line}"/>`);
    parts.push(text(label, {
      x: offset + padding,
      y: y + height / 2 + 4.5,
      size,
      fill: accented ? accent : palette.muted,
      weight: accented ? 700 : 500,
      tracking: entry.tracking || 0,
    }));
    offset += width + 8;
  }
  return parts.join("\n  ");
}

function markPanel(initials, accent) {
  const size = 132;
  const label = String(initials || "?").slice(0, 3).toUpperCase();
  const centerX = splitX + previewWidth / 2;
  const centerY = headerHeight + previewHeight / 2;
  return `
  <rect x="${splitX}" y="${headerHeight}" width="${previewWidth}" height="${previewHeight}" fill="${mix(accent, palette.preview, 0.06)}"/>
  ${text(label, {
    x: centerX - monoWidth(label, size, -size * 0.08) / 2,
    y: centerY + size * 0.36,
    size,
    fill: accent,
    weight: 800,
    tracking: -size * 0.08,
  })}`;
}

function pluginIcon(plugin, accent) {
  const size = 78;
  const x = gutter;
  const y = 166;
  const label = String(plugin.initials || "?").slice(0, 3).toUpperCase();
  const glyph = 25;
  return {
    width: size,
    markup: `
  <rect x="${x + 0.5}" y="${y + 0.5}" width="${size - 1}" height="${size - 1}" fill="${mix(accent, palette.panel, 0.1)}" stroke="${palette.line}"/>
  ${text(label, {
    x: x + size / 2 - monoWidth(label, glyph, -glyph * 0.08) / 2,
    y: y + size / 2 + glyph * 0.36,
    size: glyph,
    fill: accent,
    weight: 800,
    tracking: -glyph * 0.08,
  })}`,
  };
}

function pluginForeground(plugin, accent, { hasPreview }) {
  const icon = pluginIcon(plugin, accent);
  const nameLeft = gutter + icon.width + 22;
  const nameWidth = splitX - gutter - nameLeft;
  const name = String(plugin.name || plugin.id || "plugin").toLowerCase();
  const nameSize = fitSize(name, nameWidth, [52, 46, 40, 34, 28]);
  const nameTracking = -nameSize * 0.04;
  const identity = [plugin.id, plugin.version ? `v${String(plugin.version).replace(/^v/u, "")}` : ""]
    .filter(Boolean)
    .join("  ·  ");
  const stars = Number.isFinite(Number(plugin.stars)) ? Math.max(Math.trunc(Number(plugin.stars)), 0) : 0;
  const byline = monoFit(
    [plugin.author ? `by ${plugin.author}` : "", plugin.kind || ""].filter(Boolean).join("  ·  "),
    17,
    columnWidth - 90,
  );
  const starX = gutter + Math.round(monoWidth(byline, 17)) + 26;
  const description = monoWrap(plugin.description, 17, columnWidth, 3);
  const tags = (Array.isArray(plugin.tags) ? plugin.tags : []).slice(0, 3).map((tag) => ({ label: String(tag) }));
  const badges = [
    ...(plugin.verificationStatus === "verified" ? [{ label: "VERIFIED", tone: "accent", tracking: 1.2 }] : []),
    ...tags,
  ];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ogWidth}" height="${ogHeight}">
  <rect x="0" y="${headerHeight}" width="${splitX}" height="${footerTop - headerHeight}" fill="${palette.background}"/>
  ${hasPreview ? "" : markPanel(plugin.initials, accent)}
  <line x1="${splitX - 0.5}" y1="${headerHeight}" x2="${splitX - 0.5}" y2="${footerTop}" stroke="${palette.line}"/>
  ${header()}
  ${footer(plugin.repo ? String(plugin.repo).replace(/^https?:\/\//u, "") : siteHost)}
  ${text(String(plugin.category || "Plugin").toUpperCase(), { x: gutter, y: 142, size: 14, fill: palette.accent, weight: 700, tracking: 2.4 })}
  ${icon.markup}
  ${text(monoFit(name, nameSize, nameWidth, nameTracking), {
    x: nameLeft,
    y: 205 + nameSize * 0.36,
    size: nameSize,
    fill: palette.textStrong,
    tracking: nameTracking,
  })}
  ${identity ? text(monoFit(identity, 14, columnWidth), { x: gutter, y: 274, size: 14, fill: palette.faint }) : ""}
  <line x1="${gutter}" y1="${298.5}" x2="${gutter + columnWidth}" y2="${298.5}" stroke="${palette.line}"/>
  ${byline ? text(byline, { x: gutter, y: 332, size: 17, fill: accent }) : ""}
  ${stars > 0 ? `${star(starX, 327, palette.faint)}
  ${text(String(stars), { x: starX + 14, y: 332, size: 15, fill: palette.faint, weight: 500 })}` : ""}
  ${description.map((line, index) => text(line, {
    x: gutter,
    y: 376 + index * 30,
    size: 17,
    fill: palette.muted,
  })).join("\n  ")}
  ${chips(badges, { x: gutter, y: 480, accent })}
  <rect x="0" y="${ogHeight - accentRule}" width="${ogWidth}" height="${accentRule}" fill="${accent}"/>
</svg>`;
}

async function resolveLayers(layers) {
  return Promise.all(layers.map(async ({ layer, ...rest }) => {
    if (!layer) return rest;
    const { data, info } = await layer;
    return { ...rest, input: data, raw: { width: info.width, height: info.height, channels: info.channels } };
  }));
}

async function encode(base) {
  return base
    .flatten({ background: palette.background })
    // mozjpeg would shrink these by ~10% but costs 150ms per image across 2000+ previews.
    .jpeg({ quality: 82, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

/**
 * Renders a 1200x630 social preview for one catalog plugin. The plugin's own
 * preview screenshot fills the right panel; plugins without one fall back to the
 * accent mark used by the catalog cards.
 */
export async function renderPluginOg(plugin, previewBuffer = null) {
  const accent = cardAccent(plugin?.accent);
  const layers = [];
  if (previewBuffer) {
    layers.push({
      layer: sharp(previewBuffer, { failOn: "error", limitInputPixels: previewPixelLimit })
        .resize({ width: previewWidth, height: previewHeight, fit: "cover", position: "left top" })
        .raw()
        .toBuffer({ resolveWithObject: true }),
      left: splitX,
      top: headerHeight,
    });
  }
  layers.push({ input: Buffer.from(pluginForeground(plugin, accent, { hasPreview: Boolean(previewBuffer) })) });
  layers.push(wordmarkLayer(headerWordmark), wordmarkLayer(footerWordmark));
  return encode(sharp({
    create: { width: ogWidth, height: ogHeight, channels: 3, background: palette.background },
  }).composite(await resolveLayers(layers)));
}

/**
 * Renders a 1200x630 social preview for a static marketplace page.
 */
export async function renderPageOg({ eyebrow, title, description, footnote }) {
  const heading = String(title || "").toLowerCase();
  const size = heading.length > 24 ? 48 : heading.length > 16 ? 58 : 66;
  const tracking = -size * 0.04;
  const body = monoWrap(description, 19, 1000, 3);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ogWidth}" height="${ogHeight}">
  <rect width="${ogWidth}" height="${ogHeight}" fill="${palette.background}"/>
  ${header()}
  ${footer(footnote || siteHost)}
  ${text(String(eyebrow || "").toUpperCase(), { x: gutter, y: 214, size: 14, fill: palette.accent, weight: 700, tracking: 2.4 })}
  ${text(monoFit(heading, size, ogWidth - gutter * 2, tracking), {
    x: gutter,
    y: 214 + size + 22,
    size,
    fill: palette.textStrong,
    tracking,
  })}
  ${body.map((line, index) => text(line, {
    x: gutter,
    y: 214 + size + 74 + index * 34,
    size: 19,
    fill: palette.muted,
  })).join("\n  ")}
  <rect x="0" y="${ogHeight - accentRule}" width="${ogWidth}" height="${accentRule}" fill="${palette.accent}"/>
</svg>`;
  return encode(sharp({
    create: { width: ogWidth, height: ogHeight, channels: 3, background: palette.background },
  }).composite(await resolveLayers([
    { input: Buffer.from(svg) },
    wordmarkLayer(pageWatermark),
    wordmarkLayer(headerWordmark),
    wordmarkLayer(footerWordmark),
  ])));
}
