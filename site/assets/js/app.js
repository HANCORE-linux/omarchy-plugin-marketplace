import {
  accentColor,
  copyText,
  escapeHtml,
  formatStars,
  isRecentlyAdded,
  loadCatalog,
  setupCopyButtons,
  setupThemeToggle,
  starIcon
} from "./shared.js?v=20260728-6";

const sortOptions = {
  community: [
    ["added", "Recently added"],
    ["updated", "Recently updated"],
    ["stars", "Most starred"],
    ["name", "A–Z"]
  ],
  builtin: [
    ["name", "A–Z"],
    ["kind", "Plugin type"]
  ]
};

const state = {
  plugins: [],
  query: "",
  source: "community",
  category: "all",
  sort: "added"
};

const grid = document.querySelector("#plugin-grid");
const count = document.querySelector("#plugin-count");
const countLabel = document.querySelector("#plugin-count-label");
const empty = document.querySelector("#empty-state");
const sourcesRoot = document.querySelector("#source-filters");
const categoriesRoot = document.querySelector("#category-filters");
const search = document.querySelector("#search-input");
const sort = document.querySelector("#sort-select");

function sourcePlugins() {
  return state.plugins.filter((plugin) => (plugin.sourceType || "community") === state.source);
}

function sourceDefaultSort(source = state.source) {
  return source === "builtin" ? "name" : "added";
}

function allCategoryLabel() {
  return state.source === "builtin" ? "All built-ins" : "All plugins";
}

function filteredPlugins() {
  const query = state.query.trim().toLocaleLowerCase();
  const result = sourcePlugins().filter((plugin) => {
    const matchesCategory = state.category === "all" || plugin.category === state.category;
    const haystack = [
      plugin.name,
      plugin.description,
      plugin.author,
      plugin.id,
      plugin.category,
      plugin.kind,
      ...(plugin.tags || [])
    ].join(" ").toLocaleLowerCase();
    return matchesCategory && (!query || haystack.includes(query));
  });

  const sorters = {
    added: (a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0) || a.name.localeCompare(b.name),
    updated: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
    stars: (a, b) => (b.stars || 0) - (a.stars || 0) || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    kind: (a, b) => (a.kind || "").localeCompare(b.kind || "") || a.name.localeCompare(b.name)
  };

  return result.sort(sorters[state.sort] || sorters[sourceDefaultSort()]);
}

function pluginCard(plugin, { showNew = false } = {}) {
  const tags = (plugin.tags || []).slice(0, 2).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const badge = plugin.builtIn
    ? '<span class="builtin-badge">Built-in</span>'
    : plugin.placeholder
      ? '<span class="status-badge">Coming soon</span>'
      : "";
  const newBadge = showNew && isRecentlyAdded(plugin) ? '<span class="new-badge">New</span>' : "";
  const installAction = plugin.builtIn
    ? `<a class="card-install builtin-source-action" href="${escapeHtml(plugin.sourceUrl || plugin.repo)}" target="_blank" rel="noreferrer" aria-label="View source for ${escapeHtml(plugin.name)}">View source ↗</a>`
    : plugin.placeholder
      ? '<span class="card-install unavailable" aria-label="Installation not yet available"><span class="command-glyph">›_</span> Preview only</span>'
      : `<button class="card-install" type="button" data-copy-command="${escapeHtml(plugin.installCommand)}" aria-label="Copy install command for ${escapeHtml(plugin.name)}">
          <span class="command-glyph">›_</span><span data-copy-label>Copy install</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
        </button>`;
  const preview = plugin.previewImage
    ? `<div class="plugin-preview image-preview"><img src="${escapeHtml(plugin.previewImage)}" alt="" width="${Number(plugin.previewWidth) || 1600}" height="${Number(plugin.previewHeight) || 900}" loading="lazy">
        <div class="plugin-preview-bar"><span>${escapeHtml(plugin.id)}</span><span>${escapeHtml(plugin.version)}</span></div></div>`
    : `<div class="plugin-preview" aria-hidden="true">
        <span class="plugin-preview-mark">${escapeHtml(plugin.initials)}</span>
      </div>`;
  const stars = plugin.builtIn ? "" : `<span class="card-stars" title="Repository stars">${starIcon()} ${formatStars(plugin.stars)}</span>`;

  return `
    <article class="plugin-card${plugin.builtIn ? " built-in-card" : ""}" style="--card-accent:${accentColor(plugin.accent)}">
      ${preview}
      <div class="plugin-card-body">
        <div class="plugin-title-line">
          <h3>${escapeHtml(plugin.name)}</h3>
          ${badge}
          ${newBadge}
          ${stars}
        </div>
        <span class="plugin-author">by ${escapeHtml(plugin.author)} · ${escapeHtml(plugin.kind || plugin.category)}</span>
        <p class="plugin-description">${escapeHtml(plugin.description)}</p>
        <div class="plugin-card-bottom">
          <div class="plugin-tags">${tags}</div>
          ${installAction}
        </div>
      </div>
      <a class="plugin-card-link" href="plugin.html?id=${encodeURIComponent(plugin.id)}" aria-label="View ${escapeHtml(plugin.name)}"></a>
    </article>`;
}

