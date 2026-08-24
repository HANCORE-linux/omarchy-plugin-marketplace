export function fuzzyScore(query, candidate) {
  const needle = query.toLocaleLowerCase();
  const haystack = candidate.toLocaleLowerCase();
  const contiguous = haystack.indexOf(needle);
  if (contiguous >= 0) return contiguous;
  let previous = -1;
  let gaps = 0;
  for (const character of needle) {
    const position = haystack.indexOf(character, previous + 1);
    if (position < 0) return Number.POSITIVE_INFINITY;
    if (previous >= 0) gaps += position - previous - 1;
    previous = position;
  }
  return 100 + gaps;
}

export function rankSearchCompletions(matches) {
  const typeOrder = { plugin: 0, author: 1, tag: 2 };
  return [...matches].sort((a, b) => (
    Number(Boolean(b.fullPrefix)) - Number(Boolean(a.fullPrefix))
    || Number(Boolean(b.prefix)) - Number(Boolean(a.prefix))
    || (a.prefix && b.prefix
      ? (a.targetLength ?? a.label.length) - (b.targetLength ?? b.label.length)
      : 0)
    || typeOrder[a.type] - typeOrder[b.type]
    || a.score - b.score
    || b.count - a.count
    || a.label.localeCompare(b.label)
  ));
}

export function selectSearchCompletions(matches, limit = 3) {
  const ranked = rankSearchCompletions(matches);
  const selected = [];
  ["plugin", "author", "tag"].forEach((type) => {
    const prefixMatch = ranked.find((match) => match.type === type && match.prefix);
    if (prefixMatch) selected.push(prefixMatch);
  });
  ranked.forEach((match) => {
    if (selected.length < limit && !selected.includes(match)) selected.push(match);
  });
  return rankSearchCompletions(selected).slice(0, limit);
}

