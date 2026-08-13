import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseGitHubRepository } from "./build-catalog.mjs";

export const securityBaselineVersion = "1";
export const securityBaselineMarkerPrefix = "<!-- marketplace-security-baseline:v1 ";
export const securityFileByteLimit = 512 * 1024;
export const securitySnapshotByteLimit = 8 * 1024 * 1024;
export const securitySnapshotFileLimit = 1000;
export const securityBaselineEnforcementMode = "shadow";

const securityBinaryProbeByteLimit = 4096;
const outcomes = new Set(["passed", "review-required", "needs-fixes"]);
const enforcementModes = new Set(["shadow", "enforced"]);
const blockingLabels = new Set([
  "needs-fixes",
  ...(securityBaselineEnforcementMode === "enforced" ? ["security-needs-fixes"] : []),
]);
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
  ".toml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const ruleCatalog = Object.freeze({
  "curl-pipe-shell": Object.freeze({
    title: "Downloaded content is passed directly to a shell",
    why: "The remote response is executed immediately and is not bound to the commit reviewed for this submission.",
    actions: Object.freeze([
      "Remove the download-and-execute installation path.",
      "Use a trusted package manager or another installation path that does not execute downloaded content.",
    ]),
  }),
  "cargo-git-unpinned": Object.freeze({
    title: "Cargo builds an unpinned Git repository",
    why: "`--locked` fixes Cargo dependencies but not the Git repository itself, so the executed source can change after review.",
    actions: Object.freeze([
      "Add `--rev` with a full 40-character commit SHA.",
      "Update that SHA in a new plugin commit whenever the dependency is intentionally updated.",
    ]),
  }),
  "remote-git-execution-unpinned": Object.freeze({
    title: "Remote Git source is executed without a fixed commit",
    why: "A branch or tag can move after review, causing users to execute source that was not part of the reviewed snapshot.",
    actions: Object.freeze([
      "Require a full 40-character commit SHA before fetching or building.",
      "Check out that exact commit in detached mode before executing the downloaded source.",
      "Remove the remote source-build path if an exact commit cannot be required.",
    ]),
  }),
});

const capabilityCatalog = Object.freeze({
  installer: Object.freeze({
    title: "Installer or setup path",
    why: "Installer code can modify the user environment and needs a maintainer to confirm its documented scope.",
  }),
  "package-manager": Object.freeze({
    title: "Package management",
    why: "The plugin can install, upgrade, or remove software outside its own checkout.",
  }),
  privilege: Object.freeze({
    title: "Privilege request",
    why: "The plugin or its instructions invoke an explicit privilege boundary such as `sudo` or `pkexec`.",
  }),
  "remote-build": Object.freeze({
    title: "Remote source build",
    why: "The installation path builds, installs, or directly executes source obtained from a remote repository.",
  }),
  "bundled-executable-binary": Object.freeze({
    title: "Bundled executable binary",
    why: "The repository includes an executable binary that this deterministic source scan cannot inspect.",
  }),
  "service-management": Object.freeze({
    title: "Service management",
    why: "The plugin can inspect or change a system or user service lifecycle.",
  }),
});

export class SecurityBaselineError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "SecurityBaselineError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function assertFullCommitSha(value, code = "security-baseline-invalid") {
  const commit = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new SecurityBaselineError(code, "A full 40-character commit SHA is required");
  }
  return commit;
}

function githubHeaders(token, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "User-Agent": "omarchy-plugin-marketplace-security-baseline",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchWithDeadline(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      `Could not read the repository snapshot: ${error.message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function githubJson(path, { fetchImpl, token }) {
  const response = await fetchWithDeadline(fetchImpl, `https://api.github.com${path}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      `GitHub returned ${response.status} for ${path}`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      `GitHub returned invalid JSON for ${path}: ${error.message}`,
    );
  }
}

