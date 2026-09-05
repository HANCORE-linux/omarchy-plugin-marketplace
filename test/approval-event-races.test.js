import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approvalDecisionForEvents } from "../scripts/approve-submission.mjs";
import { publicSubmissionFailure } from "../scripts/submission-feedback.mjs";

const root = new URL("../", import.meta.url);
const actor = "maintainer";
const firstTime = "2026-09-04T21:49:24Z";
const secondTime = "2026-09-04T21:50:00Z";
function transition(id, created_at, event = "labeled", login = actor) {
  return { id, created_at, event, actor: { login }, label: { name: "approved-and-verified" } };
}
const first = transition(100, firstTime);
const removed = transition(101, "2026-09-04T21:49:30Z", "unlabeled");
const second = transition(102, secondTime);
const initial = { approver: actor, expectedRequestedAt: firstTime };

function rejected(events, options = initial) {
  assert.throws(() => approvalDecisionForEvents(events, options), { code: "approval-event-invalid" });
}

test("approval admission selects only the unique trigger, and rechecks preserve its exact identity", () => {
  const events = [first, { event: "commented" }];
  const decision = approvalDecisionForEvents(events, initial);
  assert.deepEqual(decision, { eventId: 100, requestedAt: firstTime, reviewer: actor });
  assert.deepEqual(approvalDecisionForEvents(events, {
    ...initial, expectedEventId: decision.eventId, expectedRequestedAt: decision.requestedAt,
  }), decision);
  assert.deepEqual(approvalDecisionForEvents(events, {
    ...initial, expectedRequestedAt: "2026-09-04T21:49:24.000Z",
  }), decision);
});

test("an old request cannot adopt a newer approval by the same actor", () => {
  const events = [second, first, removed]; // API order must not choose the decision.
  rejected(events);
  rejected(events, { ...initial, expectedEventId: first.id });
  assert.deepEqual(approvalDecisionForEvents(events, {
    approver: actor, expectedRequestedAt: secondTime,
  }), { eventId: second.id, requestedAt: secondTime, reviewer: actor });
});

test("a removed approval and another actor cannot authorize publication", () => {
  rejected([first, removed]);
  rejected([first, removed, transition(102, secondTime, "labeled", "other-maintainer")], {
    approver: actor, expectedRequestedAt: secondTime,
  });
});

test("initial same-second approval transitions fail closed, including different actors", () => {
  for (const login of [actor, "other-maintainer"]) {
    rejected([first, transition(101, firstTime, "unlabeled", login), transition(102, firstTime)]);
  }
  rejected([first, transition(99, firstTime, "unlabeled")]);
  // A later transition with a larger ID must invalidate an already selected ID too.
  rejected([first, transition(101, firstTime, "unlabeled"), transition(102, firstTime)], {
    ...initial, expectedEventId: first.id,
  });
});

test("missing, malformed and ambiguous approval identity never fall back to latest", () => {
  for (const options of [
    {}, { approver: actor }, { ...initial, expectedRequestedAt: "" },
    { ...initial, expectedRequestedAt: "2026-02-30T21:49:24Z" },
    { ...initial, expectedRequestedAt: "2026-09-04T21:49:24.001Z" },
    { ...initial, expectedRequestedAt: firstTime + "\n" },
    { ...initial, expectedRequestedAt: 1788558564000 },
    { ...initial, approver: "" }, { ...initial, approver: "other" },
    ...[0, -1, 100.5, "100", null, NaN, Number.MAX_SAFE_INTEGER + 1, 101].map((expectedEventId) => ({ ...initial, expectedEventId })),
  ]) rejected([first], options);
  for (const events of [null, {}, [], [null], [first, first],
    [{ ...first, id: "100" }], [{ ...first, id: 0 }],
    [{ ...first, created_at: "2026-02-30T21:49:24Z" }],
    [{ ...first, actor: null }], [first, { event: "unlabeled" }],
    [first, { ...removed, created_at: "bad" }],
  ]) rejected(events);
});

