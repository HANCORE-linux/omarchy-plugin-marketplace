import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import {
  addRegistrySource,
  assertApprovedIssueBody,
  assertRightsConfirmation,
  canApprove,
  createRegistrySource,
  hasRightsConfirmation,
  isLegacySubmission,
  parseApprovableSubmission,
  parseSubmissionBody,
  rightsStatement,
} from "../scripts/approve-submission.mjs";
import {
  assertRecoverableCatalogError,
  CatalogCheckError,
  discoveredPlugins,
  isListedPlugin,
  manifestFieldLimits,
  maximumManifestVersionLength,
  optimizePreviewBuffer,
  parseGitHubRepository,
  previewCardLimit,
  previewDetailLimit,
  previewFileBase,
  previewPixelLimit,
  validateManifest,
  validatePreviewMetadata,
} from "../scripts/build-catalog.mjs";
import { extractRepositoryUrl } from "../scripts/validate-submission.mjs";
import {
  allowedCategories,
  allowedTags,
  classifySubmission,
  maximumSubmissionTags,
  parseCurrentSubmission,
  parseIssueSubmission,
  predatesRightsConfirmation,
  submissionChecklist,
} from "../scripts/submission.mjs";
import {
  appendSearchState,
  applySearchCompletion,
  committedTermsFromDraft,
  createSearchTerm,
  currentSearchToken,
  fuzzyScore,
  handleSearchEscape,
  inlineSearchCompletionSuffix,
  matchesCommittedSearchTerm,
  matchesDraftSearchTerm,
  matchesShortSearch,
  maximumSearchTermLength,
  parseSearchDraft,
  rankSearchCompletions,
  readSearchState,
  removeSearchTermTypeFromDraft,
  searchKeyAction,
  searchTermKey,
  searchTokens,
  selectSearchCompletions,
  uniqueSearchTerms,
} from "../site/assets/js/search.js";
import {
  findCopyLabel,
  showCopiedState,
  writeClipboard,
} from "../site/assets/js/shared.js";

function contrastRatio(first, second) {
  const luminance = (hex) => {
    const normalized = hex.slice(1).length === 3
      ? [...hex.slice(1)].map((value) => value.repeat(2)).join("")
      : hex.slice(1);
    const channels = [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255)
      .map((value) => value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function submissionBody({
  repo = "https://github.com/example/omarchy-plugin.git",
  category = "Developer Tools",
  tags = "Launcher, Quickshell, Quickshell",
  suggestedTag = "_No response_",
  includeSuggestedTag = true,
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
    ...(includeSuggestedTag ? [
      "### Suggest a missing tag",
      "",
      suggestedTag,
      "",
    ] : []),
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

test("completion selection preserves genuine prefixes across result types", () => {
  const selected = selectSearchCompletions([
    { type: "plugin", value: "Hardware", label: "Hardware", count: 1, score: 0, prefix: true },
    { type: "plugin", value: "Home", label: "Home", count: 1, score: 0, prefix: true },
    { type: "plugin", value: "Hypr Panel", label: "Hypr Panel", count: 1, score: 0, prefix: true },
    { type: "tag", value: "hyprland", label: "hyprland", count: 4, score: 0, prefix: true },
  ]);
  assert.equal(selected.length, 3);
  assert.ok(selected.some(({ type, value }) => type === "tag" && value === "hyprland"));
});

test("search tokens support multi-word matching and current-token completion", () => {
  assert.deepEqual(searchTokens("  AirVPN   system "), ["airvpn", "system"]);
  assert.equal(currentSearchToken("airvpn sys"), "sys");
  assert.equal(currentSearchToken("airvpn "), "");
});

test("short searches find terms within plugin names and tags", () => {
  assert.equal(matchesShortSearch(
    "vpn",
    "AirVPN spacexrace.airvpn system bar",
    "AirVPN status and country selection",
  ), true);
  assert.equal(matchesShortSearch(
    "vpn",
    "OpenFortiVPN murphi.openfortivpn bar security",
    "FortiVPN client integration",
  ), true);
  assert.equal(matchesShortSearch(
    "vpn",
    "Unrelated plugin productivity launcher",
    "A command palette for applications",
  ), false);
});

test("inline completion accepts genuine plugin, tag, and author prefixes", () => {
  assert.equal(inlineSearchCompletionSuffix(
    { type: "plugin", value: "AirVPN" },
    "Air",
  ), "VPN");
  assert.equal(inlineSearchCompletionSuffix(
    { type: "tag", value: "quickshell" },
    "quicks",
  ), "hell");
  assert.equal(inlineSearchCompletionSuffix(
    { type: "author", value: "spaceXrace" },
    "@space",
  ), "Xrace");
  assert.equal(inlineSearchCompletionSuffix(
    { type: "plugin", value: "AirVPN" },
    "VPN",
  ), "");
  assert.equal(inlineSearchCompletionSuffix(
    { type: "author", value: "spaceXrace" },
    "space",
  ), "");
});

test("typed committed chips use exact field-specific matching", () => {
  const plugin = {
    publisher: "spaceXrace",
    primaryText: "Power Profiles power-management bar",
    searchText: "Power Profiles controls power profiles and a bar widget",
    tags: ["power-management", "bar"],
    pluginName: "Power Profiles",
    pluginId: "dizziee.power-profiles",
  };
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("text", "Power Profiles"), plugin), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("text", "Power Other Profiles"), plugin), false);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("tag", "bar"), plugin), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("tag", "widget"), plugin), false);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("author", "@spaceXrace"), plugin), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("author", "space"), plugin), false);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("plugin", "Power Profiles"), plugin), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("plugin", "dizziee.power-profiles"), plugin), true);
  assert.equal(matchesDraftSearchTerm(createSearchTerm("tag", "pow"), plugin), true);
  assert.equal(matchesDraftSearchTerm(createSearchTerm("author", "space"), plugin), true);
  assert.equal(matchesDraftSearchTerm(createSearchTerm("plugin", "Power P"), plugin), true);
});

