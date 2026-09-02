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
import {
  securityBaselineErrorMarker,
  securityBaselineMarkerPrefix,
} from "../scripts/security-baseline-policy.mjs";

const root = new URL("../", import.meta.url);

function workflowJob(source, name, nextName = "") {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} job must exist`);
  const end = nextName ? source.indexOf(`\n  ${nextName}:\n`, start + 1) : -1;
  return end > start ? source.slice(start, end) : source.slice(start);
}

function workflowStep(source, name) {
  const stepMarker = `      - name: ${name}\n`;
  const stepStart = source.indexOf(stepMarker);
  assert.ok(stepStart >= 0, `${name} step must exist`);
  const nextStep = source.indexOf("\n      - name: ", stepStart + stepMarker.length);
  return source.slice(stepStart, nextStep >= 0 ? nextStep : undefined);
}

function workflowStepScript(source, name) {
  const step = workflowStep(source, name);
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

async function createIssueMutationStub(directory, issue) {
  const bin = join(directory, "bin");
  const state = join(directory, "issue.json");
  const calls = join(directory, "gh-calls.jsonl");
  await mkdir(bin);
  await writeFile(state, JSON.stringify({ ...issue, comments: [] }));
  await writeFile(join(bin, "gh"), `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(process.env.GH_STATE, "utf8"));