function rawSnapshotUrl(repository, commitSha, path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${repository.owner}/${repository.repository}/${commitSha}/${encodedPath}`;
}

function isRootReadme(path) {
  return !path.includes("/") && /^readme(?:\.[^/]+)?$/i.test(path);
}

function isShellRuntimePath(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1);
  if (/\.(?:ba|z|fi)?sh$/i.test(basename)) return true;
  if (!basename.includes(".") && /^(?:bin|scripts)\//i.test(normalized)) return true;
  return /(?:^|[-_])(install|installer|setup|uninstall)(?:[-_.]|$)/i.test(basename)
    && !/\.(?:md|json)$/i.test(basename);
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
  if (parts[0] === "bin" || parts[0] === "scripts") return extensionAt < 0;
  return /(?:^|[-_])(install|installer|setup|uninstall)(?:[-_.]|$)/i.test(basename);
}

function binaryFormat(buffer) {
  if (buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return "ELF";
  if (buffer.subarray(0, 2).equals(Buffer.from([0x4d, 0x5a]))) return "PE";
  const magic = buffer.length >= 4 ? buffer.readUInt32BE(0) : 0;
  if (new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]).has(magic)) return "Mach-O";
  return buffer.includes(0) ? "binary" : "";
}

async function readSnapshotResponse(repository, commitSha, entry, { fetchImpl }, range = "") {
  const response = await fetchWithDeadline(
    fetchImpl,
    rawSnapshotUrl(repository, commitSha, entry.path),
    {
      headers: {
        ...githubHeaders("", "text/plain"),
        ...(range ? { Range: range } : {}),
      },
    },
  );
  if (!response.ok) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      `Snapshot file ${entry.path} returned ${response.status}`,
      { path: entry.path },
    );
  }
  if (range) {
    const expected = `bytes 0-${securityBinaryProbeByteLimit - 1}/`;
    if (response.status !== 206 || !String(response.headers.get("content-range") || "").startsWith(expected)) {
      throw new SecurityBaselineError(
        "security-baseline-unavailable",
        `Snapshot file ${entry.path} did not honor the bounded binary probe`,
        { path: entry.path },
      );
    }
  }
  return response;
}

async function readSnapshotFile(repository, commitSha, entry, options) {
  if (entry.size > securityFileByteLimit) {
    if (entry.mode !== "100755") {
      throw new SecurityBaselineError(
        "security-baseline-scan-limit",
        `${entry.path} exceeds the static scan file-size limit`,
        { path: entry.path },
      );
    }
    const probeResponse = await readSnapshotResponse(
      repository,
      commitSha,
      entry,
      options,
      `bytes=0-${securityBinaryProbeByteLimit - 1}`,
    );
    const probe = Buffer.from(await probeResponse.arrayBuffer()).subarray(0, securityBinaryProbeByteLimit);
    const format = binaryFormat(probe);
    if (!format) {
      throw new SecurityBaselineError(
        "security-baseline-scan-limit",
        `${entry.path} exceeds the static scan file-size limit`,
        { path: entry.path },
      );
    }
    return { path: entry.path, mode: entry.mode, binary: true, format, size: entry.size };
  }
  const response = await readSnapshotResponse(repository, commitSha, entry, options);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > securityFileByteLimit) {
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      `${entry.path} exceeds the static scan file-size limit`,
      { path: entry.path },
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > securityFileByteLimit) {
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      `${entry.path} exceeds the static scan file-size limit`,
      { path: entry.path },
    );
  }
  const format = binaryFormat(buffer);
  if (format) {
    if (entry.mode === "100755") {
      return { path: entry.path, mode: entry.mode, binary: true, format, size: entry.size };
    }
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      `${entry.path} is not a supported text file`,
      { path: entry.path },
    );
  }
  return {
    path: entry.path,
    content: buffer.toString("utf8"),
    mode: entry.mode,
  };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function resolveSubmissionSnapshot(repoUrl, commitSha, options = {}) {
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
  const rootManifestEntry = tree.find((entry) => (
    entry.path === "manifest.json"
    && entry.type === "blob"
    && entry.mode !== "120000"
  ));
  let forcedEntryPoints = new Set();
  if (rootManifestEntry) {
    const manifestFile = await readSnapshotFile(
      repository,
      expectedCommit,
      rootManifestEntry,
      { fetchImpl, token },
    );
    try {
      const manifest = JSON.parse(manifestFile.content);
      forcedEntryPoints = new Set(Object.values(manifest.entryPoints || {}).filter((path) => (
        typeof path === "string"
        && path
        && !path.startsWith("/")
        && !path.includes("..")
      )));
    } catch {
      throw new SecurityBaselineError(
        "security-baseline-unavailable",
        "The validated root manifest could not be read for the static scan",
      );
    }
  }
  const entries = tree.filter((entry) => {
    if (entry.type !== "blob" || entry.mode === "120000") return false;
    const parts = entry.path.toLowerCase().split("/");
    const basename = parts.at(-1);
    const excluded = parts.slice(0, -1).some((part) => excludedDirectories.has(part));
    const extensionless = !basename.includes(".") && !excluded;
    return isSecurityScanPath(entry.path)
      || entry.mode === "100755"
      || extensionless
      || forcedEntryPoints.has(entry.path)
      || requiredPaths.has(entry.path);
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
  return {
    repository: repository.slug,
    repoUrl: `https://github.com/${repository.owner}/${repository.repository}`,
    commitSha: expectedCommit,
    defaultBranch: metadata.default_branch,
    files,
  };
}

function logicalCommands(file) {
  const lines = String(file.content || "").split(/\r?\n/);
  const commands = [];
  let text = "";
  let startLine = 1;
  for (const [index, line] of lines.entries()) {
    if (!text) startLine = index + 1;
    const continued = /\\\s*$|(?:\||&&|\|\|)\s*$/.test(line);
    text += `${text ? " " : ""}${line.replace(/\\\s*$/, "").trim()}`;
    if (!continued) {
      commands.push({ path: file.path, line: startLine, text: text.trim() });
      text = "";
    }
  }
  if (text) commands.push({ path: file.path, line: startLine, text: text.trim() });
  return commands;
}

function isCommentOnly(command) {
  if (isRootReadme(command.path)) return false;
  return /^(?:#|\/\/|\/\*|\*|<!--)/.test(command.text.trim());
}

function evidence(command) {
  return {
    path: command.path,
    line: command.line,
    snippet: command.text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300),
  };
}

function commandSequence(file) {
  return logicalCommands(file).filter((command) => command.text && !isCommentOnly(command));
}