test("typed terms normalize, parse, and deduplicate by type and value", () => {
  assert.deepEqual(parseSearchDraft("vpn tag:bar author:@spaceXrace"), [
    { type: "text", value: "vpn" },
    { type: "tag", value: "bar" },
    { type: "author", value: "spaceXrace" },
  ]);
  assert.deepEqual(parseSearchDraft("plugin:Power Profiles"), [
    { type: "plugin", value: "Power Profiles" },
  ]);
  assert.deepEqual(parseSearchDraft("tag: author: @bad_login @foo- @foo--bar"), [
    { type: "text", value: "tag:" },
    { type: "text", value: "author:" },
    { type: "text", value: "@bad_login" },
    { type: "text", value: "@foo-" },
    { type: "text", value: "@foo--bar" },
  ]);
  assert.equal(
    removeSearchTermTypeFromDraft("vpn tag:bar @spaceXrace", "author"),
    "vpn tag:bar",
  );
  assert.deepEqual(uniqueSearchTerms([
    { type: "text", value: "bar" },
    { type: "tag", value: "bar" },
    { type: "tag", value: "BAR" },
  ]), [
    { type: "text", value: "bar" },
    { type: "tag", value: "bar" },
  ]);
  assert.notEqual(
    searchTermKey({ type: "text", value: "bar" }),
    searchTermKey({ type: "tag", value: "bar" }),
  );
});

test("chip URL state preserves ordered typed terms and the live draft", () => {
  const terms = [
    { type: "text", value: "VPN" },
    { type: "tag", value: "bar" },
    { type: "author", value: "spaceXrace" },
    { type: "plugin", value: "jkoestinger.vpn" },
    { type: "text", value: "bar" },
  ];
  const params = appendSearchState(new URLSearchParams(), { terms, draft: "@JJD" });
  assert.equal(params.toString(), "q=VPN&tag=bar&author=spaceXrace&plugin=jkoestinger.vpn&q=bar&draft=%40JJD");
  assert.deepEqual(readSearchState(params), { terms, draft: "@JJD" });
  assert.deepEqual(readSearchState(new URLSearchParams(
    "q=VPN&q=vpn&q=%40spaceXrace&q=tag%3Abar&tag=bar&unknown=x&draft=one&draft=two"
  )), {
    terms: [
      { type: "text", value: "VPN" },
      { type: "author", value: "spaceXrace" },
      { type: "text", value: "tag:bar" },
      { type: "tag", value: "bar" },
    ],
    draft: "one",
  });
  const oversizedDraft = "x".repeat(maximumSearchTermLength + 1);
  const oversizedParams = appendSearchState(new URLSearchParams(), {
    terms: [],
    draft: oversizedDraft,
  });
  assert.equal(oversizedParams.has("draft"), false);
  assert.equal(readSearchState(new URLSearchParams(`draft=${oversizedDraft}`)).draft, "");
});

test("Fish completion creates typed current-token and stable plugin terms", () => {
  const system = { type: "tag", value: "system", label: "system" };
  const powerProfiles = {
    type: "plugin",
    value: "dizziee.power-profiles",
    label: "Power Profiles",
    insertValue: "Power Profiles",
  };
  const openCodeUsage = {
    type: "plugin",
    value: "dizziee.opencode-model-usage",
    label: "OpenCode Usage",
    insertValue: "OpenCode Usage",
  };
  assert.equal(applySearchCompletion("airvpn sys", system), "airvpn system");
  assert.equal(inlineSearchCompletionSuffix(system, "airvpn sys"), "tem");
  assert.deepEqual(committedTermsFromDraft("airvpn sys", system), [
    { type: "text", value: "airvpn" },
    { type: "tag", value: "system" },
  ]);
  assert.equal(applySearchCompletion("Power P", powerProfiles), "Power Profiles");
  assert.equal(inlineSearchCompletionSuffix(powerProfiles, "Power P"), "rofiles");
  assert.deepEqual(committedTermsFromDraft("Power P", powerProfiles), [
    { type: "plugin", value: "dizziee.power-profiles" },
  ]);
  assert.deepEqual(committedTermsFromDraft("vpn Power P", powerProfiles), [
    { type: "text", value: "vpn" },
    { type: "plugin", value: "dizziee.power-profiles" },
  ]);
  assert.equal(applySearchCompletion("vpn OpenCode U", openCodeUsage), "vpn OpenCode Usage");
  assert.deepEqual(committedTermsFromDraft("vpn OpenCode U", openCodeUsage), [
    { type: "text", value: "vpn" },
    { type: "plugin", value: "dizziee.opencode-model-usage" },
  ]);
  assert.deepEqual(committedTermsFromDraft("vpn bar"), [
    { type: "text", value: "vpn" },
    { type: "text", value: "bar" },
  ]);
});