export function searchTokens(value) {
  return String(value || "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

export function currentSearchToken(value) {
  return String(value || "").match(/(?:^|\s)(\S*)$/)?.[1] || "";
}

const searchTermTypeList = ["text", "tag", "author", "plugin"];
const searchTermTypes = new Set(searchTermTypeList);
export const maximumSearchTerms = 24;
export const maximumSearchTermLength = 160;

export function normalizeSearchTerm(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ");
}

export function foldSearchTerm(value) {
  return normalizeSearchTerm(value).toLowerCase();
}

export function createSearchTerm(type, value) {
  const normalizedType = searchTermTypes.has(type) ? type : "text";
  let normalizedValue = normalizeSearchTerm(value);
  if (normalizedType === "author") {
    normalizedValue = normalizedValue.replace(/^@/, "");
    if (!validGitHubLogin(normalizedValue)) return null;
  }
  if (!normalizedValue || normalizedValue.length > maximumSearchTermLength) return null;
  return { type: normalizedType, value: normalizedValue };
}

export function searchTermKey(term) {
  const normalized = createSearchTerm(term?.type, term?.value);
  return normalized ? `${normalized.type}:${foldSearchTerm(normalized.value)}` : "";
}

export function searchTermDisplayValue(term) {
  const normalized = createSearchTerm(term?.type, term?.value);
  if (!normalized) return "";
  return normalized.type === "author" ? `@${normalized.value}` : normalized.value;
}

export function searchTermInputValue(term) {
  const normalized = createSearchTerm(term?.type, term?.value);
  if (!normalized) return "";
  if (normalized.type === "text") return normalized.value;
  if (normalized.type === "author") return `@${normalized.value}`;
  return `${normalized.type}:${normalized.value}`;
}

export function uniqueSearchTerms(values) {
  const seen = new Set();
  const terms = [];
  for (const value of values) {
    const term = typeof value === "string"
      ? createSearchTerm("text", value)
      : createSearchTerm(value?.type, value?.value);
    const key = searchTermKey(term);
    if (!term || !key || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === maximumSearchTerms) break;
  }
  return terms;
}

function validGitHubLogin(value) {
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(value);
}

export function parseSearchDraft(value) {
  const draft = normalizeSearchTerm(value);
  if (!draft) return [];
  const pluginExpression = draft.match(/^plugin:(.+)$/i);
  if (pluginExpression) {
    const plugin = createSearchTerm("plugin", pluginExpression[1]);
    return plugin ? [plugin] : [createSearchTerm("text", draft)].filter(Boolean);
  }
  return draft.split(" ").map((token) => {
    const typed = token.match(/^(tag|author):(.+)$/i);
    if (typed) {
      return createSearchTerm(typed[1].toLowerCase(), typed[2])
        || createSearchTerm("text", token);
    }
    if (token.startsWith("@") && validGitHubLogin(token.slice(1))) {
      return createSearchTerm("author", token);
    }
    return createSearchTerm("text", token);
  }).filter(Boolean);
}

export function appendSearchState(params, { terms, draft }) {
  uniqueSearchTerms(terms).forEach((term) => {
    const key = term.type === "text" ? "q" : term.type;
    params.append(key, term.value);
  });
  const normalizedDraft = normalizeSearchTerm(draft);
  if (normalizedDraft && normalizedDraft.length <= maximumSearchTermLength) {
    params.set("draft", normalizedDraft);
  }
  return params;
}

export function readSearchState(params) {
  const terms = [];
  const seen = new Set();
  let draft = "";
  for (const [key, value] of params.entries()) {
    if (key === "draft") {
      const candidate = normalizeSearchTerm(value);
      if (!draft && candidate.length <= maximumSearchTermLength) draft = candidate;
      continue;
    }
    const type = key === "q" ? "text" : key;
    if (!searchTermTypeList.includes(type) || terms.length >= maximumSearchTerms) continue;
    const term = key === "q" && value.startsWith("@") && validGitHubLogin(value.slice(1))
      ? createSearchTerm("author", value)
      : createSearchTerm(type, value);
    const termKey = searchTermKey(term);
    if (!term || !termKey || seen.has(termKey)) continue;
    seen.add(termKey);
    terms.push(term);
  }
  return { terms, draft };
}

export function removeSearchTermTypeFromDraft(value, type) {
  return parseSearchDraft(value)
    .filter((term) => term.type !== type)
    .map(searchTermInputValue)
    .join(" ");
}

export function matchesShortSearch(query, primaryText, searchText) {
  const normalized = foldSearchTerm(String(query || "").replace(/^@/, ""));
  if (!normalized) return true;
  if (
    normalized.length >= 3
    && foldSearchTerm(primaryText).includes(normalized)
  ) {
    return true;
  }
  const words = foldSearchTerm(searchText).split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => word.startsWith(normalized));
}

export function matchesDirectSearch(value, {
  publisher = "",
  primaryText = "",
  searchText = "",
} = {}) {
  const tokens = searchTokens(value);
  return tokens.length === 0 || tokens.every((token) => {
    if (token.startsWith("@")) {
      return foldSearchTerm(publisher).startsWith(token.slice(1));
    }
    const normalizedText = foldSearchTerm(searchText);
    if (token.length > 3) return normalizedText.includes(token);
    return matchesShortSearch(token, primaryText, searchText);
  });
}

export function matchesCommittedSearchTerm(term, {
  publisher,
  primaryText,
  searchText,
  tags = [],
  pluginName,
  pluginId,
}) {
  const normalized = createSearchTerm(term?.type, term?.value);
  if (!normalized) return false;
  const requested = foldSearchTerm(normalized.value);
  if (normalized.type === "author") return foldSearchTerm(publisher) === requested;
  if (normalized.type === "tag") {
    return tags.some((tag) => foldSearchTerm(tag) === requested);
  }
  if (normalized.type === "plugin") {
    return foldSearchTerm(pluginName) === requested || foldSearchTerm(pluginId) === requested;
  }
  if (requested.length > 3 || requested.includes(" ")) {
    return foldSearchTerm(searchText).includes(requested);
  }
  return matchesShortSearch(requested, primaryText, searchText);
}

export function matchesDraftSearchTerm(term, {
  publisher,
  tags = [],
  pluginName,
  pluginId,
}) {
  const normalized = createSearchTerm(term?.type, term?.value);
  if (!normalized || normalized.type === "text") return false;
  const requested = foldSearchTerm(normalized.value);
  if (normalized.type === "author") return foldSearchTerm(publisher).startsWith(requested);
  if (normalized.type === "tag") {
    return tags.some((tag) => foldSearchTerm(tag).startsWith(requested));
  }
  return foldSearchTerm(pluginName).startsWith(requested)
    || foldSearchTerm(pluginId).startsWith(requested);
}

export function completionTarget(suggestion) {
  if (!suggestion) return "";
  if (suggestion.type === "author") return `@${suggestion.value}`;
  return suggestion.insertValue || suggestion.label || suggestion.value;
}

function completionTargetForInput(value, suggestion) {
  const target = completionTarget(suggestion);
  const tokens = normalizeSearchTerm(value).split(" ").filter(Boolean);
  const pluginIndex = tokens.findLastIndex((token) => /^plugin:/i.test(token));
  if (suggestion?.type !== "plugin" || pluginIndex < 0) return target;
  const pluginDraft = tokens.slice(pluginIndex).join(" ");
  const pluginTarget = `plugin:${target}`;
  return pluginTarget.toLowerCase().startsWith(pluginDraft.toLowerCase())
    ? pluginTarget
    : target;
}

function completionReplacementStart(value, target) {
  const tokens = normalizeSearchTerm(value).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const suffix = tokens.slice(index).join(" ");
    if (target.toLowerCase().startsWith(suffix.toLowerCase())) return index;
  }
  return Math.max(0, tokens.length - 1);
}