function literalCommit(argument) {
  const value = String(argument || "").replace(/^["']|["']$/g, "");
  return /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : "";
}

function stripInlineComment(text) {
  return String(text || "").replace(/\s+#.*$/, "").trim();
}

function commandTokenBasename(token) {
  return String(token || "").split("/").at(-1) || "";
}

function stripOuterTokenQuotes(value) {
  return String(value || "").replace(/^["']|["']$/g, "");
}

function stripCommandWrapper(value, name, optionsWithValues = new Set()) {
  const tokens = value.trim().split(/\s+/);
  if (commandTokenBasename(stripOuterTokenQuotes(tokens[0])) !== name) return value;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    const normalizedToken = stripOuterTokenQuotes(token);
    if (normalizedToken === "--") {
      index++;
      break;
    }
    if (!normalizedToken.startsWith("-")) break;
    const optionName = normalizedToken.split("=")[0];
    if (optionsWithValues.has(optionName) && !normalizedToken.includes("=")) index++;
    index++;
  }
  return tokens.slice(index).join(" ");
}

function stripEnvWrapper(value) {
  const tokens = value.trim().split(/\s+/);
  if (commandTokenBasename(stripOuterTokenQuotes(tokens[0])) !== "env") return value;
  const optionsWithValues = new Set(["-C", "--chdir", "-u", "--unset"]);
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    const normalizedToken = stripOuterTokenQuotes(token);
    if (normalizedToken === "--") return tokens.slice(index + 1).join(" ");
    if (/^-S.+/.test(normalizedToken)) {
      const payload = normalizedToken.slice(2);
      return normalizedShellToken(`${payload} ${tokens.slice(index + 1).join(" ")}`.trim());
    }
    if (normalizedToken.startsWith("--split-string=")) {
      const payload = normalizedToken.slice("--split-string=".length);
      return normalizedShellToken(`${payload} ${tokens.slice(index + 1).join(" ")}`.trim());
    }
    if (normalizedToken === "-S" || normalizedToken === "--split-string") {
      return normalizedShellToken(tokens.slice(index + 1).join(" "));
    }
    const optionName = normalizedToken.split("=")[0];
    if (optionsWithValues.has(optionName)) {
      if (!normalizedToken.includes("=")) index++;
      continue;
    }
    if (normalizedToken.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalizedToken)) continue;
    return tokens.slice(index).join(" ");
  }
  return "";
}

function stripTimeoutWrapper(value) {
  const strippedOptions = stripCommandWrapper(
    value,
    "timeout",
    new Set(["-k", "--kill-after", "-s", "--signal"]),
  );
  if (strippedOptions === value) return value;
  return strippedOptions.replace(/^\S+\s+/, "");
}

function shellExecutable(text) {
  let value = stripInlineComment(text)
    .replace(/^\s*[({]+\s*/, "")
    .replace(/^\s*(?:if|then|do)\s+/, "")
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "");
  for (let attempts = 0; attempts < 12; attempts++) {
    const before = value;
    value = stripCommandWrapper(value, "command");
    value = stripCommandWrapper(value, "exec");
    value = stripCommandWrapper(value, "nohup");
    value = stripCommandWrapper(value, "sudo", new Set([
      "-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u",
      "--chdir", "--close-from", "--group", "--host", "--other-user",
      "--prompt", "--role", "--root", "--type", "--user",
    ]));
    value = stripEnvWrapper(value);
    value = value.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "");
    value = stripTimeoutWrapper(value);
    if (value === before) break;
  }
  const rawToken = value.match(/^([^\s;&|)]+)/)?.[1] || "";
  const token = stripOuterTokenQuotes(rawToken);
  return {
    token,
    basename: token.split("/").at(-1) || "",
    rest: value.slice(rawToken.length).trim(),
  };
}

function cargoGitFinding(command, submissionRepository = "") {
  const executable = shellExecutable(command.text);
  const cargoCommand = executable.rest.replace(/^\+[^\s]+\s+/, "");
  if (executable.basename !== "cargo" || !/^install\b/i.test(cargoCommand) || !/\s--git(?:\s|=)/i.test(` ${cargoCommand}`)) return null;
  const rev = cargoCommand.match(/(?:^|\s)--rev(?:\s+|=)([^\s;&|]+)/i)?.[1] || "";
  if (literalCommit(rev) || commandUsesOnlySubmissionRepository(command, submissionRepository)) return null;
  return {
    ruleId: "cargo-git-unpinned",
    ...ruleCatalog["cargo-git-unpinned"],
    evidence: [evidence(command)],
  };
}

function literalShellPayload(command) {
  const executable = shellExecutable(command.text);
  if (executable.basename === "eval") {
    return normalizedShellToken(executable.rest);
  }
  if (interpreterExecutables.test(executable.basename) && /^-c\s+/i.test(executable.rest)) {
    return normalizedShellToken(executable.rest.replace(/^-c\s+/i, ""));
  }
  return "";
}

function githubRepositoryFromUrl(value) {
  const raw = normalizedShellToken(value).replace(/(?:[),;]+|[.:!?]+$)/g, "");
  try {
    if (/^https:\/\/github\.com\//i.test(raw)) {
      return parseGitHubRepository(raw).slug.toLowerCase();
    }
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "raw.githubusercontent.com") return "";
    const [owner, repository] = url.pathname.split("/").filter(Boolean);
    return owner && repository ? `${owner}/${repository}`.toLowerCase() : "";
  } catch {
    return "";
  }
}