if (args[0] === "api" && args.includes("--method") && args.includes("DELETE")) {
  const endpoint = args.find((arg) => arg.includes("/labels/"));
  if (endpoint) {
    const label = decodeURIComponent(endpoint.slice(endpoint.lastIndexOf("/") + 1));
    state.labels = state.labels.filter((item) => item.name !== label);
    writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  }
  process.exit(0);
}
if (args[0] === "api" && args.includes("--paginate")) {
  process.exit(0);
}
if (args[0] === "api" && !args.includes("--method")) {
  process.stdout.write(JSON.stringify(state));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "edit") {
  const labelIndex = args.indexOf("--add-label");
  if (labelIndex < 0 || !args[labelIndex + 1]) process.exit(2);
  const label = args[labelIndex + 1];
  if (!state.labels.some((item) => item.name === label)) state.labels.push({ name: label });
  writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "comment") {
  const bodyIndex = args.indexOf("--body-file");
  if (bodyIndex < 0) process.exit(2);
  state.comments.push(readFileSync(args[bodyIndex + 1], "utf8"));
  writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  process.exit(0);
}
process.exit(2);
`);
  await chmod(join(bin, "gh"), 0o755);
  return { bin, calls, state };
}

test("per-issue analysis is isolated from one globally locked mutation job", async () => {
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
      failureSteps: [
        "Confirm failed run still matches the submission",
        "Clear stale approval state after workflow failure",
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
      failureSteps: [
        "Confirm failed run still matches the issue",
        "Clear stale update approval state",
        "Report plugin update workflow failure",
      ],
    },
  ];

  for (const workflow of workflows) {
    const source = await readFile(new URL(`.github/workflows/${workflow.name}`, root), "utf8");
    const analyze = workflowJob(source, workflow.analyze, workflow.mutation);
    const mutation = workflowJob(source, workflow.mutation);
    assert.doesNotMatch(source, /^concurrency:/m, workflow.name);
    assert.match(
      analyze,
      /group: issue-validation-\$\{\{ github\.event\.issue\.number \}\}[\s\S]*queue: max/,
      workflow.name,
    );
    assert.doesNotMatch(source, /queue: single/, workflow.name);
    assert.doesNotMatch(source, /\n  report-failure:\n/, workflow.name);
    assert.equal((source.match(/group: plugin-catalog-writes/g) || []).length, 1, workflow.name);
    assert.doesNotMatch(analyze, /issues: write|gh issue edit|gh issue comment|--method PATCH/);
    assert.match(
      mutation,
      /group: plugin-catalog-writes[\s\S]*cancel-in-progress: false[\s\S]*queue: max/,
      workflow.name,
    );
    assert.match(mutation, /always\(\)/, workflow.name);
    assert.doesNotMatch(mutation, /result == 'cancelled'/, workflow.name);
    const failedDependencies = workflow.analyze === "validate"
      ? ["validate"]
      : ["route", "analyze"];
    for (const dependency of failedDependencies) {
      const pattern = new RegExp(`needs\\.${dependency}\\.result == 'failure'`, "g");
      assert.equal((mutation.match(pattern) || []).length, 4, workflow.name);
    }
    for (const [index, stepName] of workflow.failureSteps.entries()) {
      const step = workflowStep(mutation, stepName);
      assert.match(step, /if: >-\s+always\(\) &&/, `${workflow.name}: ${stepName}`);
      assert.match(step, /failure\(\)/, `${workflow.name}: ${stepName}`);
      for (const dependency of failedDependencies) {
        assert.match(
          step,
          new RegExp(`needs\\.${dependency}\\.result == 'failure'`),
          `${workflow.name}: ${stepName}`,
        );
      }
      if (index > 0) {
        assert.match(
          step,
          /steps\.failure-current\.outputs\.matches == 'true'/,
          `${workflow.name}: ${stepName}`,
        );
      }
    }
    for (const step of workflow.mutationSteps) {
      assert.ok(mutation.includes(`- name: ${step}`), `${workflow.name}: ${step}`);
    }
  }
});

test("security scan limits produce a publishable error state while other baseline failures stay hard", async () => {
  const scenarios = [
    {
      workflow: "validate-submission.yml",
      report: "security-baseline-report.md",
      json: "security-baseline.json",
    },
    {
      workflow: "validate-plugin-update.yml",
      report: "update-security-baseline-report.md",
      json: "update-security-baseline.json",
    },
  ];
  const cases = [
    {
      name: "complete baseline",
      mode: "success",
      expectedStatus: 0,
      expectedOutput: "result=passed\ndisposition=clear\n",
    },
    {
      name: "scan limit",
      mode: "scan-limit",
      expectedStatus: 0,
      expectedOutput: "result=scan-error\ndisposition=\n",
    },
    {
      name: "unavailable snapshot",
      mode: "unavailable",
      expectedStatus: 2,
      expectedOutput: "",
    },
    {
      name: "scan limit with a success marker",
      mode: "wrong-marker",
      expectedStatus: 1,
      expectedOutput: "",
    },
    {
      name: "scan limit with legacy v1 error marker",
      mode: "legacy-v1-marker",
      expectedStatus: 1,
      expectedOutput: "",
    },
    {
      name: "scan limit with legacy v3 error marker",
      mode: "legacy-v3-marker",
      expectedStatus: 1,
      expectedOutput: "",
    },
    {
      name: "scan limit with unknown future error marker",
      mode: "future-marker",
      expectedStatus: 1,
      expectedOutput: "",
    },
    {
      name: "scan limit with a canonical result file",
      mode: "unexpected-json",
      expectedStatus: 1,
      expectedOutput: "",
    },
  ];

  for (const scenario of scenarios) {
    const workflow = await readFile(
      new URL(`.github/workflows/${scenario.workflow}`, root),
      "utf8",
    );
    const script = workflowStepScript(workflow, "Run automated security baseline");
    for (const item of cases) {
      const directory = await mkdtemp(join(tmpdir(), "marketplace-baseline-exit-"));
      const bin = join(directory, "bin");
      const output = join(directory, "output");
      await mkdir(bin);
      await writeFile(join(bin, "node"), `#!/bin/sh
set -eu
json=""
for argument in "$@"; do
  case "$argument" in
    --json=*) json="\${argument#--json=}" ;;
  esac