test("setup label changes do not become new approvals and feedback requires approval last", () => {
  // Pomodoro: approval at :24, manual-setup removed at :27. No replacement decision.
  const events = [first, { ...transition(101, "2026-09-04T21:49:27Z", "unlabeled"), label: { name: "manual-setup" } }];
  assert.equal(approvalDecisionForEvents(events, initial).eventId, first.id);
  const changed = publicSubmissionFailure({ code: "approval-label-changed" }, { phase: "approval" });
  assert.match(changed.reason, /manual-setup.*captured/);
  assert.match(changed.action, /setup labels first.*remove.*set it last/);
  const revoked = publicSubmissionFailure({ code: "approval-label-missing" }, { phase: "approval" });
  assert.match(revoked.action, /withdrawn.*Do not restore.*blockers/);
});

function stepScript(workflow, name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0);
  const next = workflow.indexOf("\n      - name:", start + 1);
  const step = workflow.slice(start, next < 0 ? undefined : next);
  const marker = "        run: |\n";
  const run = step.indexOf(marker);
  assert.ok(run >= 0);
  return step.slice(run + marker.length).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
}

test("both approval entry points bind trigger time before selecting any event", async () => {
  const workflow = await readFile(new URL(".github/workflows/approve-submission.yml", root), "utf8");
  assert.match(workflow, /github\.event_name == 'issues'[\s\S]*github\.event\.action == 'labeled'/);
  assert.match(workflow, /APPROVAL_TRIGGERED_AT: \$\{\{ github\.event\.issue\.updated_at \}\}/);
  for (const file of ["approve-submission.mjs", "approve-plugin-update.mjs"]) {
    const source = await readFile(new URL(`scripts/${file}`, root), "utf8");
    assert.match(source, /expectedRequestedAt: requiredEnvironment\("APPROVAL_TRIGGERED_AT"\)/);
    assert.match(source, /requiredEnvironment\("APPROVAL_REQUESTED_AT"\)/);
    assert.match(source, /requiredEnvironment\("APPROVAL_EVENT_ID"\)/);
  }
  // Preserve the original setup snapshot checks, not a relaxed live-state adoption.
  assert.equal((workflow.match(/MANUAL_SETUP: \$\{\{ contains\(github.event.issue.labels.\*.name, 'manual-setup'\) \}\}/g) || []).length, 3);
  assert.match(workflow, /has_manual_setup.*EXPECTED_MANUAL_SETUP/);
});