function commandRemoteUrls(command) {
  const text = stripInlineComment(String(command?.text || command?.content || ""));
  return text.match(
    /(?:https?|git|ssh):\/\/[^\s"'`|;&)]+|git@[^\s:"'`|;&)]+:[^\s"'`|;&)]+/gi,
  ) || [];
}

function commandRemoteRepositories(command) {
  return new Set(commandRemoteUrls(command).map(githubRepositoryFromUrl).filter(Boolean));
}

function commandUsesOnlySubmissionRepository(command, submissionRepository) {
  const expected = String(submissionRepository || "").toLowerCase();
  const urls = commandRemoteUrls(command);
  if (!expected || !urls.length) return false;
  const repositories = urls.map(githubRepositoryFromUrl);
  return repositories.every((repository) => repository === expected);
}

function pipeToShellFinding(command, submissionRepository = "") {
  const text = stripInlineComment(command.text);
  const nestedPayload = literalShellPayload(command);
  if (nestedPayload && nestedPayload !== text) {
    const nested = pipeToShellFinding({ ...command, text: nestedPayload }, submissionRepository);
    if (nested) return { ...nested, evidence: [evidence(command)] };
  }
  const candidateSegments = text.split(/(?:&&|\|\||;)/).map((part) => part.trim()).filter(Boolean);
  for (const segment of candidateSegments) {
    if (segment !== text) {
      const nested = pipeToShellFinding({ ...command, text: segment }, submissionRepository);
      if (nested) return { ...nested, evidence: [evidence(command)] };
    }
  }
  const downloader = shellExecutable(text);
  const startsWithDownloader = ["curl", "wget"].includes(downloader.basename);
  const shell = "(?:/[^\\s;&|]*/)?(?:ba|z|fi|da|a|k)?sh";
  const pipedCommands = text.replace(/\|&/g, "|").split(/\|(?!\|)/).slice(1).map((part) => part.trim());
  const pipe = startsWithDownloader
    && pipedCommands.some((part) => interpreterExecutables.test(shellExecutable(part).basename));
  const substitution = new RegExp(
    `(?:${shell}|source|\\.)\\s+(?:<\\s*)?<\\(\\s*(?:curl|wget)\\b`,
    "i",
  ).test(text);
  const commandSubstitution = /(?:eval\s+|(?:ba|z|fi|da|a|k)?sh\s+-c\s+)["']?\$\(\s*(?:curl|wget)\b/i.test(text);
  if (!pipe && !substitution && !commandSubstitution) return null;
  if (commandUsesOnlySubmissionRepository(command, submissionRepository)) return null;
  return {
    ruleId: "curl-pipe-shell",
    ...ruleCatalog["curl-pipe-shell"],
    evidence: [evidence(command)],
  };
}

function compoundSegments(file) {
  const segments = [];
  let carriedOperator = "";
  let currentWorkingDirectory = "";
  let errexit = false;
  for (const [commandIndex, command] of commandSequence(file).entries()) {
    const parts = command.text.split(/(&&|\|\||;|&(?![&>]))/);
    let previousOperator = carriedOperator;
    let workingDirectory = currentWorkingDirectory;
    for (let index = 0; index < parts.length; index += 2) {
      const text = String(parts[index] || "").trim();
      const nextOperator = parts[index + 1] || "";
      if (!text) {
        previousOperator = nextOperator || previousOperator;
        continue;
      }
      const segment = {
        ...command,
        text,
        commandIndex,
        previousOperator,
        nextOperator,
        workingDirectory,
        errexit,
      };
      segments.push(segment);
      const executable = shellExecutable(text);
      if (executable.basename === "cd") {
        workingDirectory = normalizedShellToken(executable.rest.split(/\s/)[0]);
      }
      if (executable.basename === "set") {
        if (/(?:^|\s)-(?:[^\s]*e|o\s+errexit)(?:\s|$)/.test(executable.rest)) errexit = true;
        if (/(?:^|\s)\+(?:[^\s]*e|o\s+errexit)(?:\s|$)/.test(executable.rest)) errexit = false;
      }
      previousOperator = nextOperator;
    }
    currentWorkingDirectory = workingDirectory;
    carriedOperator = parts.at(-2) && /^(?:&&|\|\|)$/.test(parts.at(-2))
      ? parts.at(-2)
      : "";
  }
  return segments;
}

function gitSubcommand(rest) {
  const tokens = String(rest || "").split(/\s+/);
  const optionsWithValues = new Set([
    "-c", "-C", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree",
  ]);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (optionsWithValues.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return { command: token, rest: tokens.slice(index + 1).join(" ") };
  }
  return { command: "", rest: "" };
}

function isGitAcquisition(command) {
  const executable = shellExecutable(command.text);
  if (executable.basename !== "git") return false;
  return /^(?:clone|fetch|pull)$/i.test(gitSubcommand(executable.rest).command);
}

const interpreterExecutables = /^(?:bash|sh|zsh|dash|ash|ksh|fish|python(?:[23](?:\.[0-9]+)?)?|node|ruby|perl|php|java|deno|dotnet)$/i;
const buildExecutables = /^(?:make|gmake|cmake|ninja|meson|gradle|gradlew|mvn|maven|go|cargo|npm|pnpm|yarn|bun)$/i;

function normalizedDirectoryReference(value) {
  return normalizedShellToken(value).replace(/^\.\//, "").replace(/\/$/, "");
}

function commandReferencesDirectory(command, directory) {
  const normalizedDirectory = normalizedDirectoryReference(directory);
  if (!normalizedDirectory) return false;
  const workingDirectory = normalizedDirectoryReference(command.workingDirectory);
  if (normalizedDirectory === "." || workingDirectory === normalizedDirectory) return true;
  return String(command.text || "").split(/[\s;&|()]+/).some((rawToken) => {
    const token = normalizedShellToken(rawToken).replace(/^\.\//, "").replace(/[,:]$/, "");
    const optionValue = token.includes("=") ? token.slice(token.indexOf("=") + 1) : "";
    return token === normalizedDirectory
      || token.startsWith(`${normalizedDirectory}/`)
      || token.includes(`/${normalizedDirectory}/`)
      || optionValue === normalizedDirectory
      || optionValue.startsWith(`${normalizedDirectory}/`);
  });
}

function executableReferencesDirectory(command, directory) {
  const normalizedDirectory = normalizedDirectoryReference(directory);
  const workingDirectory = normalizedDirectoryReference(command.workingDirectory);
  if (normalizedDirectory === "." || workingDirectory === normalizedDirectory) return true;
  const token = normalizedDirectoryReference(shellExecutable(command.text).token);
  return token === normalizedDirectory
    || token.startsWith(`${normalizedDirectory}/`)
    || token.includes(`/${normalizedDirectory}/`);
}

function isExecutionSink(command, directory = "") {
  const executable = shellExecutable(command.text);
  const { basename, rest, token } = executable;
  if (!basename) return false;
  let executes = interpreterExecutables.test(basename);
  if (buildExecutables.test(basename)) {
    executes = true;
    if (basename === "go") executes = /^run\b/i.test(rest);
    if (basename === "cargo") executes = /^(?:\+[^\s]+\s+)?(?:build|run)\b|^(?:\+[^\s]+\s+)?install\b[\s\S]*--path\b/i.test(rest);
    if (/^(?:npm|pnpm|yarn|bun)$/i.test(basename)) {
      executes = /(?:^|\s)(?:ci|install|run|build|start|test|exec|dlx)\b/i.test(rest);
    }
  }
  if (/^(?:source|\.)$/.test(basename)) executes = true;
  if (directory) return executes
    ? commandReferencesDirectory(command, directory)
    : token.includes("/") && executableReferencesDirectory(command, directory);
  return executes || (/^(?:\.{0,2}\/)/.test(token) && token.includes("/"));
}
function normalizedShellToken(value) {
  return String(value || "").replace(/^["']|["']$/g, "");
}

function gitAcquisitionDirectory(command) {
  const executable = shellExecutable(command.text);
  if (executable.basename !== "git") return "";
  const parsed = gitSubcommand(executable.rest);
  const explicitDirectory = executable.rest.match(/(?:^|\s)-C\s+([^\s]+)/)?.[1];
  if (/^(?:fetch|pull)$/i.test(parsed.command)) {
    return normalizedShellToken(explicitDirectory || command.workingDirectory || ".");
  }
  if (parsed.command !== "clone") return "";
  const rawCloneTokens = parsed.rest.split(/\s+/);
  const redirectionAt = rawCloneTokens.findIndex((token) => /^(?:\||&?>|\d*>)/.test(token));
  const cloneTokens = redirectionAt < 0
    ? rawCloneTokens
    : rawCloneTokens.slice(0, redirectionAt);
  const tokens = [];
  const optionsWithValues = new Set([
    "--branch", "-b", "--bundle-uri", "--config", "-c", "--depth", "--filter",
    "--jobs", "-j", "--origin", "-o", "--ref-format", "--reference",
    "--reference-if-able", "--revision", "--separate-git-dir", "--server-option",
    "--shallow-exclude", "--shallow-since", "--template", "--upload-pack", "-u",
  ]);
  for (let index = 0; index < cloneTokens.length; index++) {
    const token = cloneTokens[index];
    if (optionsWithValues.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith("-")) continue;
    tokens.push(token);
  }
  if (!tokens.length) return "";
  if (tokens.length > 1) return normalizedShellToken(tokens.at(-1));
  try {
    const repository = new URL(normalizedShellToken(tokens[0])).pathname.split("/").filter(Boolean).at(-1) || "";
    return repository.replace(/\.git$/i, "");
  } catch {
    return "";
  }
}

function repositoryMutation(segment, directory) {
  const executable = shellExecutable(segment.text);
  if (executable.basename !== "git") return null;
  const parsed = gitSubcommand(executable.rest);
  const explicitDirectory = executable.rest.match(/(?:^|\s)-C\s+([^\s]+)/)?.[1];
  const targetDirectory = normalizedShellToken(
    explicitDirectory || segment.workingDirectory || ".",
  );
  const command = /^(?:checkout|switch|reset|pull|merge|rebase|restore|cherry-pick|submodule)$/i.test(parsed.command)
    ? parsed.command
    : "";
  if (!command || targetDirectory !== directory) return null;
  const exactPin = /^(?:checkout|switch)$/i.test(command)
    && /(?:^|\s)--detach\s/i.test(parsed.rest)
    && literalCommit(parsed.rest.match(/(?:^|\s)--detach\s+([^\s;&|]+)/i)?.[1]);
  return {
    exactPin: Boolean(exactPin),
    reliable: (segment.nextOperator === "&&" || segment.errexit)
      && segment.previousOperator !== "||"
      && !/\|\|/.test(executable.rest),
  };
}

function downloadTarget(command) {
  if (!/\b(?:curl|wget)\b/i.test(command.text)) return "";
  const output = stripInlineComment(command.text).match(
    /(?:^|\s)(?:-o|--output(?:-document)?)(?:\s+|=)([^\s;&|]+)|(?:^|\s)-[A-Za-z]*o([^\s;&|]+)|>\s*([^\s;&|]+)/i,
  );
  return normalizedShellToken(output?.[1] || output?.[2] || output?.[3]);
}

function downloadedFileFindings(file, segments, submissionRepository = "") {
  const findings = [];
  for (const [index, command] of segments.entries()) {
    const target = downloadTarget(command);
    if (!target) continue;
    const sink = segments.slice(index + 1).find((candidate) => (
      isExecutionSink(candidate)
      && candidate.text.includes(target)
    ));
    if (!sink || commandUsesOnlySubmissionRepository(command, submissionRepository)) continue;
    findings.push({
      ruleId: "curl-pipe-shell",
      ...ruleCatalog["curl-pipe-shell"],
      title: "Downloaded content is executed without verification",
      evidence: [evidence(command), evidence(sink)],
    });
  }
  return findings;
}

function remoteGitExecutionFindings(file, submissionRepository = "") {
  const segments = compoundSegments(file).map((segment) => ({ ...segment, file }));
  const findings = [];
  const submissionDirectories = new Set();
  const documentedSubmissionCheckout = file.documentation
    && file.documentedRepositories?.includes(submissionRepository);
  for (const [index, acquisition] of segments.entries()) {
    if (!isGitAcquisition(acquisition)) continue;
    const directory = gitAcquisitionDirectory(acquisition);
    const acquisitionRemotes = commandRemoteUrls(acquisition);
    const explicitRemote = acquisitionRemotes.length > 0;
    const submissionSource = commandUsesOnlySubmissionRepository(acquisition, submissionRepository)
      || (!explicitRemote && submissionDirectories.has(directory))
      || (!explicitRemote && documentedSubmissionCheckout
        && /^(?:fetch|pull)$/i.test(gitSubcommand(shellExecutable(acquisition.text).rest).command));
    if (directory) {
      if (submissionSource) submissionDirectories.add(directory);
      else if (explicitRemote) submissionDirectories.delete(directory);
    }
    let pinned = false;
    let sourceIsSubmission = submissionSource;
    for (const segment of segments.slice(index + 1)) {
      const mutation = directory ? repositoryMutation(segment, directory) : null;
      if (mutation) {
        pinned = mutation.exactPin && mutation.reliable;
        continue;
      }
      const executable = shellExecutable(segment.text);
      const parsedGit = executable.basename === "git" ? gitSubcommand(executable.rest) : null;
      const remoteMutation = parsedGit?.command === "remote"
        && /^(?:add|set-url)\b/i.test(parsedGit.rest)
        && commandRemoteUrls(segment).length > 0;
      if (remoteMutation) {
        const remoteDirectory = normalizedDirectoryReference(
          executable.rest.match(/(?:^|\s)-C\s+([^\s]+)/)?.[1]
            || segment.workingDirectory
            || ".",
        );
        if (remoteDirectory === normalizedDirectoryReference(directory)) {
          // Remote mutation can revoke self provenance, but cannot promote an
          // external checkout to trusted self provenance without a new clone.
          sourceIsSubmission = sourceIsSubmission
            && commandUsesOnlySubmissionRepository(segment, submissionRepository);
          if (directory && !sourceIsSubmission) submissionDirectories.delete(directory);
          pinned = false;
        }
        continue;
      }
      if (isExecutionSink(segment, directory)) {
        if (!pinned && !sourceIsSubmission) {
          findings.push({
            ruleId: "remote-git-execution-unpinned",
            ...ruleCatalog["remote-git-execution-unpinned"],
            evidence: acquisition.line === segment.line
              ? [evidence(acquisition)]
              : [evidence(acquisition), evidence(segment)],
          });
          break;
        }
      }
      if (pinned && segment.nextOperator !== "&&") {
        // A successful checkout must remain in one fail-closed && chain until
        // every execution sink. Otherwise an intermediate failure can fall
        // through to a later build of the mutable clone.
        pinned = false;
      }
    }
  }
  findings.push(...downloadedFileFindings(file, segments, submissionRepository));
  return findings;
}
function dedupeFindings(findings) {
  const byRule = new Map();
  for (const finding of findings) {
    if (!byRule.has(finding.ruleId)) {
      byRule.set(finding.ruleId, { ...finding, evidence: [] });
    }
    const grouped = byRule.get(finding.ruleId);
    for (const item of finding.evidence) {
      if (!grouped.evidence.some((entry) => entry.path === item.path && entry.line === item.line)) {
        grouped.evidence.push(item);
      }
    }
  }
  return [...byRule.values()].map((finding) => ({
    ...finding,
    evidence: finding.evidence.slice(0, 8),
  }));
}

function isExecutableTextFile(file) {
  return file.mode === "100755"
    || file.entryPoint === true
    || /^#!.*(?:sh|bash|zsh|dash|ash|ksh|fish)\b/m.test(file.content || "");
}

function shellFenceFiles(file) {
  if (!isRootReadme(file.path)) return [];
  const files = [];
  const lines = String(file.content || "").split(/\r?\n/);
  let section = "";
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^ {0,3}#{1,6}\s+(.+)$/);
    if (heading) section = heading[1].trim().toLowerCase();
    const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*(?:(?:ba|z|fi|da|a|k)?sh|shell)\s*$/i);
    if (!opening) continue;
    const marker = opening[1][0];
    const minimumLength = opening[1].length;
    const body = [];
    for (index++; index < lines.length; index++) {
      const closing = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === marker && closing[1].length >= minimumLength) break;
      body.push(lines[index]);
    }
    if (!/\b(?:development|contributing|contributor|testing|test)\b/i.test(section)) {
      files.push({
        path: file.path,
        content: body.join("\n"),
        mode: "100755",
        documentation: true,
        documentedRepositories: file.documentedRepositories,
      });
    }
  }
  return files;
}

function decodeLiteral(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\(["'`\\])/g, "$1");
}

