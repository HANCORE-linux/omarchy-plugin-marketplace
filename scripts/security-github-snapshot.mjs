import { SecurityBaselineError } from "./security-baseline-error.mjs";
import {
  securityBinaryProbeByteLimit,
  securityFileByteLimit,
} from "./security-baseline-limits.mjs";

export function assertFullCommitSha(value, code = "security-baseline-invalid") {
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

export async function githubJson(path, { fetchImpl, token }) {
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

export async function readSnapshotFile(repository, commitSha, entry, options) {
  if (entry.size > securityFileByteLimit) {
    if (entry.mode !== "100755") {
      return { path: entry.path, mode: entry.mode, oversized: true, size: entry.size };
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

export async function mapWithConcurrency(values, concurrency, mapper) {
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
