import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);

function workflowJob(source, name, nextName = "") {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} job must exist`);
  const end = nextName ? source.indexOf(`\n  ${nextName}:\n`, start + 1) : -1;
  return end > start ? source.slice(start, end) : source.slice(start);
}

function workflowStepScript(source, name) {
  const stepMarker = `      - name: ${name}\n`;
  const stepStart = source.indexOf(stepMarker);
  assert.ok(stepStart >= 0, `${name} step must exist`);
  const nextStep = source.indexOf("\n      - name: ", stepStart + stepMarker.length);
  const step = source.slice(stepStart, nextStep >= 0 ? nextStep : undefined);
  const runMarker = "        run: |\n";
  const runStart = step.indexOf(runMarker);
  assert.ok(runStart >= 0, `${name} step must use a literal run block`);
  return step
    .slice(runStart + runMarker.length)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

function runWorkflowScript(script, { cwd, env = {} }) {
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: script,
  });
}

function checksumLine(name, content) {
  const digest = createHash("sha256").update(content).digest("hex");
  return `${digest}  ${name}\n`;
}

async function createReportArtifact(directory, files) {
  await mkdir(directory, { recursive: true });
  let checksums = "";
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content);
    checksums += checksumLine(name, content);
  }
  await writeFile(join(directory, "SHA256SUMS"), checksums);
}

test("replaceable analysis is isolated from one globally locked mutation job", async () => {
  const workflows = [
    {
      name: "validate-submission.yml",
      analyze: "validate",
      mutation: "publish",
      mutationSteps: [
        "Publish validation report",
        "Update validation labels",
        "Report validation workflow failure",
      ],
    },
    {
      name: "validate-plugin-update.yml",
      analyze: "analyze",
      mutation: "publish",
      mutationSteps: [
        "Publish update validation report",
        "Update plugin update labels",
        "Report plugin update workflow failure",
      ],
    },
  ];

  for (const workflow of workflows) {
    const source = await readFile(new URL(`.github/workflows/${workflow.name}`, root), "utf8");
    const analyze = workflowJob(source, workflow.analyze, workflow.mutation);
    const mutation = workflowJob(source, workflow.mutation);
    assert.doesNotMatch(source, /^concurrency:/m, workflow.name);
    assert.doesNotMatch(source, /\n  report-failure:\n/, workflow.name);
    assert.equal((source.match(/group: plugin-catalog-writes/g) || []).length, 1, workflow.name);
    assert.match(
      analyze,
      /group: issue-validation-\$\{\{ github\.event\.issue\.number \}\}[\s\S]*queue: single/,
      workflow.name,
    );
    assert.doesNotMatch(analyze, /issues: write|gh issue edit|gh issue comment|--method PATCH/);
    assert.match(
      mutation,
      /group: plugin-catalog-writes[\s\S]*cancel-in-progress: false[\s\S]*queue: max/,
      workflow.name,
    );
    assert.match(mutation, /always\(\)/, workflow.name);
    assert.doesNotMatch(mutation, /result == 'cancelled'/, workflow.name);
    assert.match(mutation, /id: failure-current[\s\S]*if: failure\(\)/, workflow.name);
    for (const step of workflow.mutationSteps) {
      assert.ok(mutation.includes(`- name: ${step}`), `${workflow.name}: ${step}`);
    }
  }
});

test("submission report producer creates an exact checksummed artifact", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Bundle analyzed validation reports");

  for (const files of [
    { "validation-report.md": "validation\n" },
    {
      "validation-report.md": "validation\n",
      "security-baseline-report.md": "baseline\n",
    },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "marketplace-validation-bundle-"));
    const work = join(directory, "work");
    const runnerTemp = join(directory, "runner");
    await mkdir(work);
    await mkdir(runnerTemp);
    try {
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(work, name), content);
      }
      const result = runWorkflowScript(script, {
        cwd: work,
        env: { RUNNER_TEMP: runnerTemp },
      });
      assert.equal(result.status, 0, result.stderr);
      const bundle = join(runnerTemp, "validation-reports");
      assert.deepEqual(
        (await readdir(bundle)).sort(),
        ["SHA256SUMS", ...Object.keys(files)].sort(),
      );
      const check = spawnSync("sha256sum", ["--check", "SHA256SUMS"], {
        cwd: bundle,
        encoding: "utf8",
      });
      assert.equal(check.status, 0, check.stderr);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("submission report consumer rejects tampering, links, and unexpected files", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Verify analyzed validation reports");

  const cases = [
    {
      name: "valid rejected submission",
      files: { "validation-report.md": "validation\n" },
      result: "needs-fixes",
      baseline: "",
      expectedStatus: 0,
    },
    {
      name: "valid accepted submission",
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": "baseline\n",
      },
      result: "validated",
      baseline: "passed",
      expectedStatus: 0,
    },
    {
      name: "missing baseline",
      files: { "validation-report.md": "validation\n" },
      result: "validated",
      baseline: "passed",
      expectedStatus: 1,
    },
    {
      name: "unexpected file",
      files: {
        "validation-report.md": "validation\n",
        "unexpected.txt": "unexpected\n",
      },
      result: "needs-fixes",
      baseline: "",
      expectedStatus: 1,
    },
  ];

  for (const item of cases) {
    const directory = await mkdtemp(join(tmpdir(), "marketplace-validation-reports-"));
    const reports = join(directory, "validation-reports");
    try {
      await createReportArtifact(reports, item.files);
      const execution = runWorkflowScript(script, {
        cwd: directory,
        env: {
          RUNNER_TEMP: directory,
          VALIDATION_RESULT: item.result,
          BASELINE_RESULT: item.baseline,
        },
      });
      assert.equal(execution.status, item.expectedStatus, `${item.name}: ${execution.stderr}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const tamperedDirectory = await mkdtemp(join(tmpdir(), "marketplace-validation-tampered-"));
  try {
    const reports = join(tamperedDirectory, "validation-reports");
    await createReportArtifact(reports, { "validation-report.md": "original\n" });
    await writeFile(join(reports, "validation-report.md"), "tampered\n");
    const execution = runWorkflowScript(script, {
      cwd: tamperedDirectory,
      env: {
        RUNNER_TEMP: tamperedDirectory,
        VALIDATION_RESULT: "needs-fixes",
        BASELINE_RESULT: "",
      },
    });
    assert.notEqual(execution.status, 0);
  } finally {
    await rm(tamperedDirectory, { recursive: true, force: true });
  }

  const linkedDirectory = await mkdtemp(join(tmpdir(), "marketplace-validation-linked-"));
  try {
    const reports = join(linkedDirectory, "validation-reports");
    await createReportArtifact(reports, { "validation-report.md": "validation\n" });
    await symlink("validation-report.md", join(reports, "report-link.md"));
    const execution = runWorkflowScript(script, {
      cwd: linkedDirectory,
      env: {
        RUNNER_TEMP: linkedDirectory,
        VALIDATION_RESULT: "needs-fixes",
        BASELINE_RESULT: "",
      },
    });
    assert.notEqual(execution.status, 0);
    assert.match(execution.stderr, /symbolic link/);
  } finally {
    await rm(linkedDirectory, { recursive: true, force: true });
  }
});