function quotedLiterals(value) {
  const literals = [];
  const text = String(value || "");
  for (let index = 0; index < text.length; index++) {
    const quote = text[index];
    if (!["\"", "'", "`"].includes(quote)) continue;
    let content = "";
    for (index++; index < text.length; index++) {
      if (text[index] === "\\" && index + 1 < text.length) {
        content += text[index] + text[++index];
      } else if (text[index] === quote) {
        break;
      } else {
        content += text[index];
      }
    }
    literals.push(decodeLiteral(content));
  }
  return literals;
}

function literalLauncherFiles(file) {
  if (!/\.(?:qml|js|mjs|cjs|py|desktop|service)$/i.test(file.path)) return [];
  const text = String(file.content || "");
  const payloads = [];
  const launcherCall = /\b(?:exec|execSync|execFile|execFileSync|execDetached|spawn|spawnSync|os\.system|subprocess\.(?:run|call|Popen|check_call|check_output)|command)\s*\(([\s\S]*?)\)/gi;
  for (const match of text.matchAll(launcherCall)) {
    const literals = quotedLiterals(match[1]);
    const shellIndex = literals.findIndex((literal) => interpreterExecutables.test(commandTokenBasename(literal)));
    if (shellIndex >= 0 && literals[shellIndex + 1] === "-c") {
      payloads.push(literals[shellIndex + 2] || "");
    } else if (literals.length) {
      payloads.push(literals.join(" "));
    }
  }
  const processCommand = /\bcommand\s*:\s*\[([\s\S]*?)\]/gi;
  for (const match of text.matchAll(processCommand)) {
    const literals = quotedLiterals(match[1]);
    if (literals.length) payloads.push(literals.join(" "));
  }
  for (const match of text.matchAll(/\bExec(?:Start)?=([^\r\n]+)/gi)) payloads.push(match[1]);
  if (!payloads.some((payload) => /\b(?:curl|wget|git|cargo)\b/i.test(payload))) return [];
  return [{ path: file.path, content: payloads.join("\n"), mode: "100755" }];
}

