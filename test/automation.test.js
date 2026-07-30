import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  addRegistrySource,
  assertApprovedIssueBody,
  canApprove,
  createRegistrySource,
  hasRightsConfirmation,
  isLegacySubmission,
  parseSubmissionBody,
  rightsStatement,
} from "../scripts/approve-submission.mjs";
import {
  discoveredPlugins,
  isListedPlugin,
  parseGitHubRepository,
  validateManifest,
} from "../scripts/build-catalog.mjs";
import { extractRepositoryUrl } from "../scripts/validate-submission.mjs";
import {
  classifySubmission,
  parseCurrentSubmission,
  submissionChecklist,
} from "../scripts/submission.mjs";
import {
  fuzzyScore,
  handleSearchEscape,
  rankSearchCompletions,
} from "../site/assets/js/search.js";

function submissionBody({
  repo = "https://github.com/example/omarchy-plugin.git",
  category = "Developer Tools",
  tags = "Command Palette, shell, shell",
  notes = "_No response_",
  checked = submissionChecklist,
} = {}) {
  return [
    "### Repository URL",
    "",
    repo,
    "",
    "### Category",
    "",
    category,
    "",
    "### Tags",
    "",
    tags,
    "",
    "### Maintainer notes",
    "",
    notes,
    "",
    "### Submission checklist",
    "",
    ...submissionChecklist.map((statement) =>
      `- [${checked.includes(statement) ? "x" : " "}] ${statement}`
    ),
  ].join("\n");
}

test("GitHub repository URLs are normalized and restricted", () => {
  assert.deepEqual(
    parseGitHubRepository("https://github.com/example/omarchy-plugin.git"),
    { owner: "example", repository: "omarchy-plugin", slug: "example/omarchy-plugin" }
  );
  assert.throws(() => parseGitHubRepository("http://github.com/example/plugin"), /Only public HTTPS/);
  assert.throws(() => parseGitHubRepository("https://gitlab.com/example/plugin"), /Only public HTTPS/);
  assert.throws(() => parseGitHubRepository("https://github.com/example/plugin/tree/main"), /repository root/);
});

test("search Escape closes suggestions before clearing the query", () => {
  const calls = [];
  const firstEvent = {
    key: "Escape",
    preventDefault: () => calls.push("prevent-first"),
  };
  assert.equal(handleSearchEscape(firstEvent, {
    hasSuggestions: true,
    closeSuggestions: () => calls.push("close"),
    clearSearch: () => calls.push("clear-first"),
  }), true);
  assert.deepEqual(calls, ["prevent-first", "close"]);

  const secondEvent = {
    key: "Escape",
    preventDefault: () => calls.push("prevent-second"),
  };
  assert.equal(handleSearchEscape(secondEvent, {
    hasSuggestions: false,
    closeSuggestions: () => calls.push("close-second"),
    clearSearch: () => calls.push("clear"),
  }), true);
  assert.deepEqual(calls, ["prevent-first", "close", "prevent-second", "clear"]);
});

test("plugin completions rank ahead of fuzzy tag matches", () => {
  const ranked = rankSearchCompletions([
    {
      type: "tag",
      value: "coming-soon",
      label: "coming-soon",
      count: 1,
      score: fuzzyScore("omi", "coming-soon"),
    },
    {
      type: "plugin",
      value: "Omni",
      label: "Omni",
      count: 1,
      score: fuzzyScore("omi", "Omni"),
    },
  ]);
  assert.deepEqual(ranked.map(({ label }) => label), ["Omni", "coming-soon"]);
});