test("submission failure guard permits only the unchanged current issue", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Confirm failed run still matches the submission");
  const expectedTitle = "[Plugin]: Example";
  const expectedBody = "Submission body";
  const cases = [
    {
      name: "current issue",
      issue: { state: "open", title: expectedTitle, body: expectedBody, labels: [] },
      matches: true,
    },
    {
      name: "legacy submission with current label",
      expectedTitle: "Legacy submission",
      issue: {
        state: "open",
        title: "Legacy submission",
        body: expectedBody,
        labels: [{ name: "submission" }],
      },
      matches: true,
    },
    {
      name: "legacy submission after label removal",
      expectedTitle: "Legacy submission",
      issue: { state: "open", title: "Legacy submission", body: expectedBody, labels: [] },
      matches: false,
    },
    {
      name: "edited issue",
      issue: { state: "open", title: expectedTitle, body: "Edited", labels: [] },
      matches: false,
    },
    {
      name: "pull request",
      issue: {
        state: "open",
        title: expectedTitle,
        body: expectedBody,
        labels: [],
        pull_request: { url: "https://api.github.test/pulls/1" },
      },
      matches: false,
    },
    {
      name: "listed issue",
      issue: {
        state: "open",
        title: expectedTitle,
        body: expectedBody,
        labels: [{ name: "listed" }],
      },
      matches: false,
    },
  ];

  for (const item of cases) {
    const directory = await mkdtemp(join(tmpdir(), "marketplace-validation-guard-"));
    const bin = join(directory, "bin");
    const issuePath = join(directory, "issue.json");
    const outputPath = join(directory, "output");
    await mkdir(bin);
    await writeFile(issuePath, JSON.stringify(item.issue));
    await writeFile(join(bin, "gh"), "#!/bin/sh\ncat \"$ISSUE_JSON\"\n");
    await chmod(join(bin, "gh"), 0o755);
    try {
      const execution = runWorkflowScript(script, {
        cwd: directory,
        env: {
          EXPECTED_BODY: expectedBody,
          EXPECTED_TITLE: item.expectedTitle || expectedTitle,
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "example/marketplace",
          ISSUE_JSON: issuePath,
          ISSUE_NUMBER: "1",
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
      assert.equal(execution.status, 0, `${item.name}: ${execution.stderr}`);
      assert.equal(await readFile(outputPath, "utf8"), `matches=${item.matches}\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const unavailableDirectory = await mkdtemp(join(tmpdir(), "marketplace-validation-guard-error-"));
  const bin = join(unavailableDirectory, "bin");
  const outputPath = join(unavailableDirectory, "output");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "gh"), 0o755);
  try {
    const execution = runWorkflowScript(script, {
      cwd: unavailableDirectory,
      env: {
        EXPECTED_BODY: expectedBody,
        EXPECTED_TITLE: expectedTitle,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "example/marketplace",
        ISSUE_NUMBER: "1",
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    assert.notEqual(execution.status, 0);
  } finally {
    await rm(unavailableDirectory, { recursive: true, force: true });
  }
});

test("submission publication guard rejects stale current state", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Confirm analyzed issue state is still current");
  const expectedBody = "Submission body";
  const cases = [
    {
      name: "current titled submission",
      expectedTitle: "[Plugin]: Example",
      issue: { state: "open", title: "[Plugin]: Example", body: expectedBody, labels: [] },
      shouldPublish: true,
    },
    {
      name: "current legacy submission",
      expectedTitle: "Legacy submission",
      issue: {
        state: "open",
        title: "Legacy submission",
        body: expectedBody,
        labels: [{ name: "submission" }],
      },
      shouldPublish: true,
    },
    {
      name: "removed legacy submission label",
      expectedTitle: "Legacy submission",
      issue: { state: "open", title: "Legacy submission", body: expectedBody, labels: [] },
      shouldPublish: false,
    },
    {
      name: "listed submission",
      expectedTitle: "[Plugin]: Example",
      issue: {
        state: "open",
        title: "[Plugin]: Example",
        body: expectedBody,
        labels: [{ name: "listed" }],
      },
      shouldPublish: false,
    },
  ];

  for (const item of cases) {
    const directory = await mkdtemp(join(tmpdir(), "marketplace-validation-publish-guard-"));
    const bin = join(directory, "bin");
    const issuePath = join(directory, "issue.json");
    const outputPath = join(directory, "output");
    await mkdir(bin);
    await writeFile(issuePath, JSON.stringify(item.issue));
    await writeFile(join(bin, "gh"), "#!/bin/sh\ncat \"$ISSUE_JSON\"\n");
    await chmod(join(bin, "gh"), 0o755);
    try {
      const execution = runWorkflowScript(script, {
        cwd: directory,
        env: {
          EXPECTED_BODY: expectedBody,
          EXPECTED_TITLE: item.expectedTitle,
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "example/marketplace",
          ISSUE_JSON: issuePath,
          ISSUE_NUMBER: "1",
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
      assert.equal(execution.status, 0, `${item.name}: ${execution.stderr}`);
      assert.equal(
        await readFile(outputPath, "utf8"),
        `should_publish=${item.shouldPublish}\n`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const unavailableDirectory = await mkdtemp(join(tmpdir(), "marketplace-publish-guard-error-"));
  const bin = join(unavailableDirectory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "gh"), 0o755);
  try {
    const execution = runWorkflowScript(script, {
      cwd: unavailableDirectory,
      env: {
        EXPECTED_BODY: expectedBody,
        EXPECTED_TITLE: "[Plugin]: Example",
        GITHUB_OUTPUT: join(unavailableDirectory, "output"),
        GITHUB_REPOSITORY: "example/marketplace",
        ISSUE_NUMBER: "1",
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    assert.notEqual(execution.status, 0);
  } finally {
    await rm(unavailableDirectory, { recursive: true, force: true });
  }
});