function bindCardActions(root) {
  root.querySelectorAll("[data-copy-command]").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.copyCommand, button));
  });
}

function renderRecentlyAdded() {
  const section = document.querySelector("#recent-section");
  const root = document.querySelector("#recent-grid");
  if (!section || !root) return;

  const recent = state.plugins
    .filter((plugin) => (plugin.sourceType || "community") === "community" && isRecentlyAdded(plugin))
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt) || a.name.localeCompare(b.name))
    .slice(0, 3);

  section.hidden = recent.length === 0;
  root.innerHTML = recent.map((plugin) => pluginCard(plugin, { showNew: true })).join("");
  bindCardActions(root);
}

function render() {
  const visible = filteredPlugins();
  count.textContent = String(visible.length);
  countLabel.textContent = state.source === "builtin" ? "built-in plugins" : "community plugins";
  grid.innerHTML = visible.map((plugin) => pluginCard(plugin, { showNew: true })).join("");
  bindCardActions(grid);
  grid.hidden = visible.length === 0;
  empty.hidden = visible.length !== 0;
  updateUrl();
}

function renderSourceFilters() {
  const totals = {
    community: state.plugins.filter((plugin) => (plugin.sourceType || "community") === "community").length,
    builtin: state.plugins.filter((plugin) => plugin.sourceType === "builtin").length
  };

  sourcesRoot.innerHTML = [
    ["community", "Community"],
    ["builtin", "Built-in"]
  ].map(([source, label]) => `
    <button class="source-button${state.source === source ? " active" : ""}" type="button" data-source="${source}" aria-pressed="${state.source === source}">
      <span>${label}</span><span>${totals[source]}</span>
    </button>`).join("");

  sourcesRoot.querySelectorAll("[data-source]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.source === state.source) return;
      state.source = button.dataset.source;
      state.category = "all";
      state.sort = sourceDefaultSort();
      renderSourceFilters();
      renderSortOptions();
      renderCategories();
      render();
    });
  });
}

function renderSortOptions() {
  sort.innerHTML = sortOptions[state.source]
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  if (!sortOptions[state.source].some(([value]) => value === state.sort)) {
    state.sort = sourceDefaultSort();
  }
  sort.value = state.sort;
}

function renderCategories() {
  const plugins = sourcePlugins();
  const totals = new Map([["all", plugins.length]]);
  plugins.forEach((plugin) => totals.set(plugin.category, (totals.get(plugin.category) || 0) + 1));
  const sorted = [...totals.entries()].sort(([a], [b]) => {
    if (a === "all") return -1;
    if (b === "all") return 1;
    return a.localeCompare(b);
  });

  categoriesRoot.innerHTML = sorted.map(([category, total]) => `
    <button class="category-button${state.category === category ? " active" : ""}" type="button" data-category="${escapeHtml(category)}">
      <span>${escapeHtml(category === "all" ? allCategoryLabel() : category)}</span><span>${total}</span>
    </button>`).join("");

  categoriesRoot.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", () => {
      state.category = button.dataset.category;
      renderCategories();
      render();
    });
  });
}

function resetFilters() {
  state.query = "";
  state.category = "all";
  search.value = "";
  renderCategories();
  render();
}

function updateUrl() {
  const params = new URLSearchParams();
  if (state.source === "builtin") params.set("source", "builtin");
  if (state.query) params.set("q", state.query);
  if (state.category !== "all") params.set("category", state.category);
  if (state.sort !== sourceDefaultSort()) params.set("sort", state.sort);
  const next = `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`;
  history.replaceState(null, "", next);
}

function restoreUrl() {
  const params = new URLSearchParams(location.search);
  state.source = params.get("source") === "builtin" ? "builtin" : "community";
  state.query = params.get("q") || "";
  state.category = params.get("category") || "all";
  const requestedSort = params.get("sort") || sourceDefaultSort();
  state.sort = sortOptions[state.source].some(([value]) => value === requestedSort)
    ? requestedSort
    : sourceDefaultSort();
  search.value = state.query;
}

async function init() {
  setupThemeToggle();
  setupCopyButtons();

  try {
    const catalog = await loadCatalog();
    state.plugins = catalog.plugins || [];
    restoreUrl();
    renderRecentlyAdded();
    renderSourceFilters();
    renderSortOptions();
    renderCategories();
    render();
  } catch (error) {
    console.error(error);
    grid.hidden = true;
    empty.hidden = false;
    empty.querySelector("h3").textContent = "Catalog unavailable";
    empty.querySelector("p").textContent = "The plugin catalog could not be loaded. Please try again.";
  }

  search.addEventListener("input", () => {
    state.query = search.value;
    render();
  });

  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      search.value = "";
      state.query = "";
      render();
      search.blur();
    }
  });

  document.addEventListener("keydown", (event) => {
    if ((event.key === "/" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")) && document.activeElement !== search) {
      event.preventDefault();
      search.focus();
    }
  });

  sort.addEventListener("change", () => {
    state.sort = sort.value;
    render();
  });

  document.querySelector("#clear-filters").addEventListener("click", resetFilters);
  document.querySelector("#empty-reset").addEventListener("click", resetFilters);
}

init();
