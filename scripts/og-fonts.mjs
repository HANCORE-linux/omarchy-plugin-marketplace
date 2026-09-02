import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const fontFamily = "JetBrains Mono";
export const fontDirectory = fileURLToPath(new URL("og/fonts/", import.meta.url));

// JetBrains Mono advance width is 600/1000 em units for every glyph.
export const monoAdvance = 0.6;

/**
 * Point fontconfig at the bundled JetBrains Mono files so social previews render
 * identically on a maintainer machine and in CI. System fonts stay available as a
 * fallback for glyphs the bundled family does not cover.
 */
export function useBundledFonts(environment = process.env) {
  if (environment.OMARCHY_OG_FONTCONFIG) return environment.OMARCHY_OG_FONTCONFIG;
  const configDirectory = join(tmpdir(), "omarchy-og-fontconfig");
  const cacheDirectory = join(configDirectory, "cache");
  const configFile = join(configDirectory, "fonts.conf");
  mkdirSync(cacheDirectory, { recursive: true });
  writeFileSync(configFile, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${fontDirectory}</dir>
  <cachedir>${cacheDirectory}</cachedir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
</fontconfig>
`);
  environment.FONTCONFIG_FILE = configFile;
  environment.OMARCHY_OG_FONTCONFIG = configFile;
  return configFile;
}

export function monoWidth(text, size, tracking = 0) {
  const characters = [...String(text)].length;
  return characters * size * monoAdvance + Math.max(characters - 1, 0) * tracking;
}

export function monoFit(text, size, maxWidth, tracking = 0) {
  const characters = [...String(text)];
  if (monoWidth(characters.join(""), size, tracking) <= maxWidth) return characters.join("");
  while (characters.length > 1 && monoWidth(`${characters.join("")}…`, size, tracking) > maxWidth) {
    characters.pop();
  }
  return `${characters.join("").replace(/[\s.,;:·-]+$/u, "")}…`;
}

export function monoWrap(text, size, maxWidth, maxLines, tracking = 0) {
  const words = String(text || "").split(/\s+/u).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (monoWidth(candidate, size, tracking) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length === maxLines) return closeWrap(lines, maxLines, size, maxWidth, tracking, true);
    current = monoWidth(word, size, tracking) > maxWidth ? monoFit(word, size, maxWidth, tracking) : word;
  }
  if (current) lines.push(current);
  return closeWrap(lines, maxLines, size, maxWidth, tracking, lines.length > maxLines);
}

function closeWrap(lines, maxLines, size, maxWidth, tracking, truncated) {
  const kept = lines.slice(0, maxLines);
  if (truncated && kept.length) {
    kept[kept.length - 1] = monoFit(`${kept[kept.length - 1]} …`, size, maxWidth, tracking);
  }
  return kept;
}