test("entry modules and their shared dependency use one cache key", async () => {
  const root = new URL("../", import.meta.url);
  const files = {
    index: await readFile(new URL("site/index.html", root), "utf8"),
    plugin: await readFile(new URL("site/plugin.html", root), "utf8"),
    publish: await readFile(new URL("site/publish.html", root), "utf8"),
    app: await readFile(new URL("site/assets/js/app.js", root), "utf8"),
    searchJs: await readFile(new URL("site/assets/js/search.js", root), "utf8"),
    pluginJs: await readFile(new URL("site/assets/js/plugin.js", root), "utf8"),
    publishJs: await readFile(new URL("site/assets/js/publish.js", root), "utf8"),
  };
  const keys = [
    files.index.match(/app\.js\?v=([^"']+)/)?.[1],
    files.plugin.match(/plugin\.js\?v=([^"']+)/)?.[1],
    files.publish.match(/publish\.js\?v=([^"']+)/)?.[1],
    files.app.match(/shared\.js\?v=([^"']+)/)?.[1],
    files.app.match(/search\.js\?v=([^"']+)/)?.[1],
    files.pluginJs.match(/shared\.js\?v=([^"']+)/)?.[1],
    files.publishJs.match(/shared\.js\?v=([^"']+)/)?.[1],
  ];
  assert.ok(keys.every(Boolean));
  assert.equal(new Set(keys).size, 1);
  assert.match(files.index, /<title>Browse Plugins \| Omarchy Plugins<\/title>/);
  assert.match(files.index, /Browse community-built plugins for <a href="https:\/\/github\.com\/basecamp\/omarchy\/tree\/quattro"[^>]*>Omarchy Quattro<\/a>/);
  assert.match(files.index, /id="catalog-pagination"[\s\S]*id="page-previous"[\s\S]*id="page-summary"[\s\S]*id="page-next"/);
  assert.match(files.index, /placeholder="Search plugins, tags, or @authors…"/);
  assert.match(files.index, /<option value="updated">Recent activity<\/option>/);
  assert.match(files.index, /id="search-input"[^>]*role="combobox"[^>]*aria-autocomplete="list"/);
  assert.doesNotMatch(files.index, /id="author-filter"|id="author-select"/);
  assert.match(files.index, /id="search-suggestions"[\s\S]*role="listbox"/);
  assert.match(files.index, /id="search-fish-preview"/);
  assert.match(files.plugin, /<title>Plugin Details \| Omarchy Plugins<\/title>/);
  assert.match(files.publish, /<title>Publish a Plugin \| Omarchy Plugins<\/title>/);
  assert.match(files.publish, /<span>3 min read<\/span>/);
  assert.equal((files.publish.match(/class="docs-section"/g) || []).length, 3);
  assert.match(files.publish, /<details class="manifest-reference">/);
  assert.doesNotMatch(files.publish, /id="review"|class="review-flow"|step-number">04/);
  assert.match(files.pluginJs, /document\.title = `\$\{plugin\.name\} \| Omarchy Plugins`/);
  assert.match(files.pluginJs, /<section class="listing-checks" aria-labelledby="listing-checks-title">/);
  assert.match(files.pluginJs, /sectionSelector: "#detail-content \.plugin-detail-article > \[id\]"/);
  assert.match(files.pluginJs, /Compatibility[\s\S]*Last checked[\s\S]*check\.commitLabel[\s\S]*Listing snapshot[\s\S]*Branch[\s\S]*Upstream changes/);
  assert.match(files.pluginJs, /\/compare\/\$\{plugin\.listingValidatedCommit\}\.\.\.\$\{plugin\.upstreamObservedCommit\}/);
  assert.doesNotMatch(files.pluginJs, /Listing provenance/);
  assert.match(files.index, /class="market-hero-ray"[\s\S]*<canvas width="400" height="300" aria-hidden="true"><\/canvas>/);
  assert.match(files.app, /function setupHeroRay\(\)/);
  assert.match(files.app, /sourcePointCount = 6000/);
  assert.match(files.app, /"ORIGINAL"[\s\S]*"COCOON"[\s\S]*"STORM"[\s\S]*"RAY"[\s\S]*"BIRD"[\s\S]*"WING"/);
  assert.match(files.app, /runVisibleAnimation\(frame, draw, 30\)/);
  assert.match(files.app, /const pluginsPerPage = 9/);
  assert.match(files.app, /\["updated", "Recent activity"\]/);
  assert.match(files.app, /updated: \(a, b\) => activityTime\(b\) - activityTime\(a\)/);
  assert.match(files.app, /function publisherLogin\(plugin\)/);
  assert.match(files.app, /function exactPublisher\(value\)/);
  assert.match(files.app, /function directPluginMatch\(plugin, value\)/);
  assert.match(files.searchJs, /function fuzzyScore\(query, candidate\)/);
  assert.match(files.searchJs, /function rankSearchCompletions\(matches\)/);
  assert.match(files.searchJs, /function handleSearchEscape\(event,/);
  assert.match(files.app, /function updateSearchSuggestions\(\)/);
  assert.match(files.app, /function updateFishPreview\(\)/);
  assert.match(files.app, /\["Tab", "Enter", "ArrowRight"\]/);
  assert.match(files.app, /data-author=/);
  assert.match(files.app, /params\.set\("author", state\.author\)/);
  assert.match(files.app, /params\.get\("author"\)/);
  assert.match(files.app, /visible\.slice\(pageState\.start, pageState\.end\)/);
  assert.match(files.app, /if \(state\.page > 1\) params\.set\("page", String\(state\.page\)\)/);
  assert.match(files.app, /history\[historyMode === "push" \? "pushState" : "replaceState"\]/);
  assert.match(files.app, /window\.addEventListener\("popstate"/);
  assert.match(files.app, /firstResult\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(files.app, /pagination\.hidden = totalItems === 0 \|\| pageState\.totalPages <= 1/);
  assert.match(files.app, /new MutationObserver\(\(\) => \{[\s\S]*updateColors\(\);[\s\S]*if \(reducedMotion\) window\.requestAnimationFrame\(\(now\) => draw\(now\)\)/);
  assert.match(files.publishJs, /sectionSelector: "#overview, \.docs-section"/);
  assert.doesNotMatch(files.plugin, /<div class="sidebar-group"><div class="sidebar-group-title">Plugin<\/div>/);
  assert.doesNotMatch(files.pluginJs, /install-nav-link|left-sidebar \.sidebar-link\[href\^='#'\]/);
  assert.doesNotMatch(files.publishJs, /left-sidebar \.sidebar-link\[href\^='#'\]/);
  assert.match(files.publishJs, /markerRatio: 0\.25,[\s\S]*markerMax: 160,[\s\S]*activateLastAtPageEnd: true/);
  assert.match(files.publish, /href="#overview" data-section-ids="overview requirements">Guide<\/a>/);
  const sharedJs = await readFile(new URL("site/assets/js/shared.js", root), "utf8");
  assert.match(sharedJs, /markerRatio = 0\.55,[\s\S]*markerMax = Number\.POSITIVE_INFINITY,[\s\S]*activateLastAtPageEnd = true/);
  assert.match(sharedJs, /link\.dataset\.sectionIds[\s\S]*sectionIds\.includes\(id\)/);
  assert.match(sharedJs, /window\.scrollY \+ Math\.min\(markerMax, window\.innerHeight \* markerRatio\)/);
  assert.match(sharedJs, /section\.getBoundingClientRect\(\)\.top \+ window\.scrollY/);
  const styles = await readFile(new URL("site/assets/css/style.css", root), "utf8");
  assert.match(styles, /\.plugin-preview-bar \{[\s\S]*height: 26px;[\s\S]*font-size: 11px; font-weight: 650;/);
  assert.match(styles, /\.plugin-card-link:focus-visible \{ outline-offset: -2px; \}/);
  assert.match(styles, /\.page-header::before \{[\s\S]*linear-gradient\(90deg, transparent, var\(--line\) 12%, var\(--line\) 88%, transparent\)/);
  assert.doesNotMatch(styles, /\.page-header::after/);
  assert.match(styles, /\.detail-section::before \{[\s\S]*linear-gradient\(90deg, transparent, var\(--line\) 12%, var\(--line\) 88%, transparent\)/);
  assert.doesNotMatch(styles, /\.detail-section::after/);
  assert.doesNotMatch(styles, /\.docs-section \+ \.docs-section::(?:before|after)/);
  assert.match(styles, /\.manifest-reference summary \{/);
  assert.match(styles, /\.manifest-reference summary::after \{[\s\S]*content: "→"/);
  assert.match(styles, /\.manifest-reference\[open\] summary::after \{ transform: rotate\(90deg\); \}/);
  assert.match(styles, /\.aside-link \{[\s\S]*border-left: 2px solid var\(--line\)/);
  assert.match(styles, /\.listing-check-row \{[\s\S]*grid-template-columns: minmax\(130px, \.8fr\) minmax\(0, 1\.2fr\)/);
  assert.match(styles, /\.pagination-summary \{[\s\S]*color: var\(--muted\)/);
  assert.match(styles, /\.pagination-direction \{[\s\S]*color: var\(--muted\)/);
  assert.doesNotMatch(styles, /\.author-bar|\.author-select-wrap/);
  assert.match(styles, /\.market-search input::-webkit-search-cancel-button/);
  assert.match(styles, /\.search-suggestions \{/);
  assert.match(styles, /\.search-fish-preview \{/);
  assert.match(styles, /\.search-fish-preview \{[\s\S]*font-size: 13px;[\s\S]*font-weight: 500; line-height: 1;/);
  assert.match(styles, /\.search-suggestion \{[\s\S]*min-height: 38px/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*\.search-suggestion \{ min-height: 44px; \}/);
  assert.match(styles, /\.search-suggestion > span \{[\s\S]*min-width: 0;[\s\S]*text-overflow: ellipsis/);
  assert.match(styles, /\.plugin-author button \{[\s\S]*z-index: 3/);
  assert.match(styles, /\.plugin-author button \{[\s\S]*min-height: 24px/);
  assert.match(styles, /\.plugin-author button:hover, \.plugin-author button:focus-visible \{ color: var\(--accent\); \}/);
  assert.match(files.index, /class="footer-status"/);
  assert.match(files.index, /HANCORE[\s\S]*OMARCHY PLUGIN MARKETPLACE[\s\S]*Independent community project\.[\s\S]*Not affiliated with, sponsored by, or endorsed by Omarchy or 37signals\.[\s\S]*GITHUB/);
  assert.doesNotMatch(files.index, /footer-tech-canvas|footer-project-canvas/);
  assert.doesNotMatch(files.app, /setupHancoreAsciiHover|setupFooterAsciiField/);
});

test("automation deploys refreshed catalogs and uses listing-specific approval", async () => {
  const root = new URL("../", import.meta.url);
  const approve = await readFile(
    new URL(".github/workflows/approve-submission.yml", root),
    "utf8",
  );
  const refresh = await readFile(
    new URL(".github/workflows/refresh-catalog.yml", root),
    "utf8",
  );
  const deploy = await readFile(
    new URL(".github/workflows/deploy-pages.yml", root),
    "utf8",
  );
  const validate = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  assert.match(approve, /approved-for-listing/);
  assert.doesNotMatch(approve, /label\.name == 'approved'/);
  assert.match(approve, /APPROVED_ISSUE_BODY:\s+\$\{\{ github\.event\.issue\.body \}\}/);
  assert.match(approve, /git diff --cached --quiet/);
  assert.match(refresh, /actions\/upload-pages-artifact@/);
  assert.match(refresh, /actions\/deploy-pages@/);
  for (const workflow of [approve, refresh]) {
    assert.match(
      workflow,
      /group: plugin-catalog-writes\s+cancel-in-progress: false\s+queue: max/,
    );
  }
  for (const workflow of [approve, refresh, deploy]) {
    assert.match(
      workflow,
      /group: github-pages-deployments\s+cancel-in-progress: false\s+queue: max/,
    );
  }
  for (const workflow of [approve, refresh, deploy]) {
    const deployStart = workflow.indexOf("\n  deploy:\n");
    assert.ok(deployStart > 0);
    const followingJob = workflow.slice(deployStart + 1).search(/\n  [a-z][a-z0-9-]*:\n/i);
    const deployJob = followingJob < 0
      ? workflow.slice(deployStart)
      : workflow.slice(deployStart, deployStart + 1 + followingJob);
    assert.doesNotMatch(workflow.slice(0, deployStart), /actions\/upload-pages-artifact@/);
    assert.match(deployJob, /group: github-pages-deployments/);
    assert.match(deployJob, /ref: main/);
    const checkoutAt = deployJob.indexOf("actions/checkout@");
    const buildAt = deployJob.indexOf("run: npm run build");
    const testAt = deployJob.indexOf("run: npm test");
    const uploadAt = deployJob.indexOf("actions/upload-pages-artifact@");
    const deployAt = deployJob.indexOf("actions/deploy-pages@");
    assert.ok(checkoutAt > 0);
    assert.ok(checkoutAt < buildAt);
    assert.ok(buildAt < testAt);
    assert.ok(testAt < uploadAt);
    assert.ok(uploadAt < deployAt);
  }
  for (const workflow of [approve, refresh, deploy]) {
    assert.ok(workflow.indexOf("run: npm run build") < workflow.indexOf("run: npm test"));
  }
  assert.match(validate, /group: validate-submission-\$\{\{ github\.event\.issue\.number \}\}/);
  assert.match(validate, /types: \[opened, edited, reopened, labeled\]/);
  assert.match(validate, /github\.event\.label\.name == 'submission'/);
  assert.match(validate, /node scripts\/intake-submission\.mjs/);
  assert.match(validate, /steps\.intake\.outputs\.should_label == 'true'/);
  assert.match(validate, /steps\.intake\.outputs\.should_validate == 'true'/);
  assert.match(validate, /ISSUE_TITLE:\s+\$\{\{ github\.event\.issue\.title \}\}/);
  assert.doesNotMatch(validate, /github\.event\.label\.name == 'approved-for-listing'/);
  assert.match(validate, /timeout-minutes:/);
  assert.match(validate, /marketplace-validation/);
  assert.match(validate, /issues\/comments\/\$\{COMMENT_ID\}/);
  assert.doesNotMatch(validate, /--edit-last/);
  for (const workflow of [approve, refresh, deploy, validate]) {
    const actionUses = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    assert.ok(actionUses.length > 0);
    assert.ok(actionUses.every((action) => /@[a-f0-9]{40}$/.test(action)));
  }
});

test("submission issue bodies yield a normalized repository URL", () => {
  const body = submissionBody();
  assert.equal(extractRepositoryUrl(body), "https://github.com/example/omarchy-plugin");
  assert.throws(
    () => extractRepositoryUrl("No repository supplied"),
    /missing the "Repository URL" field/,
  );
});

test("approval fields are parsed from the submission issue", () => {
  const body = submissionBody();

  assert.deepEqual(parseSubmissionBody(body), {
    repo: "https://github.com/example/omarchy-plugin",
    category: "Developer Tools",
    tags: ["command-palette", "shell"],
  });
  assert.throws(
    () => parseSubmissionBody(body.replace("Developer Tools", "Unlisted")),
    /Unsupported submission category/,
  );
});

test("CLI submissions require the complete issue-form structure", () => {
  const body = submissionBody();
  assert.deepEqual(
    classifySubmission({ title: "[Plugin]: Example", body }),
    { shouldValidate: true, shouldLabel: true },
  );
  assert.deepEqual(
    classifySubmission({ title: "General question", body }),
    { shouldValidate: false, shouldLabel: false },
  );
  assert.deepEqual(
    classifySubmission({
      title: "[Plugin]: Example",
      body: submissionBody({ checked: submissionChecklist.slice(0, -1) }),
    }),
    { shouldValidate: false, shouldLabel: false },
  );
  assert.deepEqual(
    classifySubmission({
      title: "Malformed labeled submission",
      body: "missing fields",
      hasSubmissionLabel: true,
    }),
    { shouldValidate: true, shouldLabel: false },
  );
  assert.throws(
    () => parseCurrentSubmission({
      title: "[Plugin]: Example",
      body: submissionBody({ checked: submissionChecklist.slice(0, -1) }),
    }),
    /checklist item is not confirmed/,
  );
  assert.deepEqual(
    classifySubmission({ title: "[Plugin]:", body }),
    { shouldValidate: false, shouldLabel: false },
  );
});

test("CLI checklist confirmation is limited to the checklist section", () => {
  const checkedInNotes = submissionChecklist.map((statement) => `- [x] ${statement}`).join("\n");
  const body = submissionBody({ notes: checkedInNotes, checked: [] });
  assert.deepEqual(
    classifySubmission({ title: "[Plugin]: Example", body }),
    { shouldValidate: false, shouldLabel: false },
  );
  assert.equal(
    hasRightsConfirmation({ user: { login: "plugin-author" }, body }),
    false,
  );
});

test("maintainer notes may contain their own Markdown headings", () => {
  const body = submissionBody({
    notes: "Installation details\n\n### Dependencies\n\nRequires jq.",
  });
  assert.deepEqual(
    classifySubmission({ title: "[Plugin]: Example", body }),
    { shouldValidate: true, shouldLabel: true },
  );
  assert.deepEqual(parseSubmissionBody(body), {
    repo: "https://github.com/example/omarchy-plugin",
    category: "Developer Tools",
    tags: ["command-palette", "shell"],
  });
});

test("shared submission rules stay aligned with the public issue form", async () => {
  const form = await readFile(
    new URL("../.github/ISSUE_TEMPLATE/submit-plugin.yml", import.meta.url),
    "utf8",
  );
  for (const heading of [
    "Repository URL",
    "Category",
    "Tags",
    "Maintainer notes",
    "Submission checklist",
  ]) {
    assert.match(form, new RegExp(`label: ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  for (const statement of submissionChecklist) {
    assert.ok(form.includes(`- label: ${statement}`));
  }
  assert.equal((form.match(/required: true/g) || []).length, 8);
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(
    readme,
    /gh issue create --repo HANCORE-linux\/omarchy-plugin-marketplace --title "\[Plugin\]: Plugin name" --body-file submission\.md/,
  );
});

test("distribution rights require a checked box or confirmation by the submitter", () => {
  const issue = {
    user: { login: "plugin-author" },
    body: submissionBody({
      checked: submissionChecklist.filter((statement) => statement !== rightsStatement),
    }),
  };
  assert.equal(hasRightsConfirmation(issue), false);
  assert.equal(
    hasRightsConfirmation(issue, [{
      user: { login: "someone-else" },
      body: rightsStatement,
    }]),
    false,
  );
  assert.equal(
    hasRightsConfirmation(issue, [{
      user: { login: "plugin-author" },
      body: `Confirmed: ${rightsStatement}`,
    }]),
    true,
  );
  assert.equal(
    hasRightsConfirmation({ ...issue, body: submissionBody() }),
    true,
  );
  assert.equal(
    hasRightsConfirmation(issue, [{
      user: { login: "plugin-author" },
      body: "I have the right to distribute this plugin and its assets under the declared license.",
    }]),
    true,
  );
});

test("only maintainers with write access can approve submissions", () => {
  for (const permission of ["write", "maintain", "admin"]) {
    assert.equal(canApprove(permission), true);
  }
  for (const permission of ["read", "triage", "none", undefined]) {
    assert.equal(canApprove(permission), false);
  }
});

test("approval processes exactly the issue body seen when the label was applied", () => {
  const approved = "### Repository URL\n\nhttps://github.com/example/plugin\n";
  assert.doesNotThrow(() => assertApprovedIssueBody(approved, approved));
  assert.throws(
    () => assertApprovedIssueBody(
      approved.replace("example/plugin", "attacker/replacement"),
      approved,
    ),
    /changed after approval/,
  );
  assert.throws(
    () => assertApprovedIssueBody(`${approved}\n`, approved),
    /changed after approval/,
  );
  assert.throws(
    () => assertApprovedIssueBody(approved, undefined),
    /APPROVED_ISSUE_BODY is required/,
  );
});

test("only submissions predating the rights checkbox receive legacy handling", () => {
  const legacyIssue = {
    created_at: "2026-07-28T10:48:58Z",
    title: "[Plugin]: Omarchy Overview",
    body: [
      "### Repository URL",
      "",
      "https://github.com/AyushKr2003/omarchy-overview",
      "",
      "### Category",
      "",
      "Appearance",
      "",
      "### Tags",
      "",
      "overviews, workspaces, previews",
      "",
      "### Maintainer notes",
      "",
      "A Hyprland workspace overview plugin.",
      "",
      "### Submission checklist",
      "",
      "- [x] The repository is public and contains installation and removal instructions.",
      "- [x] I have documented the plugin license and any external dependencies.",
      "- [x] The plugin does not overwrite user configuration without explicit consent.",
      "- [x] I understand that submissions are reviewed before publication.",
    ].join("\n"),
  };
  assert.equal(isLegacySubmission(legacyIssue), true);
  assert.deepEqual(parseSubmissionBody(legacyIssue.body), {
    repo: "https://github.com/AyushKr2003/omarchy-overview",
    category: "Appearance",
    tags: ["overviews", "workspaces", "previews"],
  });
  assert.equal(isLegacySubmission({ created_at: "2026-07-28T10:59:00Z" }), false);
  assert.equal(isLegacySubmission({}), false);
});

test("approved submissions become registry sources without duplicates", () => {
  const source = createRegistrySource({
    submission: {
      repo: "https://github.com/Example/omarchy-plugin",
      category: "Desktop",
      tags: ["overview", "workspaces"],
    },
    manifests: [
      { id: "example.overview", name: "Overview" },
      { id: "example.switcher", name: "Switcher" },
    ],
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedBranch: "main",
  });

  assert.deepEqual(source, {
    repo: "https://github.com/Example/omarchy-plugin",
    type: "plugin-source",
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedBranch: "main",
    plugins: {
      "example.overview": {
        category: "Desktop",
        tags: ["overview", "workspaces"],
      },
      "example.switcher": {
        category: "Desktop",
        tags: ["overview", "workspaces"],
      },
    },
  });
  assert.deepEqual(addRegistrySource({ sources: [] }, source), { sources: [source] });
  assert.deepEqual(addRegistrySource({ sources: [source] }, source), { sources: [source] });
  assert.throws(
    () => addRegistrySource(
      { sources: [source] },
      {
        ...source,
        plugins: {
          ...source.plugins,
          "example.extra": { category: "Desktop", tags: ["extra"] },
        },
      },
    ),
    /different plugin set/,
  );
  assert.throws(
    () => addRegistrySource({ sources: [] }, source, ["example.overview"]),
    /already listed/,
  );
});

test("registry plugin IDs are an explicit publication allowlist", () => {
  const source = {
    plugins: {
      "example.approved": { category: "Desktop", tags: ["approved"] },
    },
  };
  assert.equal(isListedPlugin(source, "example.approved"), true);
  assert.equal(isListedPlugin(source, "example.added-later"), false);
  assert.equal(isListedPlugin({}, "example.added-later"), false);
});

test("catalog discovery ignores manifests added after listing approval", async () => {
  const approved = {
    schemaVersion: 1,
    id: "example.approved",
    name: "Approved",
    version: "1.0.0",
    author: "Example",
    description: "The plugin approved for marketplace listing.",
    kinds: ["overlay"],
    entryPoints: { overlay: "Main.qml" },
  };
  const addedLater = {
    ...approved,
    id: "example.added-later",
    name: "Added later",
  };
  const tree = [
    { path: "manifest.json", type: "blob", mode: "100644" },
    { path: "Main.qml", type: "blob", mode: "100644" },
    { path: "extra/manifest.json", type: "blob", mode: "100644" },
    { path: "extra/Main.qml", type: "blob", mode: "100644" },
  ];
  const context = {
    repository: { owner: "example", repository: "plugins", slug: "example/plugins" },
    commitSha: "a".repeat(40),
    tree,
    treeByPath: new Map(tree.map((entry) => [entry.path, entry])),
    metadata: {},
  };
  const source = {
    repo: "https://github.com/example/plugins",
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T12:00:00.000Z",
    plugins: {
      "example.approved": { category: "Desktop", tags: ["approved"] },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(
    JSON.stringify(String(url).includes("/extra/") ? addedLater : approved),
    { status: 200 },
  );
  try {
    const result = await discoveredPlugins(source, context, null);
    assert.deepEqual(result.map((plugin) => plugin.id), ["example.approved"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin manifests require stable marketplace identity fields", () => {
  const manifest = {
    schemaVersion: 1,
    id: "example.weather",
    name: "Weather",
    version: "1.0.0",
    author: "Example",
    description: "Weather in the Omarchy bar.",
    kinds: ["bar-widget"],
    entryPoints: { barWidget: "Widget.qml" }
  };
  assert.equal(validateManifest(manifest, "manifest.json"), manifest);
  assert.throws(
    () => validateManifest({ ...manifest, description: "" }, "manifest.json"),
    /description/
  );
  assert.throws(
    () => validateManifest({ ...manifest, kinds: "overlay" }, "manifest.json"),
    /unsupported values/
  );
  assert.throws(
    () => validateManifest({ ...manifest, schemaVersion: 0 }, "manifest.json"),
    /exactly 1/
  );
  assert.throws(
    () => validateManifest({ ...manifest, entryPoints: { barWidget: "../Outside.qml" } }, "manifest.json"),
    /safe relative paths/
  );
  assert.throws(
    () => validateManifest({ ...manifest, id: "omarchy.fake" }, "manifest.json", { community: true }),
    /reserved/
  );
  assert.throws(
    () => validateManifest({ ...manifest, entryPoints: {} }, "manifest.json"),
    /entry point/
  );
});

test("generated source plugins retain manifest paths and local preview assets", async () => {
  const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));
  const omni = catalog.plugins.find((plugin) => plugin.id === "omni");
  const lacuna = catalog.plugins.find((plugin) => plugin.id === "lacuna.shell-suite");
  assert.equal(omni.manifestPath, "omni/manifest.json");
  assert.match(lacuna.previewImage, /^assets\/img\/plugins\//);
});