test("the final write-token recheck rejects a withdrawal after publication preparation", async () => {
  const workflow = await readFile(new URL(".github/workflows/approve-submission.yml", root), "utf8");
  const script = stepScript(
    workflow,
    "Recheck mutable approval state and push tested plugin publication",
  );
  assert.doesNotMatch(script, /git add|git commit|git fetch/);
  assert.match(script, /commits\/HEAD[\s\S]*push origin HEAD:main/);
  const directory = await mkdtemp(join(tmpdir(), "approval-final-push-race-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const ghCalls = join(directory, "gh-calls.jsonl");
    const gitCalls = join(directory, "git-calls.jsonl");
    await writeFile(ghCalls, "");
    await writeFile(gitCalls, "");
    await writeFile(join(bin, "gh"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
if (args[0] !== "api") process.exit(91);
const endpoint = args.find((arg) => arg.startsWith("repos/"));
if (endpoint === "repos/example/marketplace/issues/3380") {
  console.log(JSON.stringify({
    state: "open", title: "[Plugin]: Example", body: "approved body",
    labels: ["submission", "validated", "approved-and-verified"].map((name) => ({ name })),
  }));
} else if (endpoint === "repos/example/marketplace/issues/3380/events?per_page=100") {
  console.log(JSON.stringify([[
    { id: 100, event: "labeled", label: { name: "approved-and-verified" }, actor: { login: "maintainer" }, created_at: "${firstTime}" },
    { id: 101, event: "unlabeled", label: { name: "approved-and-verified" }, actor: { login: "maintainer" }, created_at: "2026-09-04T21:49:30Z" },
  ]]));
} else process.exit(92);
`);
    await writeFile(join(bin, "git"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.GIT_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`);
    await chmod(join(bin, "gh"), 0o755);
    await chmod(join(bin, "git"), 0o755);
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail"], {
      input: script, encoding: "utf8", timeout: 10000, cwd: directory,
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: directory,
        GH_TOKEN: "inert-token", GITHUB_TOKEN: "inert-token",
        GH_CALLS: ghCalls, GIT_CALLS: gitCalls, GITHUB_OUTPUT: join(directory, "output"),
        GITHUB_REPOSITORY: "example/marketplace", ISSUE_NUMBER: "3380",
        APPROVED_ISSUE_TITLE: "[Plugin]: Example", APPROVED_ISSUE_BODY: "approved body",
        EXPECTED_MANUAL_SETUP: "false", APPROVER_LOGIN: actor,
        APPROVAL_EVENT_ID: "100", APPROVAL_REQUESTED_AT: firstTime,
        BASELINE_COMMENT_ID: "200", BASELINE_COMMENT_UPDATED_AT: "2026-09-04T21:40:01Z",
        SUBMISSION_REPOSITORY: "example/plugin", APPROVED_COMMIT: "a".repeat(40),
        PUBLICATION_KIND: "listing", EXPECTED_BASE_COMMIT: "b".repeat(40),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approved-and-verified label event changed before publication/i);
    assert.doesNotMatch(await readFile(gitCalls, "utf8"), /push/);
    const calls = (await readFile(ghCalls, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes("repos/example/marketplace/issues/3380/events?per_page=100"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure reporting cannot clear a newer approval or overwrite a newer report", async () => {
  const workflow = await readFile(new URL(".github/workflows/approve-submission.yml", root), "utf8");
  const script = stepScript(workflow, "Report actionable snapshot publication failure");
  const directory = await mkdtemp(join(tmpdir(), "approval-failure-race-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const statePath = join(directory, "state.json");
    const callsPath = join(directory, "calls.jsonl");
    const stub = join(bin, "gh");
    await writeFile(stub, `#!${process.execPath}
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(process.env.GH_STATE, "utf8"));
// Only an append-only historical comment is permitted. Any API deletion/patch fails.
if (args[0] !== "issue" || args[1] !== "comment" || args[2] !== "3380" || args[3] !== "--body-file" || args.length !== 5) process.exit(91);
state.comments.push(readFileSync(args[4], "utf8"));
writeFileSync(process.env.GH_STATE, JSON.stringify(state));
`);
    await chmod(stub, 0o755);
    for (const phase of ["approve", "publish", "deploy", "finalize"]) {
      const current = {
        approvalEvent: second,
        labels: ["submission", "validated", "approved-and-verified"],
        comments: ["Newer run B succeeded; do not overwrite this status."],
        registry: { commit: "b".repeat(40) },
      };
      await writeFile(statePath, JSON.stringify(current));
      await writeFile(callsPath, "");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail"], {
        input: script, encoding: "utf8", timeout: 10000, cwd: directory,
        env: {
          PATH: `${bin}:/usr/bin:/bin`, HOME: directory,
          GH_TOKEN: "", GITHUB_TOKEN: "", GH_STATE: statePath, GH_CALLS: callsPath,
          RUNNER_TEMP: directory, GITHUB_RUN_ID: "33922836925", ISSUE_NUMBER: "3380",
          GITHUB_REPOSITORY: "example/marketplace", GH_REPO: "example/marketplace",
          RUN_URL: "https://github.com/example/marketplace/actions/runs/33922836925",
          APPROVE_RESULT: phase === "approve" ? "failure" : "success",
          PUBLISH_RESULT: phase === "publish" ? "failure" : "success",
          DEPLOY_RESULT: phase === "deploy" ? "failure" : "success",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const after = JSON.parse(await readFile(statePath, "utf8"));
      assert.deepEqual({ ...after, comments: after.comments.slice(0, 1) }, current);
      assert.equal(after.comments.length, 2);
      const report = after.comments[1];
      assert.match(report, /marketplace-publication-run:33922836925/);
      assert.match(report, /historical run report/);
      assert.match(report, /not any later approval or publication/);
      if (["approve", "publish"].includes(phase)) {
        assert.match(report, /approval was withdrawn.*do not restore/);
        assert.match(report, /remove any remaining.*set it last/);
      } else {
        assert.match(report, /Do not reapply/);
        assert.doesNotMatch(report, /set it last/);
      }
      const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].slice(0, 3), ["issue", "comment", "3380"]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful finalization preserves historical reports from multiple runs", async () => {
  const workflow = await readFile(new URL(".github/workflows/approve-submission.yml", root), "utf8");
  const finalize = workflow.slice(workflow.indexOf("\n  finalize:\n"), workflow.indexOf("\n  report-failure:\n"));
  assert.doesNotMatch(finalize, /marketplace-publication-status|clear-status|--method DELETE/);
  const directory = await mkdtemp(join(tmpdir(), "approval-finalize-history-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const statePath = join(directory, "state.json");
    const historical = ["100", "102"].map((id) => `<!-- marketplace-publication-status -->\n<!-- marketplace-publication-run:${id} -->\nHistorical failure.`);
    await writeFile(statePath, JSON.stringify({ comments: historical, labels: ["submission", "validated", "approved-and-verified"], closed: false }));
    const stub = join(bin, "gh");
    await writeFile(stub, `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.GH_STATE, "utf8"));
if (args[0] === "api" && args.includes("--paginate")) {
  const query = args[args.indexOf("--jq") + 1];
  if (!query.includes('contains("<!-- marketplace-publication -->")')) process.exit(91);
  process.exit(0); // No existing success comment; both historical comments remain.
}
if (args[0] !== "issue" || args[2] !== "3380") process.exit(92);
if (args[1] === "edit" && args[3] === "--add-label" && args[4] === "listed") state.labels.push("listed");
else if (args[1] === "comment" && args[3] === "--body-file") state.comments.push(readFileSync(args[4], "utf8"));
else if (args[1] === "close" && args[3] === "--reason" && args[4] === "completed") state.closed = true;
else process.exit(93);
writeFileSync(process.env.GH_STATE, JSON.stringify(state));
`);
    await chmod(stub, 0o755);
    for (const step of finalize.split("      - name: ").slice(1)) {
      if (step.startsWith("Record finalization failure\n")) continue;
      const name = step.slice(0, step.indexOf("\n"));
      const script = step.includes("        run: |\n")
        ? stepScript(`      - name: ${step}`, name)
        : step.match(/        run: (.+)/)?.[1];
      assert.ok(script, name);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail"], {
        input: script, encoding: "utf8", timeout: 10000, cwd: directory,
        env: {
          PATH: `${bin}:/usr/bin:/bin`, HOME: directory,
          GH_STATE: statePath, GH_TOKEN: "", GITHUB_TOKEN: "", RUNNER_TEMP: directory,
          GITHUB_REPOSITORY: "example/marketplace", ISSUE_NUMBER: "3380",
          PLUGIN_ID: "example.plugin", PLUGIN_NAME_MARKDOWN: "Example",
          VERIFICATION_METHOD: "automated", PUBLICATION_KIND: "listing",
        },
      });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
    const after = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(after.comments.slice(0, 2), historical);
    assert.equal(after.comments.length, 3);
    assert.match(after.comments[2], /<!-- marketplace-publication -->/);
    assert.equal(after.closed, true);
    assert.ok(after.labels.includes("approved-and-verified"));
    assert.ok(after.labels.includes("listed"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