done
test -n "$json"
case "$FAKE_BASELINE_MODE" in
  success)
    printf '%s\\n' '{"outcome":"passed","verifiedPublicationDisposition":"clear"}' > "$json"
    printf '%s\\n' '${securityBaselineMarkerPrefix}e30 -->' 'Complete report'
    exit 0
    ;;
  scan-limit)
    rm -f "$json"
    printf '%s\\n' '${securityBaselineErrorMarker}' 'dist/runtime.js exceeds the limit'
    exit 3
    ;;
  unavailable)
    rm -f "$json"
    printf '%s\\n' '${securityBaselineErrorMarker}' 'Snapshot unavailable'
    exit 2
    ;;
  wrong-marker)
    rm -f "$json"
    printf '%s\\n' '${securityBaselineMarkerPrefix}e30 -->' 'Wrong report'
    exit 3
    ;;
  legacy-v1-marker)
    rm -f "$json"
    printf '%s\\n' '<!-- marketplace-security-baseline-error:v1 -->' 'Outdated report'
    exit 3
    ;;
  legacy-v3-marker)
    rm -f "$json"
    printf '%s\\n' '<!-- marketplace-security-baseline-error:v3 -->' 'Outdated report'
    exit 3
    ;;
  future-marker)
    rm -f "$json"
    printf '%s\\n' '<!-- marketplace-security-baseline-error:v99 -->' 'Unknown report'
    exit 3
    ;;
  unexpected-json)
    printf '%s\\n' '{}' > "$json"
    printf '%s\\n' '${securityBaselineErrorMarker}' 'Unexpected result file'
    exit 3
    ;;
  *) exit 99 ;;