test("search keeps the raw query until a completion is explicitly accepted", () => {
  const defaults = {
    completionCount: 3,
    activeSuggestion: -1,
    caretAtEnd: true,
    hasInlineCompletion: true,
  };
  assert.equal(searchKeyAction({ ...defaults, key: "Enter" }), "submit-query");
  assert.equal(searchKeyAction({ ...defaults, key: "Tab" }), "none");
  assert.equal(searchKeyAction({ ...defaults, key: "ArrowRight" }), "accept-inline-completion");
  assert.equal(searchKeyAction({
    ...defaults,
    key: "ArrowRight",
    hasInlineCompletion: false,
  }), "none");
  assert.equal(searchKeyAction({
    ...defaults,
    key: "Enter",
    activeSuggestion: 0,
  }), "accept-active-completion");
  assert.equal(searchKeyAction({ ...defaults, key: "ArrowDown" }), "next-completion");
  assert.equal(searchKeyAction({ ...defaults, key: "ArrowUp" }), "previous-completion");
});

test("copy feedback targets the visible label instead of a decorative icon", () => {
  const explicitLabel = {};
  const explicitQueries = [];
  assert.equal(findCopyLabel({
    querySelector(selector) {
      explicitQueries.push(selector);
      return selector === "[data-copy-label]" ? explicitLabel : {};
    },
  }), explicitLabel);
  assert.deepEqual(explicitQueries, ["[data-copy-label]"]);

  const fallbackLabel = {};
  assert.equal(findCopyLabel({
    querySelector(selector) {
      return selector === "[data-copy-label]" ? null : fallbackLabel;
    },
  }), fallbackLabel);
});

test("repeated copy feedback restores the original label after the last click", async () => {
  const label = { textContent: "Copy" };
  const classes = new Set();
  const icon = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };
  showCopiedState(label, icon, 80);
  assert.equal(label.textContent, "Copied");
  assert.equal(classes.has("is-copied"), true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  showCopiedState(label, icon, 80);
  await new Promise((resolve) => setTimeout(resolve, 65));
  assert.equal(label.textContent, "Copied");
  assert.equal(classes.has("is-copied"), true);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(label.textContent, "Copy");
  assert.equal(classes.has("is-copied"), false);
});

