import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);
const workflowDirectory = new URL(".github/workflows/", root);
const routerUrl = new URL("route-issue-automation.yml", workflowDirectory);
const calledWorkflowNames = [
  "approve-submission.yml",
  "validate-plugin-update.yml",
  "validate-submission.yml",
  "verify-plugin.yml",
];

async function workflowSource(name) {
  return readFile(new URL(name, workflowDirectory), "utf8");
}

function workflowJob(source, name, nextName = "") {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, `${name} job must exist`);
  const end = nextName ? source.indexOf(`\n  ${nextName}:\n`, start + 1) : -1;
  return end > start ? source.slice(start, end) : source.slice(start);
}

function embeddedRouterScript(source) {
  const script = source.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)?.[1];
  assert.ok(script, "embedded router script must exist");
  return script;
}

async function routedTarget(script, {
  action = "opened",
  body = "",
  labels = [],
  labelsJson = JSON.stringify(labels),
  state = "open",
  title = "",
  isPullRequest = false,
  label = "",
  runAttempt = 1,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-issue-route-"));
  const outputPath = join(directory, "output");
  const summaryPath = join(directory, "summary");
  try {
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      encoding: "utf8",
      input: script,
      env: {
        ...process.env,
        EVENT_ACTION: action,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        ISSUE_BODY: body,
        ISSUE_LABELS: labelsJson,
        ISSUE_STATE: state,
        ISSUE_TITLE: title,
        IS_PULL_REQUEST: String(isPullRequest),
        LABEL_NAME: label,
        RUN_ATTEMPT: String(runAttempt),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = await readFile(outputPath, "utf8");
    assert.match(output, /^target=(?:ignored|publication|submission|update|verification)\n$/);
    return output.trim().slice("target=".length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("one issue router owns direct issue events", async () => {
  const names = (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml"));
  const sources = await Promise.all(names.map(async (name) => ({
    name,
    source: await workflowSource(name),
  })));
  const directIssueWorkflows = sources
    .filter(({ source }) => /^on:\n  issues:/m.test(source))
    .map(({ name }) => name);

  assert.deepEqual(directIssueWorkflows, ["route-issue-automation.yml"]);
  const router = sources.find(({ name }) => name === "route-issue-automation.yml")?.source || "";
  assert.match(router, /types: \[opened, edited, reopened, labeled, unlabeled\]/);
  assert.match(router, /^permissions: \{\}$/m);
  assert.doesNotMatch(router, /workflow_dispatch|repository_dispatch|secrets: inherit/);

  for (const name of calledWorkflowNames) {
    const source = sources.find((workflow) => workflow.name === name)?.source || "";
    assert.match(source, /^on:\n  workflow_call:/m, name);
    assert.doesNotMatch(source, /^on:\n  issues:/m, name);
    assert.match(source, /plugin-catalog-writes/, name);
    const jobs = [...source.matchAll(/^  ([a-z0-9-]+):\n/gm)].map((match) => match[1]);
    assert.ok(jobs.length > 0, `${name} must define jobs`);
    for (let index = 0; index < jobs.length; index += 1) {
      const job = workflowJob(source, jobs[index], jobs[index + 1]);
      assert.match(job, /\n    permissions:\n/, `${name}:${jobs[index]} must bound its token`);
    }
  }
});

test("router calls each existing workflow with bounded permissions", async () => {
  const router = await readFile(routerUrl, "utf8");
  const route = workflowJob(router, "route", "validate-submission");
  const submission = workflowJob(router, "validate-submission", "validate-update");
  const update = workflowJob(router, "validate-update", "verify-plugin");
  const verification = workflowJob(router, "verify-plugin", "publish-snapshot");
  const publication = workflowJob(router, "publish-snapshot");

  assert.match(route, /permissions: \{\}/);
  assert.doesNotMatch(route, /actions\/checkout|secrets\.|contents: write|issues: write/);
  assert.match(submission, /permissions:\s+actions: read\s+contents: read\s+issues: write/);
  assert.match(submission, /uses: \.\/\.github\/workflows\/validate-submission\.yml/);
  assert.match(update, /permissions:\s+actions: read\s+contents: read\s+issues: write/);
  assert.match(update, /uses: \.\/\.github\/workflows\/validate-plugin-update\.yml/);
  assert.match(verification, /permissions:\s+actions: read\s+contents: write\s+issues: write\s+pages: write\s+id-token: write/);
  assert.match(verification, /uses: \.\/\.github\/workflows\/verify-plugin\.yml/);
  assert.match(publication, /permissions:\s+contents: write\s+issues: write\s+pages: write\s+id-token: write/);
  assert.match(publication, /uses: \.\/\.github\/workflows\/approve-submission\.yml/);
});

test("router selects exactly one workflow for supported issue events", async () => {
  const router = await readFile(routerUrl, "utf8");
  const script = embeddedRouterScript(router);
  const listedBody = "### Verification action\n\nVerify the currently listed snapshot";
  const installationBody = "### Verification action\n\nVerify the listed snapshot and enable standard installation";
  const updateBody = "### Verification action\n\nVerify and publish a newer upstream commit";
  const cases = [
    [{ title: "[Plugin]: Example" }, "submission"],
    [{ action: "edited", title: "[Plugin]: Example" }, "submission"],
    [{ action: "reopened", title: "Legacy submission", labels: ["submission"] }, "submission"],
    [{ action: "labeled", title: "[Plugin]: Example", labels: ["submission"], label: "submission" }, "submission"],
    [{ title: "[Verify]: Example", body: listedBody }, "verification"],
    [{ action: "edited", title: "[Verify]: Example", body: installationBody }, "verification"],
    [{ action: "reopened", title: "[Verify]: Example", body: updateBody }, "update"],
    [{ action: "labeled", title: "[Verify]: Example", label: "maintainer-verified" }, "verification"],
    [{ action: "labeled", title: "[Verify]: Example", label: "standard-installation-approved" }, "verification"],
    [{ action: "unlabeled", state: "closed", title: "Historical review", label: "maintainer-verified" }, "verification"],
    [{ action: "labeled", title: "[Plugin]: Example", labels: ["submission", "approved-and-verified"], label: "approved-and-verified" }, "publication"],
    [{ action: "labeled", title: "[Verify]: Example", labels: ["plugin-update", "approved-and-verified"], label: "approved-and-verified" }, "publication"],
  ];

  for (const [event, expected] of cases) {
    assert.equal(await routedTarget(script, event), expected, JSON.stringify(event));
  }
});

test("router fails closed for irrelevant, malformed, ambiguous, and replayed events", async () => {
  const router = await readFile(routerUrl, "utf8");
  const script = embeddedRouterScript(router);
  const updateBody = "### Verification action\n\nVerify and publish a newer upstream commit";
  const cases = [
    { title: "Ordinary issue" },
    { state: "closed", title: "[Plugin]: Closed" },
    { title: "[Verify]: Ambiguous", body: updateBody, labels: ["submission"] },
    { title: "[Plugin]: Pull request", isPullRequest: true },
    { action: "labeled", title: "[Plugin]: Example", label: "validated" },
    { action: "labeled", title: "[Plugin]: Example", label: "approved-and-verified" },
    { action: "labeled", title: "[Plugin]: Example", labels: ["submission"], label: "approved-and-verified", runAttempt: 2 },
    { action: "labeled", title: "[Verify]: Example", label: "maintainer-verified", runAttempt: 2 },
    { action: "labeled", title: "[Verify]: Example", label: "standard-installation-approved", runAttempt: 2 },
    { action: "unlabeled", title: "[Verify]: Example", label: "validated" },
    { title: "[Plugin]: Invalid labels", labelsJson: "not-json" },
    { title: "[Plugin]: Invalid labels", labelsJson: '{"submission":true}' },
    { title: "[Plugin]: Invalid labels", labelsJson: '["submission",7]' },
  ];

  for (const event of cases) {
    assert.equal(await routedTarget(script, event), "ignored", JSON.stringify(event));
  }
});
