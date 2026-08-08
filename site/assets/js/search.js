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

export function replaceCurrentSearchToken(value, replacement) {
  const input = String(value || "");
  const token = currentSearchToken(input);
  return `${input.slice(0, input.length - token.length)}${replacement}`;
}

export function normalizeSearchTerm(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function uniqueSearchTerms(values) {
  const seen = new Set();
  return values.map(normalizeSearchTerm).filter((term) => {
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function appendSearchState(params, { terms, draft }) {
  terms.map(normalizeSearchTerm).filter(Boolean)
    .forEach((term) => params.append("q", term));
  const normalizedDraft = normalizeSearchTerm(draft);
  if (normalizedDraft) params.set("draft", normalizedDraft);
  return params;
}

export function readSearchState(params, { legacyAuthor = "" } = {}) {
  const terms = params.getAll("q");
  if (legacyAuthor) terms.push(`@${legacyAuthor}`);
  return {
    terms: uniqueSearchTerms(terms),
    draft: normalizeSearchTerm(params.get("draft") || ""),
  };
}

export function matchesShortSearch(query, primaryText, searchText) {
  const normalized = String(query || "").trim().replace(/^@/, "").toLocaleLowerCase();
  if (!normalized) return true;
  if (
    normalized.length >= 3
    && String(primaryText || "").toLocaleLowerCase().includes(normalized)
  ) {
    return true;
  }
  const words = String(searchText || "").toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => word.startsWith(normalized));
}

export function matchesCommittedSearchTerm(term, {
  publisher,
  primaryText,
  searchText,
}) {
  const normalized = normalizeSearchTerm(term).toLocaleLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith("@")) {
    return String(publisher || "").toLocaleLowerCase() === normalized.slice(1);
  }
  if (normalized.length > 3 || normalized.includes(" ")) {
    return String(searchText || "").toLocaleLowerCase().includes(normalized);
  }
  return matchesShortSearch(normalized, primaryText, searchText);
}

export function completionTarget(suggestion) {
  if (!suggestion) return "";
  return suggestion.type === "author" ? `@${suggestion.value}` : suggestion.value;
}

export function applySearchCompletion(value, suggestion) {
  const input = String(value || "");
  const target = completionTarget(suggestion);
  const trimmedStart = input.trimStart();
  const leadingSpace = input.slice(0, input.length - trimmedStart.length);
  if (target.toLocaleLowerCase().startsWith(trimmedStart.toLocaleLowerCase())) {
    return `${leadingSpace}${target}`;
  }
  return replaceCurrentSearchToken(input, target);
}

export function inlineSearchCompletionSuffix(suggestion, value) {
  if (!suggestion || !value) return "";
  const completed = applySearchCompletion(value, suggestion);
  if (!completed.toLocaleLowerCase().startsWith(value.toLocaleLowerCase())) return "";
  return completed.length > value.length ? completed.slice(value.length) : "";
}

export function committedTermsFromDraft(value, suggestion) {
  const draft = normalizeSearchTerm(value);
  if (!draft) return [];
  if (!suggestion) return draft.split(" ");
  const target = completionTarget(suggestion);
  if (target.toLocaleLowerCase().startsWith(draft.toLocaleLowerCase())) return [target];
  const preceding = draft.split(" ");
  preceding.pop();
  return [...preceding, target];
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