test("clipboard fallback reports the actual copy result", async () => {
  let removed = false;
  const area = {
    style: {},
    select() {},
    remove() { removed = true; },
  };
  const documentRef = {
    body: { append() {} },
    createElement: () => area,
    execCommand: () => false,
  };
  assert.equal(await writeClipboard("command", {
    clipboard: { writeText: async () => { throw new Error("blocked"); } },
    documentRef,
  }), false);
  assert.equal(removed, true);
  documentRef.execCommand = () => true;
  assert.equal(await writeClipboard("command", {
    clipboard: { writeText: async () => { throw new Error("blocked"); } },
    documentRef,
  }), true);
  assert.equal(await writeClipboard("command", {
    clipboard: { writeText: async () => {} },
    documentRef: undefined,
  }), true);
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
  assert.match(files.index, /id="search-input"[^>]*role="combobox"[^>]*aria-autocomplete="both"/);
  assert.doesNotMatch(files.index, /id="author-filter"|id="author-select"/);
  assert.match(files.index, /id="search-clear"[^>]*aria-label="Clear all search terms"/);
  assert.match(files.index, /id="search-terms"[^>]*aria-label="Active search terms"/);
  assert.match(files.index, /id="search-suggestions"[\s\S]*role="listbox"/);
  assert.match(files.index, /id="search-fish-preview"/);
  assert.match(files.plugin, /<title>Plugin Details \| Omarchy Plugins<\/title>/);
  assert.match(files.plugin, /class="skip-link" href="#plugin-detail"/);
  assert.match(files.publish, /<title>Publish a Plugin \| Omarchy Plugins<\/title>/);
  assert.match(files.publish, /class="skip-link" href="#main-content"/);
  assert.match(files.index, /<h2 id="recent-title">RECENTLY ADDED<\/h2>/);
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
  assert.match(files.app, /!catalog \|\| !Array\.isArray\(catalog\.plugins\)/);
  assert.match(files.app, /sourcePointCount = 6000/);
  assert.match(files.app, /"ORIGINAL"[\s\S]*"COCOON"[\s\S]*"STORM"[\s\S]*"RAY"[\s\S]*"BIRD"[\s\S]*"WING"/);
  assert.match(files.app, /runVisibleAnimation\(frame, draw, 30\)/);
  assert.match(files.app, /const pluginsPerPage = 9/);
  assert.match(files.app, /\["updated", "Recent activity"\]/);
  assert.match(files.app, /updated: \(a, b\) => activityTime\(b\) - activityTime\(a\)/);
  assert.match(files.app, /function publisherLogin\(plugin\)/);
  assert.doesNotMatch(files.app, /function exactPublisher\(value\)|state\.author/);
  assert.match(files.app, /function directPluginMatch\(plugin, value\)/);
  assert.match(files.app, /function pluginMatchesActiveSearch\(plugin\)/);
  assert.match(files.searchJs, /function fuzzyScore\(query, candidate\)/);
  assert.match(files.searchJs, /function rankSearchCompletions\(matches\)/);
  assert.match(files.searchJs, /function selectSearchCompletions\(matches, limit = 3\)/);
  assert.match(files.searchJs, /function searchTokens\(value\)/);
  assert.match(files.searchJs, /function currentSearchToken\(value\)/);
  assert.match(files.searchJs, /function matchesShortSearch\(query, primaryText, searchText\)/);
  assert.match(files.searchJs, /function createSearchTerm\(type, value\)/);
  assert.match(files.searchJs, /function parseSearchDraft\(value\)/);
  assert.match(files.searchJs, /function appendSearchState\(params, \{ terms, draft \}\)/);
  assert.match(files.searchJs, /function readSearchState\(params\)/);
  assert.match(files.searchJs, /function matchesCommittedSearchTerm\(term, \{/);
  assert.match(files.searchJs, /function handleSearchEscape\(event,/);
  assert.match(files.searchJs, /function inlineSearchCompletionSuffix\(suggestion, value\)/);
  assert.match(files.searchJs, /function searchKeyAction\(\{/);
  assert.match(files.app, /function updateSearchSuggestions\(\)/);
  assert.match(files.app, /function inlineSuggestionIndex\(\)/);
  assert.match(files.app, /function updateFishPreview\(\)/);
  assert.match(files.app, /class="search-query-summary"/);
  assert.match(files.app, /tabindex="-1" aria-selected="false"/);
  assert.match(files.app, /\$\{visible\.length\} of \$\{categoryPlugins\.length\}/);
  assert.match(files.app, /state\.terms\.some\(\(term\) =>[\s\S]*matchesCommittedSearchTerm\(term, matchContext\)/);
  assert.match(files.app, /typedDraftTerms\.some\(\(term\) =>[\s\S]*matchesDraftSearchTerm\(term, matchContext\)/);
  assert.match(files.app, /return matchesTerm \|\| matchesTextDraft \|\| matchesTypedDraft/);
  assert.match(files.app, /const action = searchKeyAction\(\{/);
  assert.doesNotMatch(files.app, /\["Tab", "Enter", "ArrowRight"\]/);
  assert.match(files.app, /data-author=/);
  assert.match(files.app, /appendSearchState\(params, \{ terms: state\.terms, draft: state\.query \}\)/);
  assert.match(files.app, /readSearchState\(params\)/);
  assert.match(files.app, /const searchTermTypeLabels = \{/);
  assert.match(files.app, /class="search-term-type"/);
  assert.match(files.app, /function commitSearchDraft\(completion\)/);
  assert.match(files.app, /function clearSearchTerms\(\{ focus = true \} = \{\}\)/);
  assert.match(files.app, /function removeSearchTerm\(index\)/);
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
  assert.match(files.pluginJs, /const versionLabel = pluginVersionLabel\(plugin\)/);
  assert.match(files.pluginJs, /versionLabel\.replace\(\/\^manifest\\s\+\//);
  assert.doesNotMatch(files.publishJs, /left-sidebar \.sidebar-link\[href\^='#'\]/);
  assert.match(files.publishJs, /markerRatio: 0\.25,[\s\S]*markerMax: 160,[\s\S]*activateLastAtPageEnd: true/);
  assert.match(files.publish, /href="#overview" data-section-ids="overview requirements">Guide<\/a>/);
  const sharedJs = await readFile(new URL("site/assets/js/shared.js", root), "utf8");
  assert.match(sharedJs, /markerRatio = 0\.55,[\s\S]*markerMax = Number\.POSITIVE_INFINITY,[\s\S]*activateLastAtPageEnd = true/);
  assert.match(sharedJs, /link\.dataset\.sectionIds[\s\S]*sectionIds\.includes\(id\)/);
  assert.match(sharedJs, /window\.scrollY \+ Math\.min\(markerMax, window\.innerHeight \* markerRatio\)/);
  assert.match(sharedJs, /section\.getBoundingClientRect\(\)\.top \+ window\.scrollY/);
  assert.match(sharedJs, /\$\{current\} theme active; switch to \$\{next\} theme/);
  assert.match(sharedJs, /Copy failed\. Select and copy manually\./);
  assert.match(files.pluginJs, /title: "Catalog unavailable"/);
  assert.match(files.pluginJs, /title: "Plugin not found"/);
  assert.match(files.pluginJs, /!catalog \|\| !Array\.isArray\(catalog\.plugins\)/);
  assert.match(files.pluginJs, /item\?\.id === id/);
  const styles = await readFile(new URL("site/assets/css/style.css", root), "utf8");
  assert.doesNotMatch(files.app, /plugin-preview-(?:bar|meta)/);
  assert.match(styles, /\.plugin-card-body \.plugin-description \{[\s\S]*max-height: 42px;[\s\S]*-webkit-line-clamp: 2;/);
  assert.match(styles, /\.page-meta \.manifest-version \{ min-width: 0; overflow-wrap: anywhere; \}/);
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
  assert.doesNotMatch(styles, /\.marketplace-page \{ min-width: 320px; \}/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /\.search-token-editor \{/);
  assert.match(styles, /\.search-term \{/);
  assert.match(styles, /\.search-clear \{/);
  assert.match(styles, /\.search-suggestions \{/);
  assert.match(styles, /\.search-fish-preview \{/);
  assert.match(styles, /\.search-fish-preview \{[\s\S]*font-size: 13px;[\s\S]*font-weight: 500; line-height: 1;/);
  assert.match(styles, /\.search-query-summary, \.search-suggestion \{[\s\S]*min-height: 38px/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*\.search-query-summary, \.search-suggestion \{ min-height: 44px; \}/);
  assert.match(styles, /\.search-query-summary > span, \.search-suggestion > span \{[\s\S]*min-width: 0;[\s\S]*text-overflow: ellipsis/);
  assert.match(styles, /\.market-plugin-grid \.plugin-card, \.recent-grid \.plugin-card \{[\s\S]*display: flex;[\s\S]*flex-direction: column; gap: 0;/);
  assert.match(styles, /\.plugin-preview \{[\s\S]*height: 175px; min-height: 0;[\s\S]*flex: 0 0 175px;/);
  assert.match(styles, /\.plugin-card-body \{[\s\S]*display: flex;[\s\S]*min-width: 0;[\s\S]*flex: 1; flex-direction: column;/);
  assert.match(files.app, /<div class="plugin-card-content">[\s\S]*class="plugin-title-line"[\s\S]*\$\{authorLine\}[\s\S]*class="plugin-description"/);
  assert.match(styles, /\.plugin-card-bottom \{[\s\S]*margin-top: auto;/);
  assert.match(styles, /\.plugin-author button \{[\s\S]*z-index: 3/);
  assert.match(styles, /\.plugin-author button \{[\s\S]*min-height: 24px/);
  assert.match(styles, /\.plugin-author button:hover, \.plugin-author button:focus-visible \{ color: var\(--accent\); \}/);
  assert.match(files.index, /class="footer-status"/);
  assert.match(files.index, /HANCORE[\s\S]*OMARCHY PLUGIN MARKETPLACE[\s\S]*Independent community project\.[\s\S]*Not affiliated with, sponsored by, or endorsed by Omarchy or 37signals\.[\s\S]*GITHUB/);
  assert.doesNotMatch(files.index, /footer-tech-canvas|footer-project-canvas/);
  assert.doesNotMatch(files.app, /setupHancoreAsciiHover|setupFooterAsciiField/);
});

test("light theme text and accent surfaces meet WCAG AA contrast", async () => {
  const styles = await readFile(
    new URL("../site/assets/css/style.css", import.meta.url),
    "utf8",
  );
  const lightBlock = styles.match(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] || "";
  const value = (name) => lightBlock.match(new RegExp(`--${name}:\\s*(#[a-f0-9]+);`, "i"))?.[1];
  const background = value("bg");
  const panel = value("panel");
  const faint = value("faint");
  const accent = value("accent");
  const accentContrast = value("accent-contrast");
  for (const [foreground, surface] of [
    [faint, background],
    [faint, panel],
    [accent, background],
    [accent, panel],
    [accentContrast, accent],
  ]) {
    assert.ok(contrastRatio(foreground, surface) >= 4.5, `${foreground} on ${surface}`);
  }
});

test("mobile plugin card previews preserve complete images", async () => {
  const styles = await readFile(
    new URL("../site/assets/css/style.css", import.meta.url),
    "utf8",
  );
  const targetSelector = ".plugin-preview.image-preview img";
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({
      selectors: match[1].split(",").map((selector) => selector.trim()),
      declarations: Object.fromEntries(
        [...match[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)]
          .map((declaration) => [declaration[1], declaration[2].trim()]),
      ),
    }))
    .filter((rule) =>
      rule.selectors.some((selector) => selector.endsWith(targetSelector))
    );
  const [desktopRule, ...responsiveRules] = rules;
  const mobileRule = responsiveRules.find((rule) =>
    rule.selectors.includes(targetSelector)
    && rule.declarations["min-height"] === "0"
    && rule.declarations["object-fit"] === "contain"
  );

  assert.ok(desktopRule.selectors.includes(targetSelector));
  assert.equal(desktopRule.declarations["min-height"], undefined);
  assert.equal(desktopRule.declarations["object-fit"], "cover");
  assert.ok(mobileRule);
  for (const rule of responsiveRules) {
    if (rule.declarations["min-height"]) {
      assert.equal(rule.declarations["min-height"], "0");
    }
    if (rule.declarations["object-fit"]) {
      assert.equal(rule.declarations["object-fit"], "contain");
    }
  }
  assert.match(
    styles,
    /\.plugin-preview \{\s*height: clamp\(160px, 30vw, 220px\); flex-basis: clamp\(160px, 30vw, 220px\);\s*\}/,
  );
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
  const verify = await readFile(
    new URL(".github/workflows/verify.yml", root),
    "utf8",
  );
  assert.match(approve, /approved-for-listing/);
  assert.doesNotMatch(approve, /label\.name == 'approved'/);
  assert.match(approve, /APPROVED_ISSUE_BODY:\s+\$\{\{ github\.event\.issue\.body \}\}/);
  assert.match(
    approve,
    /name: Detect registry change[\s\S]*git diff --quiet -- registry\.json[\s\S]*changed=false[\s\S]*changed=true/,
  );
  assert.match(
    approve,
    /name: Commit and push plugin\s+if: steps\.registry\.outputs\.changed == 'true'/,
  );
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
    const checksumAt = deployJob.indexOf("name: Record catalog checksum");
    const uploadAt = deployJob.indexOf("actions/upload-pages-artifact@");
    const deployAt = deployJob.indexOf("actions/deploy-pages@");
    const confirmAt = deployJob.indexOf("name: Confirm deployed catalog after Pages timeout");
    assert.ok(checkoutAt > 0);
    assert.ok(checkoutAt < buildAt);
    assert.ok(buildAt < testAt);
    assert.ok(testAt < checksumAt);
    assert.ok(checksumAt < uploadAt);
    assert.ok(uploadAt < deployAt);
    assert.ok(deployAt < confirmAt);
    assert.match(deployJob, /id: catalog[\s\S]*sha256sum site\/catalog\.json/);
    assert.match(deployJob, /id: deployment\s+continue-on-error: true/);
    assert.match(
      deployJob,
      /if: steps\.deployment\.outcome == 'failure'[\s\S]*EXPECTED_CATALOG_SHA:[\s\S]*deployment-check=/,
    );
    assert.match(deployJob, /sha256sum "\$live_catalog"/);
    assert.doesNotMatch(deployJob, /timeout:\s+1200000/);
  }
  const approveJob = approve.slice(approve.indexOf("\n  approve:\n"), approve.indexOf("\n  deploy:\n"));
  assert.doesNotMatch(approveJob, /pages: write|id-token: write/);
  assert.match(
    approve,
    /name: Reopen approval after approval failure\s+if: needs\.approve\.result == 'failure'/,
  );
  assert.match(
    approve,
    /name: Report deployment failure\s+if: needs\.approve\.result == 'success' && needs\.deploy\.result == 'failure'/,
  );
  assert.match(approve, /Do not reapply \\`approved-for-listing\\`/);
  assert.match(
    approve,
    /name: Report finalization failure\s+if: needs\.approve\.result == 'success' && needs\.deploy\.result == 'success' && needs\.finalize\.result == 'failure'/,
  );
  assert.equal(
    (approve.match(/labels\/approved-for-listing/g) || []).length,
    1,
  );
  const refreshPermissions = refresh.slice(0, refresh.indexOf("\njobs:\n"));
  assert.doesNotMatch(refreshPermissions, /pages: write|id-token: write/);
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
  assert.match(validate, /ISSUE_CREATED_AT:\s+\$\{\{ github\.event\.issue\.created_at \}\}/);
  assert.doesNotMatch(validate, /github\.event\.label\.name == 'approved-for-listing'/);
  assert.match(verify, /pull_request:/);
  assert.match(verify, /permissions:\s+contents: read/);
  assert.match(verify, /run: npm ci/);
  assert.match(verify, /run: npm test/);
  assert.match(verify, /git diff --check/);
  assert.match(validate, /timeout-minutes:/);
  assert.match(validate, /marketplace-validation/);
  assert.match(validate, /issues\/comments\/\$\{COMMENT_ID\}/);
  assert.doesNotMatch(validate, /--edit-last/);
  for (const workflow of [approve, refresh, deploy, validate, verify]) {
    const actionUses = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    assert.ok(actionUses.length > 0);
    assert.ok(actionUses.every((action) => /@[a-f0-9]{40}$/.test(action)));
  }
  for (const workflow of [approve, refresh, deploy, validate, verify]) {
    assert.match(workflow, /run: npm ci/);
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
    tags: ["launcher", "quickshell"],
  });
  assert.throws(
    () => parseSubmissionBody(body.replace("Developer Tools", "Unlisted")),
    /Unsupported submission category/,
  );
});

test("submission tags use the curated vocabulary across web and CLI formats", () => {
  assert.deepEqual(
    parseSubmissionBody(submissionBody({
      tags: "- Bar\n- Power management\n- Quickshell",
      suggestedTag: "weather",
    })).tags,
    ["bar", "power-management", "quickshell"],
  );
  assert.deepEqual(
    parseSubmissionBody(submissionBody({
      tags: "bar-widget, power-profiles, quickapps",
      includeSuggestedTag: false,
    })).tags,
    ["bar", "power-management", "launcher"],
  );
  assert.deepEqual(
    parseSubmissionBody(submissionBody({
      tags: "command-palette, search, ai",
      includeSuggestedTag: false,
    })).tags,
    ["launcher", "ai"],
  );
  assert.throws(
    () => parseSubmissionBody(submissionBody({
      tags: "command-palette, search, quickapps, ai",
      includeSuggestedTag: false,
    })),
    /between one and 3 tags/,
  );
  assert.throws(
    () => parseSubmissionBody(submissionBody({ tags: "bar, weather" })),
    /Unsupported submission tags: weather/,
  );
  assert.throws(
    () => parseSubmissionBody(submissionBody({
      tags: allowedTags.slice(0, maximumSubmissionTags + 1).join(", "),
    })),
    /between one and 3 tags/,
  );
});

test("CLI submissions require the complete issue-form structure", () => {
  const body = submissionBody();
  assert.deepEqual(
    classifySubmission({ title: "[Plugin]: Example", body }),
    { shouldValidate: true, shouldLabel: true },
  );
  assert.deepEqual(
    classifySubmission({
      title: "[Plugin]: Legacy CLI",
      body: submissionBody({ includeSuggestedTag: false }),
    }),
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
    tags: ["launcher", "quickshell"],
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
    "Suggest a missing tag",
    "Maintainer notes",
    "Submission checklist",
  ]) {
    assert.match(form, new RegExp(`label: ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  for (const statement of submissionChecklist) {
    assert.ok(form.includes(`- label: ${statement}`));
  }
  assert.equal((form.match(/required: true/g) || []).length, 8);
  const tagField = form.match(
    /- type: dropdown\s+id: tags([\s\S]*?)\n  - type: input\s+id: suggested-tag/,
  )?.[1];
  assert.ok(tagField);
  assert.match(tagField, /multiple: true/);
  const formTags = [...tagField.matchAll(/^\s+- ([A-Za-z][A-Za-z ]+)$/gm)]
    .map((match) => match[1].toLowerCase().replace(/\s+/g, "-"));
  assert.deepEqual(formTags, allowedTags);
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(
    readme,
    /\[CLI and AI submission guide\]\(SUBMISSION\.md\)/,
  );
  assert.match(readme, /Choose a category and one to three tags/);

  const guide = await readFile(new URL("../SUBMISSION.md", import.meta.url), "utf8");
  const template = guide.match(
    /cat > \/tmp\/omarchy-plugin-submission\.md <<'EOF'\n([\s\S]*?)\nEOF/,
  )?.[1];
  assert.ok(template);
  const body = template
    .replace(
      "https://github.com/your_github_name/your_plugin_repository",
      "https://github.com/example/omarchy-plugin",
    )
    .replace("selected_category", "Widgets")
    .replace("selected_tag, another_selected_tag", "quickshell, bar");
  assert.deepEqual(
    parseCurrentSubmission({ title: "[Plugin]: Example", body }),
    {
      repo: "https://github.com/example/omarchy-plugin",
      category: "Widgets",
      tags: ["quickshell", "bar"],
    },
  );
  for (const category of allowedCategories) {
    assert.ok(guide.includes(`- \`${category}\``));
  }
  for (const tag of allowedTags) {
    assert.ok(guide.includes(`- \`${tag}\``));
  }
});

test("distribution rights require a checked issue-body statement", () => {
  const issue = {
    user: { login: "plugin-author" },
    body: submissionBody({
      checked: submissionChecklist.filter((statement) => statement !== rightsStatement),
    }),
  };
  assert.equal(hasRightsConfirmation(issue), false);
  assert.equal(hasRightsConfirmation({ ...issue, body: submissionBody() }), true);
  assert.equal(
    hasRightsConfirmation({
      ...issue,
      body: submissionBody().replace(
        rightsStatement,
        "I have the right to distribute this plugin and its assets under the declared license.",
      ),
    }),
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

test("approval revalidates the complete current submission", () => {
  const currentIssue = {
    created_at: "2026-08-07T00:00:00Z",
    title: "[Plugin]: Example",
    body: submissionBody({ checked: submissionChecklist.slice(0, -1) }),
  };
  assert.throws(
    () => parseApprovableSubmission(currentIssue),
    /checklist item is not confirmed/,
  );
  assert.deepEqual(
    parseApprovableSubmission({ ...currentIssue, body: submissionBody() }),
    {
      repo: "https://github.com/example/omarchy-plugin",
      category: "Developer Tools",
      tags: ["launcher", "quickshell"],
    },
  );
});

test("only submissions predating the current form receive legacy handling", () => {
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
  assert.equal(predatesRightsConfirmation(legacyIssue), true);
  assert.doesNotThrow(() => assertRightsConfirmation(legacyIssue));
  const expected = {
    repo: "https://github.com/AyushKr2003/omarchy-overview",
    category: "Appearance",
    tags: ["workspaces"],
  };
  assert.deepEqual(parseSubmissionBody(legacyIssue.body), expected);
  assert.deepEqual(parseIssueSubmission(legacyIssue), expected);
  const intermediateIssue = {
    ...legacyIssue,
    created_at: "2026-07-28T12:00:00Z",
    body: legacyIssue.body.replace(
      "- [x] The plugin does not overwrite user configuration without explicit consent.",
      `- [x] ${rightsStatement}\n- [x] The plugin does not overwrite user configuration without explicit consent.`,
    ),
  };
  assert.equal(isLegacySubmission(intermediateIssue), true);
  assert.equal(predatesRightsConfirmation(intermediateIssue), false);
  assert.doesNotThrow(() => assertRightsConfirmation(intermediateIssue));
  assert.deepEqual(parseIssueSubmission(intermediateIssue), expected);
  const freeTagIssue = {
    ...intermediateIssue,
    created_at: "2026-07-29T12:00:00Z",
    body: intermediateIssue.body.replace(
      "overviews, workspaces, previews",
      "bar, quickshell, system, ai",
    ),
  };
  assert.deepEqual(parseIssueSubmission(freeTagIssue).tags, ["bar", "quickshell", "system"]);
  const batteryIssue = {
    ...intermediateIssue,
    created_at: "2026-07-29T14:10:34Z",
    body: intermediateIssue.body.replace(
      "overviews, workspaces, previews",
      "dell, power-profiles, firmware, laptop, battery",
    ),
  };
  assert.deepEqual(parseIssueSubmission(batteryIssue).tags, ["system", "power-management"]);
  const screenshotIssue = {
    ...intermediateIssue,
    created_at: "2026-07-30T14:46:45Z",
    body: intermediateIssue.body.replace(
      "overviews, workspaces, previews",
      "screenshot",
    ),
  };
  assert.deepEqual(parseIssueSubmission(screenshotIssue).tags, ["quickshell"]);
  const unconfirmedFreeTagIssue = {
    ...freeTagIssue,
    body: freeTagIssue.body.replace(`- [x] ${rightsStatement}\n`, ""),
  };
  assert.equal(hasRightsConfirmation(unconfirmedFreeTagIssue), false);
  assert.throws(
    () => assertRightsConfirmation(unconfirmedFreeTagIssue),
    /has not confirmed/,
  );
  assert.throws(
    () => parseIssueSubmission(unconfirmedFreeTagIssue),
    /has not confirmed/,
  );
  assert.equal(isLegacySubmission({ created_at: "2026-07-30T15:04:13Z" }), false);
  assert.equal(isLegacySubmission({}), false);
});

test("approved submissions become registry sources without duplicates", () => {
  const source = createRegistrySource({
    submission: {
      repo: "https://github.com/Example/omarchy-plugin",
      category: "Desktop",
      tags: ["hyprland", "workspaces"],
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
        tags: ["hyprland", "workspaces"],
      },
      "example.switcher": {
        category: "Desktop",
        tags: ["hyprland", "workspaces"],
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
          "example.extra": { category: "Desktop", tags: ["overlay"] },
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

test("registry community tags use the curated vocabulary and selection limit", async () => {
  const registry = JSON.parse(
    await readFile(new URL("../registry.json", import.meta.url), "utf8"),
  );
  const entries = [
    ...registry.sources.flatMap((source) => [
      ...(source.catalog ? [source.catalog] : []),
      ...Object.values(source.plugins || {}),
    ]),
    ...registry.placeholders,
  ];
  for (const entry of entries) {
    assert.ok(entry.tags.length >= 1 && entry.tags.length <= maximumSubmissionTags);
    assert.ok(entry.tags.every((tag) => allowedTags.includes(tag)));
    assert.equal(new Set(entry.tags).size, entry.tags.length);
  }
});

test("catalog discovery ignores manifests added after listing approval", async () => {
  const approved = {
    schemaVersion: 1,
    id: " example.approved ",
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
    () => validateManifest(
      {
        ...manifest,
        version: "v".repeat(maximumManifestVersionLength + 1),
      },
      "manifest.json",
      { community: true },
    ),
    /version.*must not exceed 64 characters/
  );
  const maximumCommunityVersion = {
    ...manifest,
    version: "v".repeat(maximumManifestVersionLength),
  };
  assert.equal(
    validateManifest(maximumCommunityVersion, "manifest.json", { community: true }),
    maximumCommunityVersion,
  );
  const longerBuiltInVersion = {
    ...manifest,
    version: "v".repeat(maximumManifestVersionLength + 1),
  };
  assert.equal(
    validateManifest(longerBuiltInVersion, "manifest.json"),
    longerBuiltInVersion,
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

test("community manifest text is normalized and bounded", () => {
  const manifest = {
    schemaVersion: 1,
    id: "example.weather",
    name: "  Weather  ",
    version: "  1.0.0  ",
    author: "  Example  ",
    description: "  Weather in the Omarchy bar.  ",
    license: "  MIT  ",
    kinds: ["bar-widget"],
    entryPoints: { barWidget: "Widget.qml" },
  };
  const normalized = validateManifest(manifest, "manifest.json", { community: true });
  assert.equal(normalized.name, "Weather");
  assert.equal(normalized.version, "1.0.0");
  assert.equal(normalized.author, "Example");
  assert.equal(normalized.description, "Weather in the Omarchy bar.");
  assert.equal(normalized.license, "MIT");
  assert.throws(
    () => validateManifest({ ...manifest, id: "Omarchy.fake" }, "manifest.json", { community: true }),
    /lowercase/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, id: "a".repeat(manifestFieldLimits.id + 1) }, "manifest.json", { community: true }),
    /must not exceed 128 characters/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, name: "Bad\u0000Name" }, "manifest.json", { community: true }),
    /control characters/,
  );
  const paddedVersion = validateManifest(
    { ...manifest, version: `${" ".repeat(1000)}1.0.0${" ".repeat(1000)}` },
    "manifest.json",
    { community: true },
  );
  assert.equal(paddedVersion.version, "1.0.0");
});

test("only catalog check errors are recoverable source failures", () => {
  const expected = new CatalogCheckError("repository-unreachable", "offline");
  assert.equal(assertRecoverableCatalogError(expected), expected);
  assert.throws(
    () => assertRecoverableCatalogError(new TypeError("internal bug")),
    /internal bug/,
  );
});

test("preview file names remain unique for ambiguous repository slugs", () => {
  assert.notEqual(
    previewFileBase({ owner: "foo-bar", repository: "baz" }),
    previewFileBase({ owner: "foo", repository: "bar-baz" }),
  );
});

test("preview images are bounded and converted into optimized WebP variants", async () => {
  const input = await sharp({
    create: {
      width: 1920,
      height: 1080,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 1 },
    },
  }).png().toBuffer();
  const optimized = await optimizePreviewBuffer(input, {
    owner: "example",
    repository: "plugin",
    slug: "example/plugin",
  });
  assert.equal(optimized.fileBase, "7-example-plugin");
  assert.deepEqual(
    optimized.outputs.map((output) => output.fileName),
    ["7-example-plugin-card.webp", "7-example-plugin-detail.webp"],
  );
  const card = await sharp(optimized.outputs[0].buffer).metadata();
  const detail = await sharp(optimized.outputs[1].buffer).metadata();
  assert.equal(card.format, "webp");
  assert.equal(card.width, previewCardLimit);
  assert.equal(card.height, 405);
  assert.equal(detail.format, "webp");
  assert.equal(detail.width, previewDetailLimit);
  assert.equal(detail.height, 900);
  assert.equal(optimized.metadata.previewThumbnailWidth, previewCardLimit);
  assert.equal(optimized.metadata.previewWidth, previewDetailLimit);
  assert.doesNotThrow(() => validatePreviewMetadata({ format: "heif", width: 10, height: 10 }));
  assert.throws(
    () => validatePreviewMetadata({
      format: "png",
      width: previewPixelLimit,
      height: 2,
    }),
    /pixel limit/,
  );
});

test("generated source plugins retain manifest paths and local preview assets", async () => {
  const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));
  const omni = catalog.plugins.find((plugin) => plugin.id === "omni");
  const lacuna = catalog.plugins.find((plugin) => plugin.id === "lacuna.shell-suite");
  assert.equal(omni.manifestPath, "omni/manifest.json");
  assert.match(lacuna.previewImage, /^assets\/img\/plugins\/.*-detail\.webp$/);
  assert.match(lacuna.previewThumbnail, /^assets\/img\/plugins\/.*-card\.webp$/);
});
