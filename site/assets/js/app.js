import {
  accentColor,
  clockIcon,
  copyText,
  escapeHtml,
  formatDate,
  formatStars,
  loadCatalog,
  setupCopyButtons,
  setupThemeToggle,
  starIcon
} from "./shared.js";

const state = {
  plugins: [],
  query: "",
  category: "All plugins",
  sort: "featured"
};

const grid = document.querySelector("#plugin-grid");
const count = document.querySelector("#plugin-count");
const empty = document.querySelector("#empty-state");
const categoriesRoot = document.querySelector("#category-filters");
const search = document.querySelector("#search-input");
const sort = document.querySelector("#sort-select");

function filteredPlugins() {
  const query = state.query.trim().toLocaleLowerCase();
  const result = state.plugins.filter((plugin) => {
    const matchesCategory = state.category === "All plugins" || plugin.category === state.category;
    const haystack = [
      plugin.name,
      plugin.description,
      plugin.author,
      plugin.id,
      plugin.category,
      ...(plugin.tags || [])
    ].join(" ").toLocaleLowerCase();
    return matchesCategory && (!query || haystack.includes(query));
  });

  const sorters = {
    featured: (a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name),
    updated: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
    stars: (a, b) => (b.stars || 0) - (a.stars || 0) || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name)
  };

  return result.sort(sorters[state.sort]);
}

function pluginCard(plugin) {
  const tags = (plugin.tags || []).slice(0, 2).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const badge = plugin.placeholder
    ? '<span class="featured-badge">Coming soon</span>'
    : plugin.featured ? '<span class="featured-badge">Curated</span>' : "";
  const installAction = plugin.placeholder
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

  return `
    <article class="plugin-card" style="--card-accent:${accentColor(plugin.accent)}">
      ${preview}
      <div class="plugin-card-body">
        <div class="plugin-title-line">
          <h3>${escapeHtml(plugin.name)}</h3>
          ${badge}
          <span class="card-stars">${starIcon()} ${formatStars(plugin.stars)}</span>
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

function renderFeatured() {
  const root = document.querySelector("#featured-grid");
  if (!root) return;
  root.innerHTML = state.plugins.filter((plugin) => plugin.featured).slice(0, 3).map(pluginCard).join("");
  root.querySelectorAll("[data-copy-command]").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.copyCommand, button));
  });
}

function render() {
  const visible = filteredPlugins();
  count.textContent = String(visible.length);
  grid.innerHTML = visible.map(pluginCard).join("");
  grid.querySelectorAll("[data-copy-command]").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.copyCommand, button));
  });
  grid.hidden = visible.length === 0;
  empty.hidden = visible.length !== 0;
  updateUrl();
}

function renderCategories() {
  const totals = new Map([["All plugins", state.plugins.length]]);
  state.plugins.forEach((plugin) => totals.set(plugin.category, (totals.get(plugin.category) || 0) + 1));
  const sorted = [...totals.entries()].sort(([a], [b]) => {
    if (a === "All plugins") return -1;
    if (b === "All plugins") return 1;
    return a.localeCompare(b);
  });

  categoriesRoot.innerHTML = sorted.map(([category, total]) => `
    <button class="category-button${state.category === category ? " active" : ""}" type="button" data-category="${escapeHtml(category)}">
      <span>${escapeHtml(category)}</span><span>${total}</span>
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
  state.category = "All plugins";
  search.value = "";
  renderCategories();
  render();
}

function updateUrl() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.category !== "All plugins") params.set("category", state.category);
  if (state.sort !== "featured") params.set("sort", state.sort);
  const next = `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`;
  history.replaceState(null, "", next);
}

function restoreUrl() {
  const params = new URLSearchParams(location.search);
  state.query = params.get("q") || "";
  state.category = params.get("category") || "All plugins";
  state.sort = params.get("sort") || "featured";
  search.value = state.query;
  sort.value = state.sort;
}

async function init() {
  setupThemeToggle();
  setupCopyButtons();

  try {
    const catalog = await loadCatalog();
    state.plugins = catalog.plugins || [];
    restoreUrl();
    renderFeatured();
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