function literalShellPayloadFiles(file) {
  const payloads = [];
  for (const command of commandSequence(file)) {
    const payload = literalShellPayload(command);
    if (payload && payload !== command.text) {
      payloads.push({ path: file.path, content: payload, mode: "100755" });
    }
  }
  return payloads;
}

function expandedSecurityFiles(files) {
  const queue = (files || []).flatMap((file) => [
    file,
    ...shellFenceFiles(file),
    ...literalLauncherFiles(file),
  ]);
  const expanded = [];
  const seen = new Set();
  const expansionLimit = securitySnapshotFileLimit * 4;
  while (queue.length) {
    const file = queue.shift();
    const key = `${file.path}\0${file.content}`;
    if (seen.has(key)) continue;
    if (expanded.length >= expansionLimit) {
      throw new SecurityBaselineError(
        "security-baseline-scan-limit",
        "The static command expansion limit was exceeded",
      );
    }
    seen.add(key);
    expanded.push(file);
    queue.push(...literalShellPayloadFiles(file));
  }
  return expanded;
}

export function detectUnsafeRemoteExecution(files, submissionRepository = "") {
  const findings = [];
  const preparedFiles = files.filter((entry) => !entry.binary).map((file) => ({
    ...file,
    ...(isRootReadme(file.path)
      ? { documentedRepositories: [...commandRemoteRepositories(file)] }
      : {}),
  }));
  for (const file of expandedSecurityFiles(preparedFiles)) {
    const commands = commandSequence(file);
    if (isShellRuntimePath(file.path) || isExecutableTextFile(file)) {
      for (const command of commands) {
        const pipe = pipeToShellFinding(command, submissionRepository);
        if (pipe) findings.push(pipe);
        const cargo = cargoGitFinding(command, submissionRepository);
        if (cargo) findings.push(cargo);
      }
      findings.push(...remoteGitExecutionFindings(file, submissionRepository));
    }
  }
  return dedupeFindings(findings);
}

function capability(id, command) {
  return {
    id,
    ...capabilityCatalog[id],
    evidence: [evidence(command)],
  };
}

function installerEvidence(file) {
  const basename = file.path.split("/").at(-1);
  if (!/(?:^|[-_])(install|installer|setup|uninstall)(?:[-_.]|$)/i.test(basename)) return null;
  return { path: file.path, line: 1, snippet: "Installer or setup file" };
}

function dedupeCapabilities(capabilities) {
  const byId = new Map();
  for (const item of capabilities) {
    if (!byId.has(item.id)) {
      byId.set(item.id, { ...item, evidence: [...item.evidence] });
      continue;
    }
    const existing = byId.get(item.id);
    for (const itemEvidence of item.evidence) {
      if (!existing.evidence.some((entry) => entry.path === itemEvidence.path && entry.line === itemEvidence.line)) {
        existing.evidence.push(itemEvidence);
      }
    }
  }
  return [...byId.values()].map((item) => ({ ...item, evidence: item.evidence.slice(0, 5) }));
}