export function applySearchCompletion(value, suggestion) {
  const target = completionTargetForInput(value, suggestion);
  const tokens = normalizeSearchTerm(value).split(" ").filter(Boolean);
  const replacementStart = completionReplacementStart(value, target);
  return [...tokens.slice(0, replacementStart), target].join(" ");
}

export function inlineSearchCompletionSuffix(suggestion, value) {
  if (!suggestion || !value) return "";
  const completed = applySearchCompletion(value, suggestion);
  if (!completed.toLowerCase().startsWith(value.toLowerCase())) return "";
  return completed.length > value.length ? completed.slice(value.length) : "";
}

export function committedTermsFromDraft(value, suggestion) {
  const draft = normalizeSearchTerm(value);
  if (!draft) return [];
  if (!suggestion) {
    const parsed = parseSearchDraft(draft);
    const allText = parsed.every((term) => term.type === "text");
    return parsed.length === 1 || !allText
      ? parsed
      : [createSearchTerm("text", draft)].filter(Boolean);
  }
  const selected = createSearchTerm(suggestion.type, suggestion.value);
  if (!selected) return [];
  const target = completionTargetForInput(draft, suggestion);
  if (target.toLowerCase().startsWith(draft.toLowerCase())) return [selected];
  const tokens = draft.split(" ");
  const replacementStart = completionReplacementStart(draft, target);
  return [...parseSearchDraft(tokens.slice(0, replacementStart).join(" ")), selected];
}

export function handleSearchEscape(event, {
  hasSuggestions,
  closeSuggestions,
  clearSearch,
}) {
  if (event.key !== "Escape") return false;
  event.preventDefault();
  if (hasSuggestions) {
    closeSuggestions();
  } else {
    clearSearch();
  }
  return true;
}

export function searchKeyAction({
  key,
  completionCount,
  activeSuggestion,
  caretAtEnd,
  hasInlineCompletion,
}) {
  if (completionCount > 0 && key === "ArrowDown") return "next-completion";
  if (completionCount > 0 && key === "ArrowUp") return "previous-completion";
  if (key === "Enter") {
    return activeSuggestion >= 0 ? "accept-active-completion" : "submit-query";
  }
  if (
    completionCount > 0
    && key === "ArrowRight"
    && caretAtEnd
    && hasInlineCompletion
  ) {
    return "accept-inline-completion";
  }
  return "none";
}