esac
`);
      await chmod(join(bin, "node"), 0o755);
      try {
        const execution = runWorkflowScript(script, {
          cwd: directory,
          env: {
            FAKE_BASELINE_MODE: item.mode,
            GITHUB_OUTPUT: output,
            PATH: `${bin}:${process.env.PATH}`,
          },
        });
        assert.equal(
          execution.status,
          item.expectedStatus,
          `${scenario.workflow}, ${item.name}: ${execution.stderr}`,
        );
        const actualOutput = await readFile(output, "utf8").catch(() => "");
        assert.equal(actualOutput, item.expectedOutput, `${scenario.workflow}, ${item.name}`);
        assert.equal(
          await readFile(join(directory, scenario.report), "utf8").then(() => true, () => false),
          true,
          `${scenario.workflow}, ${item.name}`,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("security scan-limit reports publish fail-closed without retaining trust labels", async () => {
  const scenarios = [
    {
      workflow: "validate-submission.yml",
      verifyStep: "Verify analyzed validation reports",
      publishStep: "Publish automated security baseline",
      labelsStep: "Update validation labels",
      reportsDirectory: "validation-reports",
      validationReport: "validation-report.md",
      baselineReport: "security-baseline-report.md",
      title: "[Plugin]: Example",
      body: "Submission body",
      retainedLabel: "submission",
      extraTrustLabels: [],
    },
    {
      workflow: "validate-plugin-update.yml",
      verifyStep: "Verify analyzed update reports",
      publishStep: "Publish update security baseline",
      labelsStep: "Update plugin update labels",
      reportsDirectory: "plugin-update-reports",
      validationReport: "update-validation-report.md",
      baselineReport: "update-security-baseline-report.md",
      title: "[Verify]: Example",
      body: "Update body",
      retainedLabel: "plugin-update",
      extraTrustLabels: ["maintainer-verified"],
    },
  ];

  for (const scenario of scenarios) {
    const workflow = await readFile(
      new URL(`.github/workflows/${scenario.workflow}`, root),
      "utf8",
    );
    const verifyScript = workflowStepScript(workflow, scenario.verifyStep);
    const publishScript = workflowStepScript(workflow, scenario.publishStep);
    const labelsScript = workflowStepScript(workflow, scenario.labelsStep);
    const directory = await mkdtemp(join(tmpdir(), "marketplace-baseline-publication-"));
    const reports = join(directory, scenario.reportsDirectory);
    const baselineReport = [
      securityBaselineErrorMarker,
      "## Automated security baseline",
      "",
      "The static scan could not safely process `dist/runtime.js` within its configured limits.",
      "",
    ].join("\n");
    try {
      await createReportArtifact(reports, {
        [scenario.validationReport]: "Validation passed.\n",
        [scenario.baselineReport]: baselineReport,
      });
      const verify = runWorkflowScript(verifyScript, {
        cwd: directory,
        env: {
          BASELINE_DISPOSITION: "",
          BASELINE_RESULT: "scan-error",
          RUNNER_TEMP: directory,
          VALIDATION_RESULT: "validated",
        },
      });
      assert.equal(verify.status, 0, `${scenario.workflow}: ${verify.stderr}`);

      const staleLabels = [
        scenario.retainedLabel,
        "validated",
        "approved-and-verified",
        "approved-for-listing",
        ...scenario.extraTrustLabels,
        "security-needs-fixes",
        "security-review-required",
      ];
      const stub = await createIssueMutationStub(directory, {
        state: "open",
        title: scenario.title,
        body: scenario.body,
        labels: staleLabels.map((name) => ({ name })),
      });
      const mutationEnv = {
        BASELINE_DISPOSITION: "",
        BASELINE_RESULT: "scan-error",
        EXPECTED_BODY: scenario.body,
        EXPECTED_TITLE: scenario.title,
        GH_CALLS: stub.calls,
        GH_STATE: stub.state,
        GITHUB_REPOSITORY: "example/marketplace",
        ISSUE_NUMBER: "42",
        PATH: `${stub.bin}:${process.env.PATH}`,
        RESULT: "validated",
        RUNNER_TEMP: directory,
      };
      const publish = runWorkflowScript(publishScript, { cwd: directory, env: mutationEnv });
      assert.equal(publish.status, 0, `${scenario.workflow}: ${publish.stderr}`);
      const labels = runWorkflowScript(labelsScript, { cwd: directory, env: mutationEnv });
      assert.equal(labels.status, 0, `${scenario.workflow}: ${labels.stderr}`);

      const state = JSON.parse(await readFile(stub.state, "utf8"));
      assert.deepEqual(
        state.labels.map(({ name }) => name).sort(),
        [scenario.retainedLabel, "needs-fixes"].sort(),
        scenario.workflow,
      );
      assert.equal(state.comments.length, 1, scenario.workflow);
      assert.equal(state.comments[0], baselineReport, scenario.workflow);
      assert.match(state.comments[0], /dist\/runtime\.js/);
      assert.doesNotMatch(state.comments[0], /marketplace-security-baseline:v[0-9]+ /);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("hard analysis failures clear stale trust and publish one guarded report", async () => {
  const scenarios = [
    {
      workflow: "validate-submission.yml",
      clearStep: "Clear stale approval state after workflow failure",
      reportStep: "Report validation workflow failure",
      retainedLabel: "submission",
      staleLabels: [
        "validated",
        "approved-and-verified",
        "approved-for-listing",
        "security-needs-fixes",
        "security-review-required",
      ],
      marker: "<!-- marketplace-validation -->",
      reason: "The automated security baseline did not complete.",
      action: "A maintainer must review the workflow.",
    },
    {
      workflow: "validate-plugin-update.yml",
      clearStep: "Clear stale update approval state",
      reportStep: "Report plugin update workflow failure",
      retainedLabel: "plugin-update",
      staleLabels: [
        "validated",
        "needs-fixes",
        "approved-and-verified",
        "approved-for-listing",
        "maintainer-verified",
        "security-needs-fixes",
        "security-review-required",
      ],
      marker: "<!-- marketplace-update-workflow-status -->",
      reason: "The automated security baseline did not complete.",
      action: "",
    },
  ];

  for (const scenario of scenarios) {
    const workflow = await readFile(
      new URL(`.github/workflows/${scenario.workflow}`, root),
      "utf8",
    );
    const clearScript = workflowStepScript(workflow, scenario.clearStep);
    const reportScript = workflowStepScript(workflow, scenario.reportStep);
    const directory = await mkdtemp(join(tmpdir(), "marketplace-hard-failure-"));
    try {
      const stub = await createIssueMutationStub(directory, {
        labels: [scenario.retainedLabel, ...scenario.staleLabels].map((name) => ({ name })),
      });
      const env = {
        FAILURE_ACTION: scenario.action,
        FAILURE_REASON: scenario.reason,
        GH_CALLS: stub.calls,
        GH_STATE: stub.state,
        GITHUB_REPOSITORY: "example/marketplace",
        ISSUE_NUMBER: "42",
        PATH: `${stub.bin}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        RUN_URL: "https://github.test/actions/runs/123",
      };
      const clear = runWorkflowScript(clearScript, { cwd: directory, env });
      assert.equal(clear.status, 0, `${scenario.workflow}: ${clear.stderr}`);
      const report = runWorkflowScript(reportScript, { cwd: directory, env });
      assert.equal(report.status, 0, `${scenario.workflow}: ${report.stderr}`);

      const state = JSON.parse(await readFile(stub.state, "utf8"));
      assert.deepEqual(state.labels, [{ name: scenario.retainedLabel }], scenario.workflow);
      assert.equal(state.comments.length, 1, scenario.workflow);
      assert.match(state.comments[0], new RegExp(scenario.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(state.comments[0], new RegExp(scenario.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const calls = (await readFile(stub.calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        calls.filter((args) => args[0] === "issue" && args[1] === "comment").length,
        1,
        scenario.workflow,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("plugin update failure guard rejects a changed current issue", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/validate-plugin-update.yml", root),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Confirm failed run still matches the issue");
  for (const [name, issue, matches] of [
    ["current", { state: "open", title: "[Verify]: Example", body: "Update body" }, true],
    ["edited", { state: "open", title: "[Verify]: Example", body: "Changed" }, false],
    ["closed", { state: "closed", title: "[Verify]: Example", body: "Update body" }, false],
    [
      "pull request",
      {
        state: "open",
        title: "[Verify]: Example",
        body: "Update body",
        pull_request: { url: "https://api.github.test/pulls/1" },
      },
      false,
    ],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "marketplace-update-failure-guard-"));
    const bin = join(directory, "bin");
    const issuePath = join(directory, "issue.json");
    const outputPath = join(directory, "output");
    await mkdir(bin);
    await writeFile(issuePath, JSON.stringify(issue));
    await writeFile(join(bin, "gh"), "#!/bin/sh\ncat \"$ISSUE_JSON\"\n");
    await chmod(join(bin, "gh"), 0o755);
    try {
      const execution = runWorkflowScript(script, {
        cwd: directory,
        env: {
          EXPECTED_BODY: "Update body",
          EXPECTED_TITLE: "[Verify]: Example",
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "example/marketplace",
          ISSUE_JSON: issuePath,
          ISSUE_NUMBER: "42",
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
      assert.equal(execution.status, 0, `${name}: ${execution.stderr}`);
      assert.equal(await readFile(outputPath, "utf8"), `matches=${matches}\n`, name);
    } finally {
      await rm(directory, { recursive: true, force: true });
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
      disposition: "",
      expectedStatus: 0,
    },
    {
      name: "valid accepted submission",
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": `${securityBaselineMarkerPrefix}e30 -->\nbaseline\n`,
      },
      result: "validated",
      baseline: "passed",
      disposition: "clear",
      expectedStatus: 0,
    },
    {
      name: "valid scan-limit report",
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": `${securityBaselineErrorMarker}\nscan limit\n`,
      },
      result: "validated",
      baseline: "scan-error",
      disposition: "",
      expectedStatus: 0,
    },
    {
      name: "scan-limit result with success marker",
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": `${securityBaselineMarkerPrefix}e30 -->\nbaseline\n`,
      },
      result: "validated",
      baseline: "scan-error",
      disposition: "",
      expectedStatus: 1,
    },
    {
      name: "success result with scan-limit marker",
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": `${securityBaselineErrorMarker}\nscan limit\n`,
      },
      result: "validated",
      baseline: "passed",
      disposition: "clear",
      expectedStatus: 1,
    },
    ...["v1", "v3", "v99"].map((version) => ({
      name: `scan-limit result with unsupported ${version} marker`,
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": `<!-- marketplace-security-baseline-error:${version} -->\nscan limit\n`,
      },
      result: "validated",
      baseline: "scan-error",
      disposition: "",
      expectedStatus: 1,
    })),
    {
      name: "missing baseline",
      files: { "validation-report.md": "validation\n" },
      result: "validated",
      baseline: "passed",
      disposition: "clear",
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
      disposition: "",
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
          BASELINE_DISPOSITION: item.disposition,
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
        BASELINE_DISPOSITION: "",
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
        BASELINE_DISPOSITION: "",
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