export function detectElevatedCapabilities(files, submissionRepository = "") {
  const capabilities = [];
  for (const binary of (files || []).filter((entry) => entry.binary && entry.mode === "100755")) {
    capabilities.push({
      id: "bundled-executable-binary",
      ...capabilityCatalog["bundled-executable-binary"],
      evidence: [{
        path: binary.path,
        line: 1,
        snippet: `${binary.format} executable binary (${binary.size} bytes)`,
      }],
    });
  }
  for (const file of expandedSecurityFiles((files || []).filter((entry) => !entry.binary))) {
    const installer = installerEvidence(file);
    if (installer) capabilities.push({ id: "installer", ...capabilityCatalog.installer, evidence: [installer] });
    if (/\.service$/i.test(file.path)) {
      capabilities.push({
        id: "service-management",
        ...capabilityCatalog["service-management"],
        evidence: [{ path: file.path, line: 1, snippet: "systemd service unit" }],
      });
    }
    const commands = commandSequence(file);
    if (!isRootReadme(file.path) || file.documentation) {
      const segments = compoundSegments(file);
      for (const [index, command] of segments.entries()) {
        if (!isGitAcquisition(command)) continue;
        const directory = gitAcquisitionDirectory(command);
        if (segments.slice(index + 1).some((segment) => isExecutionSink(segment, directory))) {
          capabilities.push(capability("remote-build", command));
        }
      }
    }
    for (const command of commands) {
      const text = command.text;
      if (
        commandUsesOnlySubmissionRepository(command, submissionRepository)
        && /\b(?:git\s+(?:clone|fetch|pull)|curl|wget)\b/i.test(text)
      ) capabilities.push(capability("remote-build", command));
      if (/\b(?:sudo|pkexec)\b/i.test(text)) capabilities.push(capability("privilege", command));
      if (
        /\bomarchy\s+pkg\s+(?:add|drop|remove|update)\b/i.test(text)
        || /\b(?:pacman|paru|yay|apt|apt-get|dnf|zypper|apk)\s+(?:-[A-Za-z]*[SRU]|install|remove|upgrade|add|del)\b/i.test(text)
        || /(?:^|[\s/'"])(?:pip|pip3|pipx)["']?\s+install\b/i.test(text)
        || /\bpython[23]?(?:\.[0-9]+)?\s+-m\s+pip\s+install\b/i.test(text)
        || /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b/i.test(text)
        || /\bcargo\s+install\b/i.test(text)
        || /\bgo\s+install\b/i.test(text)
        || /\bgem\s+install\b/i.test(text)
        || /\bbrew\s+(?:install|uninstall|upgrade)\b/i.test(text)
      ) capabilities.push(capability("package-manager", command));
      if (/\bsystemctl\b|\bsystemd-run\b|\.service\b/i.test(text)) {
        capabilities.push(capability("service-management", command));
      }
      if (/\bcargo\s+install\b/i.test(text) && /\s--git(?:\s|=)/i.test(text)) {
        capabilities.push(capability("remote-build", command));
      }
    }
  }
  return dedupeCapabilities(capabilities);
}

export function buildSecurityBaseline({ repository, repoUrl, commitSha, files }, options = {}) {
  const commit = assertFullCommitSha(commitSha);
  const submissionRepository = parseGitHubRepository(repoUrl).slug.toLowerCase();
  if (String(repository || "").toLowerCase() !== submissionRepository) {
    throw new SecurityBaselineError("security-baseline-invalid", "Repository identity does not match its URL");
  }
  const findings = detectUnsafeRemoteExecution(files, submissionRepository);
  const capabilities = detectElevatedCapabilities(files, submissionRepository);
  const outcome = findings.length
    ? "needs-fixes"
    : capabilities.length
      ? "review-required"
      : "passed";
  return {
    schemaVersion: 1,
    baselineVersion: securityBaselineVersion,
    repository,
    repoUrl,
    commitSha: commit,
    checkedAt: options.checkedAt || new Date().toISOString(),
    outcome,
    enforcementMode: securityBaselineEnforcementMode,
    findings,
    capabilities,
  };
}

export async function runSecurityBaseline(repoUrl, commitSha, options = {}) {
  const snapshot = await resolveSubmissionSnapshot(repoUrl, commitSha, options);
  return buildSecurityBaseline(snapshot, options);
}

function markerPayload(result) {
  return {
    schemaVersion: 1,
    baselineVersion: result.baselineVersion,
    repository: result.repository,
    commitSha: result.commitSha,
    checkedAt: result.checkedAt,
    outcome: result.outcome,
    enforcementMode: result.enforcementMode,
    findings: result.findings.map((finding) => finding.ruleId),
    capabilities: result.capabilities.map((capability) => capability.id),
  };
}

export function serializeSecurityBaselineMarker(result) {
  const encoded = Buffer.from(JSON.stringify(markerPayload(result))).toString("base64url");
  return `${securityBaselineMarkerPrefix}${encoded} -->`;
}

export function parseSecurityBaselineMarker(body) {
  const pattern = /<!-- marketplace-security-baseline:v1 ([A-Za-z0-9_-]+) -->/g;
  const matches = [...String(body || "").matchAll(pattern)];
  if (!matches.length) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(matches.at(-1)[1], "base64url").toString("utf8"));
  } catch {
    throw new SecurityBaselineError("approval-security-baseline-invalid", "Security baseline metadata is invalid");
  }
  if (
    parsed?.schemaVersion !== 1
    || parsed.baselineVersion !== securityBaselineVersion
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.repository || "")
    || !outcomes.has(parsed.outcome)
    || !enforcementModes.has(parsed.enforcementMode)
    || !Number.isFinite(Date.parse(parsed.checkedAt || ""))
    || !Array.isArray(parsed.findings)
    || !Array.isArray(parsed.capabilities)
  ) {
    throw new SecurityBaselineError("approval-security-baseline-invalid", "Security baseline metadata is invalid");
  }
  parsed.commitSha = assertFullCommitSha(parsed.commitSha, "approval-security-baseline-invalid");
  if (
    parsed.findings.some((id) => !Object.hasOwn(ruleCatalog, id))
    || parsed.capabilities.some((id) => !Object.hasOwn(capabilityCatalog, id))
  ) {
    throw new SecurityBaselineError("approval-security-baseline-invalid", "Security baseline metadata contains unknown rules");
  }
  return Object.freeze({ ...parsed });
}

export function findLatestSecurityBaseline(comments) {
  const botComments = (comments || []).filter((comment) => {
    const body = String(comment.body || "");
    return comment?.user?.login === "github-actions[bot]"
      && (
        body.includes("<!-- marketplace-security-baseline:v1 ")
        || body.includes("<!-- marketplace-security-baseline-error:v1 -->")
      );
  });
  if (!botComments.length) return null;
  const latest = botComments.at(-1).body;
  if (latest.includes("<!-- marketplace-security-baseline-error:v1 -->")) {
    throw new SecurityBaselineError(
      "approval-security-baseline-missing",
      "The latest automated security baseline did not complete",
    );
  }
  return parseSecurityBaselineMarker(latest);
}

