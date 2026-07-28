import {
  accentColor,
  copyText,
  currentHashId,
  escapeHtml,
  formatDate,
  formatStars,
  listingCheckState,
  loadCatalog,
  setupSectionNavigation,
  setupThemeToggle,
  starIcon
} from "./shared.js?v=20260729-25";

function statusTone(plugin) {
  if (plugin.upstreamCheckStatus === "failed") return "is-failed";
  if (
    plugin.upstreamCheckStatus === "unreachable"
    || (!plugin.installAvailable && !plugin.builtIn && !plugin.placeholder)
  ) return "is-caution";
  return "";
}

function detailTemplate(plugin) {
  const tags = (plugin.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const preview = plugin.previewImage
    ? `<figure class="detail-preview"><img src="${escapeHtml(plugin.previewImage)}" alt="${escapeHtml(plugin.name)} desktop preview" width="${Number(plugin.previewWidth) || 1600}" height="${Number(plugin.previewHeight) || 900}"></figure>`
    : "";
  const command = plugin.builtIn ? plugin.officialCommand : plugin.installCommand;
  const commandLabel = plugin.builtIn ? plugin.officialCommandLabel : "Install";
  const commandPanel = command ? `<div class="command-panel">
        <div class="command-panel-head"><span>BASH <span>${escapeHtml(commandLabel)}</span></span>
        <button class="copy-button" type="button" data-install-copy aria-label="Copy ${escapeHtml(commandLabel.toLowerCase())} command">
          <span class="copy-icon" aria-hidden="true"></span><span>Copy</span>
        </button></div><pre><code><span class="prompt">❯</span> ${escapeHtml(command)}</code></pre></div>` : "";
  const install = plugin.builtIn
    ? `${commandPanel}<div class="placeholder-install builtin-availability"><strong>Included with Omarchy Quattro</strong><p>This first-party plugin ships with Omarchy. The command configures the included plugin; it does not download marketplace code.</p></div>`
    : plugin.placeholder
      ? `<div class="placeholder-install"><strong>Coming soon</strong><p>${escapeHtml(plugin.installNote)}</p></div>`
      : !plugin.installAvailable
        ? `<div class="placeholder-install"><strong>${escapeHtml(plugin.status || "Installation unavailable")}</strong><p>${escapeHtml(plugin.installNote || "")}</p></div>`
        : `${commandPanel}<p class="install-note">${escapeHtml(plugin.installNote || "")}</p>`;

  const availabilityHeading = plugin.builtIn || plugin.placeholder || !plugin.installAvailable
    ? "Availability"
    : "Install";
  const sourceCopy = plugin.builtIn
    ? "This first-party plugin is included with Omarchy Quattro. Review its source in the official Omarchy repository."
    : "Plugins run as unsandboxed code. The marketplace lists repositories but does not perform a security review. Review and trust the upstream source before installing.";
  const sourceHeading = plugin.builtIn ? "Official Omarchy source" : "Public plugin source";
  const sourceUrl = plugin.sourceUrl || plugin.repo;
  const shortSha = (value) => /^[a-f0-9]{40}$/i.test(value || "") ? value.slice(0, 7) : "unknown";
  const repositoryUrl = String(plugin.repo || "").replace(/\/+$/, "");
  const commitLink = (sha, label) => /^[a-f0-9]{40}$/i.test(sha || "")
    ? `<a href="${escapeHtml(`${repositoryUrl}/commit/${sha}`)}" target="_blank" rel="noreferrer" aria-label="${escapeHtml(`${label}: ${shortSha(sha)}`)}"><code>${escapeHtml(shortSha(sha))}</code> <span aria-hidden="true">↗</span></a>`
    : "Unknown";
  const branchPath = String(plugin.upstreamObservedBranch || plugin.listingValidatedBranch || "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const branchLink = branchPath
    ? `<a href="${escapeHtml(`${repositoryUrl}/tree/${branchPath}`)}" target="_blank" rel="noreferrer">${escapeHtml(plugin.upstreamObservedBranch || plugin.listingValidatedBranch)} <span aria-hidden="true">↗</span></a>`
    : "Unknown";
  const formatCheckTime = (value) => {
    if (!value) return "Unknown";
    return new Intl.DateTimeFormat("en", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(new Date(value));
  };
  const check = listingCheckState(plugin);
  const comparison = check.comparison === "changed"
    ? `<a href="${escapeHtml(`${repositoryUrl}/compare/${plugin.listingValidatedCommit}...${plugin.upstreamObservedCommit}`)}" target="_blank" rel="noreferrer">View changes <span aria-hidden="true">↗</span></a>`
    : check.comparison === "unknown"
      ? "Could not determine"
      : "No changes detected";
  const lastCompatible = check.lastCompatibleCommit
    ? `<div class="listing-check-row"><dt>Last compatible</dt><dd>${commitLink(check.lastCompatibleCommit, "View last compatible commit")}</dd></div>`
    : "";
  const lastSuccessful = check.lastSuccessfulAt
    ? `<div class="listing-check-row"><dt>Last successful</dt><dd><time datetime="${escapeHtml(check.lastSuccessfulAt)}">${escapeHtml(formatCheckTime(check.lastSuccessfulAt))}</time></dd></div>`
    : "";
  const provenance = !plugin.builtIn && !plugin.placeholder && plugin.listingValidatedCommit
    ? `<section class="listing-checks" aria-labelledby="listing-checks-title">
        <h3 id="listing-checks-title">Listing checks</h3>
        <dl>
          <div class="listing-check-row"><dt>Compatibility</dt><dd><span class="listing-check-status ${check.statusTone}">${check.statusLabel}</span></dd></div>
          <div class="listing-check-row"><dt>Last checked</dt><dd><time datetime="${escapeHtml(plugin.upstreamCheckedAt || "")}">${escapeHtml(formatCheckTime(plugin.upstreamCheckedAt))}</time></dd></div>
          <div class="listing-check-row"><dt>${check.commitLabel}</dt><dd>${commitLink(check.checkedCommit, `View ${check.commitLabel.toLowerCase()}`)}</dd></div>
          ${lastSuccessful}
          ${lastCompatible}
          <div class="listing-check-row"><dt>Listing snapshot</dt><dd>${commitLink(plugin.listingValidatedCommit, "View listing snapshot")}<small>${escapeHtml(formatDate(plugin.listingValidatedAt))}</small></dd></div>
          <div class="listing-check-row"><dt>Branch</dt><dd>${branchLink}</dd></div>
          <div class="listing-check-row"><dt>Upstream changes</dt><dd>${comparison}</dd></div>
        </dl>
      </section>`
    : "";
  const repositoryRelease = plugin.repositoryRelease?.tag
    ? `<div class="placeholder-install trust-source-note"><strong>Repository release</strong><p><a href="${escapeHtml(plugin.repositoryRelease.url)}" target="_blank" rel="noreferrer">${escapeHtml(plugin.repositoryRelease.tag)} ↗</a> is repository-level metadata and does not replace this plugin’s manifest version.</p></div>`
    : "";

  return `
    <article class="plugin-detail-article" style="--card-accent:${accentColor(plugin.accent)}">
      <header class="page-header" id="overview"><div class="page-eyebrow">${escapeHtml(plugin.category)}</div>
        <div class="detail-title"><span class="detail-icon">${escapeHtml(plugin.initials)}</span><h1>${escapeHtml(plugin.name)}</h1></div>
        <div class="page-meta"><span>${escapeHtml(plugin.id)}</span><span>by ${escapeHtml(plugin.author)}</span><span class="status ${statusTone(plugin)}"><i class="status-dot" aria-hidden="true"></i>${escapeHtml(plugin.status || "Available")}</span></div>
      </header>
      <p class="detail-description">${escapeHtml(plugin.description)}</p>${preview}<div class="plugin-tags">${tags}</div>
      <section class="detail-section" id="install"><h2>${plugin.builtIn ? escapeHtml(plugin.officialCommandLabel) : availabilityHeading} <span class="hash">#</span></h2>${install}</section>
      <section class="detail-section" id="trust"><h2>Trust & source <span class="hash">#</span></h2><div class="placeholder-install trust-source-note"><strong>${sourceHeading}</strong><p>${sourceCopy}</p></div>${provenance}${repositoryRelease}<p style="margin-top:18px"><a class="button primary" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">View source ↗</a></p></section>
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

    document.title = `${plugin.name} | Omarchy Plugins`;
    document.querySelector("#crumb-name").textContent = plugin.name;
    content.className = "";
    content.innerHTML = detailTemplate(plugin);
    setupSectionNavigation({
      sectionSelector: "#detail-content .plugin-detail-article > [id]",
      linkSelector: ".right-aside .aside-link[href^='#'], .mobile-bottom a[href^='#']",
    });
    if (location.hash) {
      const target = document.getElementById(currentHashId());
      if (target) window.requestAnimationFrame(() => target.scrollIntoView());
    }
    document.querySelector("#aside-status").innerHTML = `<span class="status-label ${statusTone(plugin)}">${escapeHtml(plugin.status || "Available")}</span>`;
    document.querySelector("#aside-version").textContent = plugin.version ? `v${String(plugin.version).replace(/^v/i, "")}` : "—";
    document.querySelector("#aside-license").textContent = plugin.license || "Unknown";
    document.querySelector("#aside-owner").textContent = plugin.author;
    if (plugin.builtIn || plugin.placeholder || !plugin.installAvailable) {
      const navigationLabel = plugin.builtIn ? plugin.officialCommandLabel : "Availability";
      document.querySelector("#aside-install-link").textContent = navigationLabel;
      document.querySelector("#mobile-install-link").textContent = plugin.builtIn
        ? "Command"
        : plugin.placeholder
          ? "Preview"
          : "Status";
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
