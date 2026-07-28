import {
  accentColor,
  copyText,
  escapeHtml,
  formatStars,
  isRecentlyAdded,
  isRecentlyUpdated,
  listingTime,
  loadCatalog,
  pluginVersionLabel,
  setupCopyButtons,
  setupThemeToggle,
  starIcon
} from "./shared.js?v=20260728-24";

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
    added: (a, b) => listingTime(b) - listingTime(a) || a.name.localeCompare(b.name),
    updated: (a, b) => (
      new Date(b.versionUpdatedAt || b.repositoryUpdatedAt || 0)
      - new Date(a.versionUpdatedAt || a.repositoryUpdatedAt || 0)
    ),
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
  const activityBadge = showNew && isRecentlyUpdated(plugin)
    ? '<span class="updated-badge">Updated</span>'
    : showNew && isRecentlyAdded(plugin)
      ? '<span class="new-badge">New</span>'
      : "";
  const installAction = plugin.builtIn
    ? `<a class="card-install builtin-source-action" href="${escapeHtml(plugin.sourceUrl || plugin.repo)}" target="_blank" rel="noreferrer" aria-label="View source for ${escapeHtml(plugin.name)}">View source ↗</a>`
    : plugin.placeholder
      ? '<span class="card-install unavailable" aria-label="Installation not yet available"><span class="command-glyph" aria-hidden="true"></span> Preview only</span>'
      : !plugin.installAvailable
        ? `<span class="card-install unavailable" aria-label="Automatic installation unavailable"><span class="command-glyph" aria-hidden="true"></span> ${plugin.upstreamCheckStatus === "failed" ? "Unavailable" : "Manual setup"}</span>`
        : `<button class="card-install" type="button" data-copy-command="${escapeHtml(plugin.installCommand)}" aria-label="Copy install command for ${escapeHtml(plugin.name)}">
          <span class="command-glyph" aria-hidden="true"></span><span data-copy-label>Copy install</span>
          <span class="copy-icon" aria-hidden="true"></span>
        </button>`;
  const versionLabel = pluginVersionLabel(plugin);
  const preview = plugin.previewImage
    ? `<div class="plugin-preview image-preview"><img src="${escapeHtml(plugin.previewImage)}" alt="" width="${Number(plugin.previewWidth) || 1600}" height="${Number(plugin.previewHeight) || 900}" loading="lazy">
        <div class="plugin-preview-bar"><span>${escapeHtml(plugin.id)}</span>${versionLabel ? `<span>${escapeHtml(versionLabel)}</span>` : ""}</div></div>`
    : `<div class="plugin-preview" aria-hidden="true">
        <div class="plugin-preview-bar"><span>${escapeHtml(plugin.id)}</span>${versionLabel ? `<span>${escapeHtml(versionLabel)}</span>` : ""}</div>
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
          ${activityBadge}
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
    .sort((a, b) => listingTime(b) - listingTime(a) || a.name.localeCompare(b.name))
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

function runVisibleAnimation(element, draw, framesPerSecond = 60) {
  let frame = 0;
  let visible = false;
  let nextDrawAt = 0;
  const frameInterval = 1000 / framesPerSecond;
  const active = () => visible && document.visibilityState === "visible";
  const tick = (now) => {
    frame = 0;
    if (!active()) return;
    if (!nextDrawAt || now >= nextDrawAt) {
      nextDrawAt = now + frameInterval - 1;
      draw(now);
    }
    frame = window.requestAnimationFrame(tick);
  };
  const sync = () => {
    if (active() && !frame) frame = window.requestAnimationFrame(tick);
    if (!active() && frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
  };
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(element);
  document.addEventListener("visibilitychange", sync);
}

function setupHeroRay() {
  const frame = document.querySelector(".market-hero-ray");
  const canvas = frame?.querySelector("canvas");
  const label = frame?.querySelector(".market-hero-ray-label");
  if (!frame || !canvas || !label) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const base = {
    AMP: 4, WIND: 35, VS: 7, VO: 13, QA: 2, QF: 3, SP: 35, TH: 9,
    ORB: 40, YS: 35, PD: 9, PSP: 2, WV: 9, WSP: 2, DOF: 4,
    RF: 9, DPH: 2, CX: 200, CY: 0, DENS: 235,
  };
  const presets = [
    { name: "ORIGINAL", zoom: 1.08, offsetY: -45, values: {} },
    { name: "COCOON", zoom: 1.04, offsetY: -105, values: { WIND: 14.5, AMP: 2.6, TH: 14.2, SP: 70, ORB: 22, YS: 52, RF: 4.2, DENS: 150 } },
    { name: "STORM", zoom: .92, values: { PD: 2.4, PSP: 4.2, WV: 2.8, RF: 19, DPH: -3.4, WIND: 48, DENS: 110 } },
    { name: "RAY", zoom: 1.18, values: { AMP: 8.69, WIND: 38.26, VS: 16.38, VO: 11.75, QA: 1.65, QF: 3.47, SP: 38.62, TH: 9.63, ORB: 47.63, YS: 7.34, PD: 10.77, PSP: 2.73, WV: 7.21, WSP: 3.79, DOF: 5.98, RF: 3.04, DPH: 3.18, CX: 201, CY: 161 } },
    { name: "BIRD", zoom: 1.08, values: { AMP: 9.07, WIND: 73.68, VS: 15.45, VO: 25.38, QA: 4.98, QF: 5.32, SP: 44.61, TH: 9.37, ORB: 16.84, YS: 21.85, PD: 12.64, PSP: 3.52, WV: 10.31, WSP: 2, DOF: 3.3, RF: 10.2, DPH: 2.76, CX: 200, CY: -261 } },
    { name: "WING", zoom: 1.18, values: { AMP: 7.18, WIND: 47.39, VS: 16.24, VO: 28.23, QA: 3.58, QF: 5.84, SP: 38.57, TH: 12.2, ORB: 25.09, YS: 10.8, PD: 15.4, PSP: 3.23, WV: 12.94, WSP: 1.19, DOF: 8.59, RF: 10.94, DPH: .79, CX: 205, CY: -5 } },
  ].map((preset) => ({ ...preset, values: { ...base, ...preset.values } }));

  const pointCount = 3600;
  const sourcePointCount = 6000;
  const sourceIndices = new Float32Array(pointCount);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let width = 0;
  let height = 0;
  let presetIndex = 3;
  let animationStartedAt = performance.now();
  let accent = "#ff5a36";
  let text = "#d7d7d9";

  for (let index = 0; index < pointCount; index += 1) {
    sourceIndices[index] = index * (sourcePointCount / pointCount);
  }

  const updateColors = () => {
    const styles = getComputedStyle(document.documentElement);
    accent = styles.getPropertyValue("--accent").trim() || accent;
    text = styles.getPropertyValue("--text").trim() || text;
  };

  const resize = () => {
    const bounds = frame.getBoundingClientRect();
    const density = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    context.setTransform(density, 0, 0, density, 0, 0);
  };

  new ResizeObserver(() => {
    resize();
    if (reducedMotion) window.requestAnimationFrame((now) => draw(now));
  }).observe(frame);

  updateColors();
  resize();

  const draw = (now) => {
    context.clearRect(0, 0, width, height);
    const preset = presets[presetIndex];
    const values = preset.values;
    const time = (now - animationStartedAt) * .00105;
    const scale = Math.min(width / 400, height / 400) * preset.zoom;
    const originX = (width - 400 * scale) / 2;
    const originY = (height - 400 * scale) / 2;

    for (let index = pointCount; index--;) {
      const sourceIndex = sourceIndices[index];
      const y = sourceIndex / values.DENS;
      const k = (values.AMP + Math.cos(sourceIndex / values.PD - time * values.PSP))
        * Math.cos(sourceIndex / values.WIND);
      const e = y / values.VS - values.VO;
      const distance = Math.hypot(k, e)
        + Math.sin(e / values.WV + time / values.WSP) - values.DOF;
      const q = values.QA * Math.sin(k * values.QF)
        - y / values.SP * k
          * (values.TH + k
            * Math.sin(Math.cos(e) * values.RF - distance * values.DPH + time));
      const angle = distance - time;
      const sourceX = q + values.ORB * Math.cos(angle) + values.CX;
      const sourceY = q * Math.sin(angle) + distance * values.YS + values.CY;
      const x = originX + sourceX * scale;
      const pointY = originY + (sourceY + (preset.offsetY || 0)) * scale;

      if (x < 0 || x > width || pointY < 0 || pointY > height) continue;
      context.globalAlpha = index % 13 === 0 ? .48 : .27;
      context.fillStyle = index % 19 === 0 ? accent : text;
      const size = index % 29 === 0 ? 1.3 : .8;
      context.fillRect(x, pointY, size, size);
    }

    context.globalAlpha = 1;
  };

  new MutationObserver(() => {
    updateColors();
    if (reducedMotion) window.requestAnimationFrame((now) => draw(now));
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  const updatePreset = () => {
    const preset = presets[presetIndex];
    label.textContent = `${preset.name} ${String(presetIndex + 1).padStart(2, "0")}/${String(presets.length).padStart(2, "0")}`;
    frame.setAttribute("aria-label", `Show next parametric animation. Current: ${preset.name.toLowerCase()}`);
  };

  frame.addEventListener("click", () => {
    presetIndex = (presetIndex + 1) % presets.length;
    animationStartedAt = performance.now();
    updatePreset();
    if (!reducedMotion) {
      canvas.animate?.([{ opacity: .25 }, { opacity: .84 }], { duration: 220, easing: "ease-out" });
    } else {
      draw(animationStartedAt);
    }
  });

  updatePreset();
  if (reducedMotion) {
    draw(animationStartedAt);
  } else {
    runVisibleAnimation(frame, draw, 30);
  }
}

async function init() {
  setupThemeToggle();
  setupCopyButtons();
  setupHeroRay();

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
