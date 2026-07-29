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
    typeOrder[a.type] - typeOrder[b.type]
    || a.score - b.score
    || b.count - a.count
    || a.label.localeCompare(b.label)
  ));
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
