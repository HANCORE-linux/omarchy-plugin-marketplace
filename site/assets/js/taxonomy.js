export function matchesKidsTaxonomy(plugin) {
  const tags = Array.isArray(plugin?.tags) ? plugin.tags : [];
  return plugin?.category === "Kids" || tags.includes("kids") || tags.includes("education");
}

export function catalogCategoryTotals(plugins) {
  const totals = new Map();
  plugins.forEach((plugin) => totals.set(plugin.category, (totals.get(plugin.category) || 0) + 1));
  const kidsTotal = plugins.filter(matchesKidsTaxonomy).length;
  if (kidsTotal) totals.set("Kids", kidsTotal);
  return totals;
}
