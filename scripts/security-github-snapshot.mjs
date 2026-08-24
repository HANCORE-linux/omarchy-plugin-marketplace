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
    "Accept-Encoding": "identity",
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

const binaryAssetExtensions = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jfif",
  ".jpe",
  ".jpeg",
  ".jpg",
  ".jxl",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

export function isBinaryAssetPath(path) {
  const basename = String(path || "").replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() || "";
  const extensionAt = basename.lastIndexOf(".");
  return extensionAt > 0 && binaryAssetExtensions.has(basename.slice(extensionAt));
}

function startsWithBytes(buffer, bytes) {
  return buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));
}

function binaryFormat(buffer) {
  if (startsWithBytes(buffer, [0x7f, 0x45, 0x4c, 0x46])) return "ELF";
  if (startsWithBytes(buffer, [0x4d, 0x5a])) return "PE";
  const magic = buffer.length >= 4 ? buffer.readUInt32BE(0) : 0;
  if (new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]).has(magic)) return "Mach-O";
  return buffer.includes(0) ? "binary" : "";
}

function assetMagicFormat(buffer) {
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "PNG";
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return "JPEG";
  if (startsWithBytes(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    || startsWithBytes(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "GIF";
  if (buffer.length >= 12
    && buffer.subarray(0, 4).equals(Buffer.from("RIFF"))
    && buffer.subarray(8, 12).equals(Buffer.from("WEBP"))) return "WEBP";
  if (startsWithBytes(buffer, [0x42, 0x4d])) return "BMP";
  if (startsWithBytes(buffer, [0x00, 0x00, 0x01, 0x00])
    || startsWithBytes(buffer, [0x00, 0x00, 0x02, 0x00])) return "ICO";
  if (startsWithBytes(buffer, [0x49, 0x49, 0x2a, 0x00])
    || startsWithBytes(buffer, [0x4d, 0x4d, 0x00, 0x2a])) return "TIFF";
  if (startsWithBytes(buffer, [0xff, 0x0a])
    || (buffer.length >= 12
      && buffer.subarray(4, 8).equals(Buffer.from("JXL "))
      && buffer.subarray(8, 12).equals(Buffer.from([0x0d, 0x0a, 0x87, 0x0a])))) return "JXL";
  if (buffer.length >= 12
    && buffer.subarray(4, 8).equals(Buffer.from("ftyp"))
    && /^(avif|avis|heic|heix|hevc|mif1|msf1)$/u.test(buffer.subarray(8, 12).toString("ascii"))) return "HEIF";
  return "";
}

function containsSuspiciousText(buffer) {
  const text = buffer.toString("utf8");
  return /\b(?:curl|wget|fetch|aria2c|git|cargo|make|gmake|cmake|ninja|meson|gradle|mvn|go|python(?:3)?|perl|ruby|node|bash|sh|zsh|fish|sudo|su|apt(?:-get)?|dnf|pacman|paru|yay|zypper|apk|pipx?|npm|pnpm|yarn|bun|systemctl|systemd-run|kill|pkill|rm|mv|cp|install|tee|chmod|chown|mount|umount|wg-quick|busybox|eval|exec)\b/iu.test(text);
}

function containsReadableTextRun(buffer, minimumLength = 16) {
  let runLength = 0;
  for (const byte of buffer) {
    if (byte === 0x09 || (byte >= 0x20 && byte <= 0x7e)) {
      runLength += 1;
      if (runLength >= minimumLength) return true;
    } else {
      runLength = 0;
    }
  }
  return false;
}

function looksLikeTextPayload(buffer) {
  if (!buffer.includes(0x0a) && !buffer.includes(0x0d)) return false;
  let printable = 0;
  for (const byte of buffer) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) {
      printable += 1;
    }
  }
  return printable / Math.max(buffer.length, 1) >= 0.6;
}

function containsReadableLine(buffer, minimumLength = 8) {
  let line = [];
  const check = () => {
    if (line.length < minimumLength) return false;
    const printable = line.filter((byte) => byte === 0x09 || (byte >= 0x20 && byte <= 0x7e));
    if (printable.length !== line.length) return false;
    return line.some((byte) => byte >= 0x41 && byte <= 0x5a || byte >= 0x61 && byte <= 0x7a)
      && line.some((byte) => byte === 0x09 || byte === 0x20 || byte === 0x2f || byte === 0x3b || byte === 0x7c);
  };
  for (const byte of buffer) {
    if (byte === 0x0a || byte === 0x0d) {
      if (check()) return true;
      line = [];
    } else if (line.length <= 256) {
      line.push(byte);
    }
  }
  return check();
}

function completeAssetFormat(buffer, format) {
  if (format === "PNG") {
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const chunkEnd = offset + 12 + length;
      if (chunkEnd > buffer.length) return false;
      const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
      offset = chunkEnd;
      if (type === "IEND") return length === 0 && offset === buffer.length;
    }
    return false;
  }
  if (format === "WEBP") {
    if (buffer.length < 12 || buffer.readUInt32LE(4) + 8 !== buffer.length) return false;
    let offset = 12;
    while (offset < buffer.length) {
      if (offset + 8 > buffer.length) return false;
      const length = buffer.readUInt32LE(offset + 4);
      offset += 8 + length + (length % 2);
    }
    return offset === buffer.length;
  }
  if (format === "JPEG") return buffer.length >= 4 && buffer.subarray(-2).equals(Buffer.from([0xff, 0xd9]));
  if (format === "GIF") return buffer.at(-1) === 0x3b;
  if (format === "BMP") return buffer.length >= 6 && buffer.readUInt32LE(2) === buffer.length;
  // Unsupported or container-like image formats remain in the text scan. A
  // prefix signature alone is never sufficient to exclude a complete file.
  return false;
}