function safeMarkdownText(value) {
  return String(value || "")
    .replace(/[<>`\r\n]+/g, " ")
    .replaceAll("\\", "\\\\")
    .replace(/([*_\[\]()~|])/g, "\\$1")
    .replaceAll("@", "@\u200b")
    .trim();
}

function commitDisplay(commitSha) {
  return `${commitSha.slice(0, 7)}…`;
}

function evidenceMarkdown(result, entries) {
  return entries.map((entry) => {
    const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
    const url = `https://github.com/${result.repository}/blob/${result.commitSha}/${encodedPath}#L${entry.line}`;
    return `- [\`${safeMarkdownText(entry.path)}:${entry.line}\`](${url})\n\n      ${safeMarkdownText(entry.snippet)}`;
  }).join("\n");
}

export function buildSecurityBaselineReport(result) {
  const lines = [
    serializeSecurityBaselineMarker(result),
    "## Automated security baseline",
    "",
  ];
  if (result.outcome === "passed") {
    lines.push(
      `✅ **Automated security baseline passed at commit \`${commitDisplay(result.commitSha)}\`.**`,
      "",
      "No action is required.",
    );
  } else if (result.outcome === "review-required") {
    lines.push(
      `🟡 **Manual review required at commit \`${commitDisplay(result.commitSha)}\`.**`,
      "",
      "No change is necessarily required. A marketplace maintainer must review these capabilities before approval.",
      "",
      "### Capabilities detected",
      "",
    );
    for (const item of result.capabilities) {
      lines.push(
        `#### ${item.title}`,
        "",
        item.why,
        "",
        evidenceMarkdown(result, item.evidence),
        "",
      );
    }
  } else {
    lines.push(
      `🔴 **Blocking patterns observed in shadow mode at commit \`${commitDisplay(result.commitSha)}\`.**`,
      "",
      "The following installation paths execute mutable remote code. During the V1 shadow period, these findings require maintainer review but do not automatically block approval.",
      "",
    );
    for (const finding of result.findings) {
      lines.push(
        `### ${finding.title}`,
        "",
        finding.why,
        "",
        evidenceMarkdown(result, finding.evidence),
        "",
        "Accepted fixes:",
        ...finding.actions.map((action) => `- ${action}`),
        "",
      );
    }
    lines.push("Prefer fixing the reported path. If a maintainer accepts it during shadow mode, they may approve this exact commit after review.");
  }
  lines.push(
    "",
    "This deterministic baseline detects only its documented patterns and is not designed to stop a motivated attacker.",
    "",
    "This is not a security audit, certification, warranty, or endorsement.",
  );
  return `${lines.join("\n").trim()}\n`;
}

function labelNames(labels) {
  return (labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean);
}

export function checkBlockingLabels(labels) {
  const found = labelNames(labels).find((label) => blockingLabels.has(label));
  if (found) {
    throw new SecurityBaselineError(
      "approval-blocking-label",
      `Approval is blocked by the "${found}" label`,
      { label: found },
    );
  }
}

export function checkCommitBinding(baselineSha, currentSha) {
  const baseline = assertFullCommitSha(baselineSha, "approval-security-baseline-invalid");
  const current = assertFullCommitSha(currentSha, "approval-upstream-changed");
  if (baseline !== current) {
    throw new SecurityBaselineError(
      "approval-upstream-changed",
      "The upstream repository changed after the automated security baseline",
      { baselineSha: baseline, currentSha: current },
    );
  }
}

export function assertApprovalAllowed(issue, baseline, currentInspection, repoUrl) {
  // During the V1 shadow period, security outcomes are measured and reviewed
  // but do not block a write-authorized maintainer's explicit approval.
  checkBlockingLabels(issue?.labels);
  if (!baseline) {
    throw new SecurityBaselineError(
      "approval-security-baseline-missing",
      "Approval requires an automated security baseline result",
    );
  }
  const expectedRepository = parseGitHubRepository(repoUrl).slug.toLowerCase();
  if (
    baseline.repository.toLowerCase() !== expectedRepository
    || baseline.enforcementMode !== securityBaselineEnforcementMode
  ) {
    throw new SecurityBaselineError(
      "approval-security-baseline-invalid",
      "The automated security baseline belongs to a different repository",
    );
  }
  if (securityBaselineEnforcementMode === "enforced" && baseline.outcome === "needs-fixes") {
    throw new SecurityBaselineError(
      "approval-security-needs-fixes",
      "The automated security baseline has unresolved blocking findings",
    );
  }
  checkCommitBinding(baseline.commitSha, currentInspection?.commitSha);
}

export function buildSecurityBaselineFailureReport(error) {
  const code = String(error?.code || "security-baseline-unavailable");
  const path = String(error?.context?.path || "")
    .replace(/[^A-Za-z0-9._/-]/g, "")
    .slice(0, 200);
  const scanLimit = code === "security-baseline-scan-limit";
  const detail = scanLimit && path
    ? `The static scan could not safely process \`${path}\` within its configured limits.`
    : scanLimit
      ? "The repository exceeds the limits for a complete static scan."
      : "The repository snapshot could not be scanned completely.";
  return `<!-- marketplace-security-baseline-error:v1 -->
## Automated security baseline

⚠️ **Baseline could not complete.**

${detail}

No approval is possible until this check completes. If the repository exceeds a scan limit, reduce generated or unrelated runtime files; otherwise edit the submission issue to retry.

This deterministic baseline detects only its documented patterns and is not designed to stop a motivated attacker.

This is not a security audit, certification, warranty, or endorsement.
`;
}

function requiredArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new SecurityBaselineError("security-baseline-invalid", `--${name} is required`);
  return value;
}

async function main() {
  const metadataPath = requiredArgument("metadata");
  const jsonPath = requiredArgument("json");
  const metadata = JSON.parse(await readFile(resolve(metadataPath), "utf8"));
  if (
    metadata?.schemaVersion !== 1
    || typeof metadata.repoUrl !== "string"
    || typeof metadata.commitSha !== "string"
  ) {
    throw new SecurityBaselineError("security-baseline-invalid", "Validation metadata is invalid");
  }
  const result = await runSecurityBaseline(metadata.repoUrl, metadata.commitSha, {
    requiredPaths: metadata.entryPoints,
  });
  await writeFile(resolve(jsonPath), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(buildSecurityBaselineReport(result));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    const code = error?.code || "security-baseline-unavailable";
    process.stdout.write(buildSecurityBaselineFailureReport(error));
    console.error(`Automated security baseline failed [${code}]`);
    process.exitCode = 2;
  });
}
