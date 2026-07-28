import {
  accentColor,
  copyText,
  escapeHtml,
  formatDate,
  formatStars,
  loadCatalog,
  setupThemeToggle,
  starIcon
} from "./shared.js?v=20260728-6";

function detailTemplate(plugin) {
  const tags = (plugin.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const preview = plugin.previewImage
    ? `<figure class="detail-preview"><img src="${escapeHtml(plugin.previewImage)}" alt="${escapeHtml(plugin.name)} desktop preview" width="${Number(plugin.previewWidth) || 1600}" height="${Number(plugin.previewHeight) || 900}"></figure>`
    : "";
  const command = plugin.builtIn ? plugin.officialCommand : plugin.installCommand;
  const commandLabel = plugin.builtIn ? plugin.officialCommandLabel : "Install";
  const commandPanel = `<div class="command-panel">
        <div class="command-panel-head"><span>BASH <span>${escapeHtml(commandLabel)}</span></span>
        <button class="copy-button" type="button" data-install-copy aria-label="Copy ${escapeHtml(commandLabel.toLowerCase())} command">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg><span>Copy</span>
        </button></div><pre><code><span class="prompt">❯</span> ${escapeHtml(command)}</code></pre></div>`;
  const install = plugin.builtIn
    ? `${commandPanel}<div class="placeholder-install builtin-availability"><strong>Included with Omarchy Quattro</strong><p>This first-party plugin ships with Omarchy. The command configures the included plugin; it does not download marketplace code.</p></div>`
    : plugin.placeholder
      ? `<div class="placeholder-install"><strong>Coming soon</strong><p>${escapeHtml(plugin.installNote)}</p></div>`
      : `${commandPanel}<p class="install-note">${escapeHtml(plugin.installNote || "")}</p>`;

  const availabilityHeading = plugin.builtIn || plugin.placeholder ? "Availability" : "Install";
  const sourceCopy = plugin.builtIn
    ? "This first-party plugin is included with Omarchy Quattro. Review its source in the official Omarchy repository."
    : "The marketplace does not execute or host plugin code. Review the public repository, requirements, and license before installation.";
  const sourceHeading = plugin.builtIn ? "Official Omarchy source" : "Public plugin source";
  const sourceUrl = plugin.sourceUrl || plugin.repo;

  return `
    <article style="--card-accent:${accentColor(plugin.accent)}">
      <header class="page-header" id="overview"><div class="page-eyebrow">${escapeHtml(plugin.category)}</div>
        <div class="detail-title"><span class="detail-icon">${escapeHtml(plugin.initials)}</span><h1>${escapeHtml(plugin.name)}</h1></div>
        <div class="page-meta"><span>${escapeHtml(plugin.id)}</span><span>by ${escapeHtml(plugin.author)}</span><span class="status">${escapeHtml(plugin.status || "Available")}</span></div>
      </header>
      <p class="detail-description">${escapeHtml(plugin.description)}</p>${preview}<div class="plugin-tags">${tags}</div>
      <section class="detail-section" id="install"><h2>${plugin.builtIn ? escapeHtml(plugin.officialCommandLabel) : availabilityHeading} <span class="hash">#</span></h2>${install}</section>
      <section class="detail-section" id="trust"><h2>Trust & source <span class="hash">#</span></h2><div class="placeholder-install trust-source-note"><strong>${sourceHeading}</strong><p>${sourceCopy}</p></div><p style="margin-top:18px"><a class="button primary" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">View source ↗</a></p></section>
    </article>`;
}

async function init() {
  setupThemeToggle();
  const id = new URLSearchParams(location.search).get("id");
  const content = document.querySelector("#detail-content");
  const error = document.querySelector("#detail-error");

  try {
    const catalog = await loadCatalog();
    const plugin = catalog.plugins.find((item) => item.id === id);
    if (!plugin) throw new Error("Plugin not found");

    document.title = `${plugin.name} — omarchy-plugin-marketplace`;
    document.querySelector("#crumb-name").textContent = plugin.name;
    content.className = "";
    content.innerHTML = detailTemplate(plugin);
    document.querySelector("#aside-status").innerHTML = `<span class="status-label">${escapeHtml(plugin.status || "Available")}</span>`;
    document.querySelector("#aside-version").textContent = plugin.version;
    document.querySelector("#aside-license").textContent = plugin.license || "Unknown";
    document.querySelector("#aside-owner").textContent = plugin.author;
    if (plugin.builtIn || plugin.placeholder) {
      const navigationLabel = plugin.builtIn ? plugin.officialCommandLabel : "Availability";
      document.querySelector("#install-nav-link").textContent = navigationLabel;
      document.querySelector("#aside-install-link").textContent = navigationLabel;
      document.querySelector("#mobile-install-link").textContent = plugin.builtIn ? "Command" : "Available";
    }

    const copyButton = content.querySelector("[data-install-copy]");
    copyButton?.addEventListener("click", () => copyText(plugin.builtIn ? plugin.officialCommand : plugin.installCommand, copyButton));
  } catch (reason) {
    console.error(reason);
    content.hidden = true;
    error.hidden = false;
    document.querySelector("#crumb-name").textContent = "Not found";
  }
}

init();
