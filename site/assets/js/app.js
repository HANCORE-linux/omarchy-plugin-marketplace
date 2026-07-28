import {
  accentColor,
  copyText,
  escapeHtml,
  formatStars,
  isRecentlyAdded,
  isRecentlyUpdated,
  listingTime,
  loadCatalog,
  setupCopyButtons,
  setupThemeToggle,
  starIcon
} from "./shared.js?v=20260728-7";

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
  const activityBadge = showNew && isRecentlyUpdated(plugin)
    ? '<span class="updated-badge">Updated</span>'
    : showNew && isRecentlyAdded(plugin)
      ? '<span class="new-badge">New</span>'
      : "";
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
        <div class="plugin-preview-bar"><span>${escapeHtml(plugin.id)}</span>${plugin.releaseTag ? `<span>${escapeHtml(plugin.releaseTag)}</span>` : ""}</div></div>`
    : `<div class="plugin-preview" aria-hidden="true">
        <div class="plugin-preview-bar"><span>${escapeHtml(plugin.id)}</span>${plugin.releaseTag ? `<span>${escapeHtml(plugin.releaseTag)}</span>` : ""}</div>
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

function setupHancoreAsciiHover() {
  const mark = document.querySelector(".footer-project-mark");
  const canvas = mark?.querySelector(".footer-project-canvas");
  const svg = mark?.querySelector("svg");
  if (!mark || !canvas || !svg || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const width = 650;
  const height = 140;
  const fontSize = 12;
  const lineHeight = fontSize * 1.2;
  context.font = `${fontSize}px "Courier New", Courier, monospace`;
  context.textBaseline = "alphabetic";
  const characterWidth = context.measureText("M").width;
  const particles = [];

  [...svg.querySelectorAll("tspan")].forEach((line, row) => {
    [...line.textContent].forEach((character, column) => {
      if (character === " ") return;
      const baseX = 10 + column * characterWidth;
      const baseY = 20 + row * lineHeight;
      particles.push({
        character,
        baseX,
        baseY,
        x: baseX,
        y: baseY,
        velocityX: 0,
        velocityY: 0,
        density: 0.85 + Math.random() * 0.65,
      });
    });
  });

  let pointer = null;
  let accent = "#ff5a36";
  let text = "#d7d7d9";

  const updateColors = () => {
    const styles = getComputedStyle(document.documentElement);
    accent = styles.getPropertyValue("--accent").trim() || accent;
    text = styles.getPropertyValue("--text").trim() || text;
  };

  const mapPointer = (event) => {
    const bounds = canvas.getBoundingClientRect();
    pointer = {
      x: (event.clientX - bounds.left) * (width / bounds.width),
      y: (event.clientY - bounds.top) * (height / bounds.height),
    };
  };

  mark.addEventListener("pointermove", mapPointer);
  mark.addEventListener("pointerleave", () => { pointer = null; });
  new MutationObserver(updateColors).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  updateColors();
  mark.classList.add("is-interactive");
  const startedAt = performance.now();

  const draw = (now) => {
    context.clearRect(0, 0, width, height);
    context.font = `${fontSize}px "Courier New", Courier, monospace`;
    context.textBaseline = "alphabetic";

    const phase = ((now - startedAt) % 8000) / 8000;
    const sweepEdge = phase <= 0.7 ? (phase / 0.7) * 1.05 : 1.05;
    const radius = 78;

    for (const particle of particles) {
      let targetX = particle.baseX;
      let targetY = particle.baseY;
      let easing = 0.035;

      if (pointer) {
        const deltaX = particle.x - pointer.x;
        const deltaY = particle.y - pointer.y;
        const distance = Math.hypot(deltaX, deltaY) || 0.001;

        if (distance < radius) {
          const force = (radius - distance) / radius;
          const normalX = deltaX / distance;
          const normalY = deltaY / distance;
          const displacement = force * 48 * particle.density;
          targetX += (normalX - normalY * 0.18) * displacement;
          targetY += (normalY + normalX * 0.18) * displacement;
          easing = 0.065;
        }
      }

      particle.x += (targetX - particle.x) * easing;
      particle.y += (targetY - particle.y) * easing;

      context.fillStyle = particle.baseX / width <= sweepEdge ? accent : text;
      context.fillText(particle.character, particle.x, particle.y);
    }

    requestAnimationFrame(draw);
  };

  requestAnimationFrame(draw);
}

function setupFooterAsciiField() {
  const panel = document.querySelector(".footer-tech-panel");
  const canvas = panel?.querySelector(".footer-tech-canvas");
  if (!panel || !canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  let width = 0;
  let height = 0;
  let particles = [];
  let pointer = null;
  let settleTimer = 0;
  let resumeTimer = 0;
  let accent = "#ff5a36";
  let text = "#d7d7d9";
  let faint = "#7d7d84";
  let line = "#3a3a3f";

  const updateColors = () => {
    const styles = getComputedStyle(document.documentElement);
    accent = styles.getPropertyValue("--accent").trim() || accent;
    text = styles.getPropertyValue("--text").trim() || text;
    faint = styles.getPropertyValue("--faint").trim() || faint;
    line = styles.getPropertyValue("--line-strong").trim() || line;
  };

  const resize = () => {
    const bounds = panel.getBoundingClientRect();
    const density = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    context.setTransform(density, 0, 0, density, 0, 0);

    particles = [];

    const addParticle = (glyph, baseX, baseY, font, color, logoRatio = null) => {
      particles.push({
        glyph,
        baseX,
        baseY,
        x: baseX,
        y: baseY,
        velocityX: 0,
        velocityY: 0,
        energy: 0,
        font,
        color,
        logoRatio,
        density: 0.8 + Math.random() * 0.65,
      });
    };

    const addTextParticles = (element, color) => {
      if (!element) return;
      const styles = getComputedStyle(element);
      const font = `${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();

      while (node) {
        [...node.data].forEach((glyph, index) => {
          if (glyph.trim() === "") return;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect();
          if (!rect.width && !rect.height) return;
          addParticle(
            glyph,
            rect.left - bounds.left + rect.width / 2,
            rect.bottom - bounds.top - 1,
            font,
            color,
          );
        });
        node = walker.nextNode();
      }
    };

    const mark = panel.querySelector(".footer-project-mark");
    const svg = mark?.querySelector("svg");
    if (mark && svg) {
      const markBounds = mark.getBoundingClientRect();
      const scaleX = markBounds.width / 650;
      const scaleY = markBounds.height / 140;
      context.font = '12px "Courier New", Courier, monospace';
      const sourceCharacterWidth = context.measureText("M").width;
      const logoFont = `${12 * scaleY}px "Courier New", Courier, monospace`;

      [...svg.querySelectorAll("tspan")].forEach((row, rowIndex) => {
        [...row.textContent].forEach((glyph, column) => {
          if (glyph === " ") return;
          const sourceX = 10 + column * sourceCharacterWidth;
          const sourceY = 20 + rowIndex * 14.4;
          addParticle(
            glyph,
            markBounds.left - bounds.left + sourceX * scaleX,
            markBounds.top - bounds.top + sourceY * scaleY,
            logoFont,
            "logo",
            sourceX / 650,
          );
        });
      });
    }

    const copy = panel.querySelector(".footer-tech-copy");
    const label = copy?.querySelector(":scope > span");
    const description = copy?.querySelector("p");
    const repository = panel.querySelector(".footer-repository");
    addTextParticles(label, "accent");
    addTextParticles(description, "faint");
    addTextParticles(repository, "text");

    if (copy) {
      const copyBounds = copy.getBoundingClientRect();
      const dividerX = copyBounds.left - bounds.left + 1;
      for (let y = copyBounds.top - bounds.top + 3; y < copyBounds.bottom - bounds.top; y += 8) {
        addParticle("│", dividerX, y, '8px "JetBrains Mono", monospace', "line");
      }
    }

    if (repository) {
      const button = repository.getBoundingClientRect();
      const left = button.left - bounds.left;
      const right = button.right - bounds.left;
      const top = button.top - bounds.top;
      const bottom = button.bottom - bounds.top;
      const borderFont = '8px "JetBrains Mono", monospace';

      addParticle("+", left, top + 3, borderFont, "line");
      addParticle("+", right - 2, top + 3, borderFont, "line");
      addParticle("+", left, bottom - 1, borderFont, "line");
      addParticle("+", right - 2, bottom - 1, borderFont, "line");
      for (let x = left + 7; x < right - 5; x += 7) {
        addParticle("─", x, top + 3, borderFont, "line");
        addParticle("─", x, bottom - 1, borderFont, "line");
      }
      for (let y = top + 10; y < bottom - 5; y += 8) {
        addParticle("│", left, y, borderFont, "line");
        addParticle("│", right - 2, y, borderFont, "line");
      }
    }
  };

  panel.addEventListener("pointermove", (event) => {
    const bounds = panel.getBoundingClientRect();
    pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  });
  panel.addEventListener("pointerleave", () => { pointer = null; });

  const pauseForLink = (immediate = false) => {
    clearTimeout(settleTimer);
    clearTimeout(resumeTimer);
    settleTimer = window.setTimeout(() => {
      panel.classList.add("is-link-paused");
      panel.querySelector(".footer-project-mark svg")?.pauseAnimations?.();
    }, immediate ? 0 : 1800);
  };

  const resumeAfterLink = () => {
    clearTimeout(settleTimer);
    clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => {
      panel.classList.remove("is-link-paused");
      panel.querySelector(".footer-project-mark svg")?.unpauseAnimations?.();
    }, 500);
  };

  [
    panel.querySelector(".footer-project-mark"),
    panel.querySelector(".footer-repository"),
  ].filter(Boolean).forEach((link) => {
    link.addEventListener("pointerenter", () => pauseForLink());
    link.addEventListener("pointerleave", resumeAfterLink);
    link.addEventListener("focus", () => pauseForLink(true));
    link.addEventListener("blur", resumeAfterLink);
  });

  new ResizeObserver(resize).observe(panel);
  new MutationObserver(updateColors).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  updateColors();
  resize();
  panel.classList.add("is-interactive");

  const draw = () => {
    context.clearRect(0, 0, width, height);
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    const radius = 68;
    const phase = (performance.now() % 8000) / 8000;
    const sweepEdge = phase <= 0.7 ? (phase / 0.7) * 1.05 : 1.05;

    for (const particle of particles) {
      let targetX = particle.baseX;
      let targetY = particle.baseY;
      let easing = 0.035;
      particle.energy *= 0.94;

      if (pointer) {
        const deltaX = particle.x - pointer.x;
        const deltaY = particle.y - pointer.y;
        const distance = Math.hypot(deltaX, deltaY) || 0.001;

        if (distance < radius) {
          const force = (radius - distance) / radius;
          const normalX = deltaX / distance;
          const normalY = deltaY / distance;
          const displacement = force * 24 * particle.density;
          targetX += (normalX - normalY * 0.16) * displacement;
          targetY += (normalY + normalX * 0.16) * displacement;
          easing = 0.065;
          particle.energy = Math.max(particle.energy, force);
        }
      }

      particle.x += (targetX - particle.x) * easing;
      particle.y += (targetY - particle.y) * easing;

      context.font = particle.font;
      context.globalAlpha = 1;
      if (particle.energy > 0.24) {
        context.fillStyle = accent;
      } else if (particle.color === "logo") {
        context.fillStyle = particle.logoRatio <= sweepEdge ? accent : text;
      } else {
        context.fillStyle = { accent, text, faint, line }[particle.color] || text;
      }
      context.fillText(particle.glyph, particle.x, particle.y);
    }

    context.globalAlpha = 1;
    requestAnimationFrame(draw);
  };

  requestAnimationFrame(draw);
}

async function init() {
  setupThemeToggle();
  setupCopyButtons();
  setupHancoreAsciiHover();
  setupFooterAsciiField();

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