function binaryAssetFormat(buffer) {
  const format = assetMagicFormat(buffer);
  if (format && !completeAssetFormat(buffer, format)) return "";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (!text.includes("\0")) return "";
    return containsSuspiciousText(buffer)
      || containsReadableTextRun(buffer)
      || containsReadableLine(buffer)
      || looksLikeTextPayload(buffer)
      ? ""
      : (format || binaryFormat(buffer));
  } catch {
    // Invalid UTF-8 without a clear asset signature is ambiguous and remains scannable.
    if (
      !format
      || containsSuspiciousText(buffer)
      || containsReadableTextRun(buffer)
      || containsReadableLine(buffer)
      || looksLikeTextPayload(buffer)
    ) return "";
    return format;
  }
}

async function readSnapshotResponse(repository, commitSha, entry, { fetchImpl }, range = "", probeLimit = securityBinaryProbeByteLimit) {
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
    await cancelResponseBody(response);
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      `Snapshot file ${entry.path} returned ${response.status}`,
      { path: entry.path },
    );
  }
  if (range) {
    const declaredSize = Number(entry.size);
    const expectedEnd = Math.min(declaredSize, probeLimit) - 1;
    const contentRange = String(response.headers.get("content-range") || "");
    const match = contentRange.match(/^bytes 0-(\d+)\/(\d+)$/);
    if (
      response.status !== 206
      || !Number.isSafeInteger(declaredSize)
      || declaredSize <= 0
      || !match
      || Number(match[1]) !== expectedEnd
      || Number(match[2]) !== declaredSize
    ) {
      await cancelResponseBody(response);
      throw new SecurityBaselineError(
        "security-baseline-unavailable",
        `Snapshot file ${entry.path} did not honor the bounded binary probe`,
        { path: entry.path },
      );
    }
  }
  return response;
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The body is already unavailable; the original scan error is authoritative.
  }
}

async function readWithDeadline(reader, path, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void reader.cancel().catch(() => {});
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      `Snapshot file ${path} body read timed out`,
      { path },
    );
  }
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => {});
          reject(new SecurityBaselineError(
            "security-baseline-unavailable",
            `Snapshot file ${path} body read timed out`,
            { path },
          ));
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseBody(response, maxBytes, path, { expectedLength } = {}) {
  const contentLengthHeader = response.headers.get("content-length");
  const declaredLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (
    declaredLength !== null
    && (!Number.isSafeInteger(declaredLength) || declaredLength < 0
      || declaredLength > maxBytes
      || (expectedLength !== undefined && declaredLength !== expectedLength))
  ) {
    await cancelResponseBody(response);
    throw new SecurityBaselineError(
      declaredLength > maxBytes
        ? "security-baseline-scan-limit"
        : "security-baseline-unavailable",
      declaredLength > maxBytes
        ? `${path} exceeds the static scan file-size limit`
        : `Snapshot file ${path} returned an unexpected body length`,
      { path },
    );
  }
  if (!response.body) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      `Snapshot file ${path} did not provide a readable response body`,
      { path },
    );
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + 15_000;
  try {
    while (true) {
      const { done, value } = await readWithDeadline(reader, path, deadline);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SecurityBaselineError(
          "security-baseline-scan-limit",
          `${path} exceeds the static scan file-size limit`,
          { path },
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (expectedLength !== undefined && total !== expectedLength) {
    throw new SecurityBaselineError(
      "security-baseline-unavailable",
      `Snapshot file ${path} returned an unexpected body length`,
      { path },
    );
  }
  return Buffer.concat(chunks, total);
}

export async function probeSnapshotFile(repository, commitSha, entry, options = {}) {
  const probeLimit = options.probeLimit || securityBinaryProbeByteLimit;
  if (Number(entry.size) === 0) {
    return { path: entry.path, mode: entry.mode, binary: false, size: 0, complete: true };
  }
  const response = await readSnapshotResponse(
    repository,
    commitSha,
    entry,
    options,
    `bytes=0-${probeLimit - 1}`,
    probeLimit,
  );
  const expectedLength = Math.min(Number(entry.size), probeLimit);
  const probe = await readBoundedResponseBody(response, expectedLength, entry.path, {
    expectedLength,
  });
  const format = binaryAssetFormat(probe);
  return {
    path: entry.path,
    mode: entry.mode,
    binary: Boolean(format),
    format,
    size: entry.size,
    complete: Number(entry.size) <= probeLimit,
  };
}

export async function readSnapshotFile(repository, commitSha, entry, options) {
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
    const probe = await readBoundedResponseBody(
      probeResponse,
      securityBinaryProbeByteLimit,
      entry.path,
      { expectedLength: securityBinaryProbeByteLimit },
    );
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
  const buffer = await readBoundedResponseBody(response, securityFileByteLimit, entry.path, {
    expectedLength: Number(entry.size),
  });
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
