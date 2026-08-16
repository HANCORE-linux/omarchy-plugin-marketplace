import {
  accentColor,
  copyText,
  currentHashId,
  engagementSummary,
  escapeHtml,
  formatDate,
  formatStars,
  hidePendingEngagement,
  listingCheckState,
  loadCatalog,
  pluginHeartButton,
  pluginVersionLabel,
  setupSectionNavigation,
  setupThemeToggle,
  showToast,
  updateEngagementSummary,
  updatePluginHeart
} from "./shared.js?v=20260816-08";
import {
  engagementApiBaseUrl,
  hasPluginHeart,
  loadEngagementStats,
  recordEngagementEvent,
  recordPluginHeart,
  recordPluginView,
} from "./engagement.js?v=20260816-08";

function statusTone(plugin) {
  if (plugin.upstreamCheckStatus === "failed") return "is-failed";
  if (
    plugin.upstreamCheckStatus === "unreachable"
    || (!plugin.installAvailable && !plugin.builtIn && !plugin.placeholder)
  ) return "is-caution";
  return "";
}

function detailTemplate(plugin, engagement, {
  engagementEnabled = false,
  hearted = false,
  pendingEngagement = false,
} = {}) {
  const securityReportUrl = "https://github.com/HANCORE-linux/omarchy-plugin-marketplace/security/advisories/new";
  const tags = (plugin.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const preview = plugin.previewImage
    ? `<figure class="detail-preview"><img src="${escapeHtml(plugin.previewImage)}" alt="${escapeHtml(plugin.name)} desktop preview" width="${Number(plugin.previewWidth) || 1600}" height="${Number(plugin.previewHeight) || 900}"></figure>`
    : "";
  const command = plugin.builtIn ? plugin.officialCommand : plugin.installCommand;
  const commandLabel = plugin.builtIn ? plugin.officialCommandLabel : "Install";
  const commandPanel = command ? `<div class="command-panel">
        <div class="command-panel-head"><span>BASH <span>${escapeHtml(commandLabel)}</span></span>
        <button class="copy-button" type="button" data-install-copy aria-label="Copy ${escapeHtml(commandLabel.toLowerCase())} command">
          <span class="copy-icon" aria-hidden="true"></span><span data-copy-label>Copy</span>
        </button></div><pre><code><span class="prompt">❯</span> ${escapeHtml(command)}</code></pre></div>` : "";
  const installSecurityNotice = `<div class="placeholder-install install-security-note"><strong>Security Notice</strong><p>Third-party unsandboxed code. Automated checks are limited and are not a security audit or guarantee. Verify that the current commit matches the reviewed commit, inspect the source and capabilities, and <a href="${securityReportUrl}" target="_blank" rel="noreferrer">report suspicious plugins ASAP <span aria-hidden="true">↗</span></a>.</p></div>`;
  const install = plugin.builtIn
    ? `${commandPanel}<div class="placeholder-install builtin-availability"><strong>Included with Omarchy Quattro</strong><p>This first-party plugin ships with Omarchy. The command configures the included plugin; it does not download marketplace code.</p></div>`
    : plugin.placeholder
      ? `<div class="placeholder-install"><strong>Coming soon</strong><p>${escapeHtml(plugin.installNote)}</p></div>`
      : !plugin.installAvailable
        ? `<div class="placeholder-install"><strong>${escapeHtml(plugin.status || "Installation unavailable")}</strong><p>${escapeHtml(plugin.installNote || "")}</p></div>`
        : `${commandPanel}<p class="install-note">${escapeHtml(plugin.installNote || "")}</p>${installSecurityNotice}`;

  const availabilityHeading = plugin.builtIn || plugin.placeholder || !plugin.installAvailable
    ? "Availability"
    : "Install";
  const sourceNote = plugin.builtIn
    ? `<div class="placeholder-install terms-source-note"><strong>Official Omarchy source</strong><p>This first-party plugin is included with Omarchy Quattro. Review its source in the official Omarchy repository.</p></div>`
    : "";
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
    ? `<div class="placeholder-install terms-source-note"><strong>Repository release</strong><p><a href="${escapeHtml(plugin.repositoryRelease.url)}" target="_blank" rel="noreferrer">${escapeHtml(plugin.repositoryRelease.tag)} ↗</a> is repository-level metadata and does not replace this plugin’s manifest version.</p></div>`
    : "";
  const versionLabel = pluginVersionLabel(plugin);
  const manifestVersion = versionLabel
    ? `<span class="manifest-version">${escapeHtml(versionLabel)}</span>`
    : "";

  return `
    <article class="plugin-detail-article" style="--card-accent:${accentColor(plugin.accent)}">
      <header class="page-header" id="overview"><div class="page-eyebrow">${escapeHtml(plugin.category)}</div>
        <div class="detail-title"><span class="detail-icon">${escapeHtml(plugin.initials)}</span><h1>${escapeHtml(plugin.name)}</h1></div>
        <div class="page-meta"><span>${escapeHtml(plugin.id)}</span>${manifestVersion}<span>by ${escapeHtml(plugin.author)}</span><span class="status ${statusTone(plugin)}"><i class="status-dot" aria-hidden="true"></i>${escapeHtml(plugin.status || "Available")}</span></div>
        ${engagementEnabled ? `<div class="detail-engagement-cluster">
          ${engagementSummary(plugin, engagement, { detail: true, pending: pendingEngagement })}
          ${pluginHeartButton(plugin, engagement, { detail: true, hearted, pending: pendingEngagement })}
        </div>` : ""}
      </header>
      <p class="detail-description">${escapeHtml(plugin.description)}</p>${preview}<div class="plugin-tags">${tags}</div>
      <section class="detail-section" id="install"><h2>${plugin.builtIn ? escapeHtml(plugin.officialCommandLabel) : availabilityHeading}</h2>${install}</section>
      <section class="detail-section" id="terms"><h2>Terms of Use</h2>${sourceNote}${provenance}${repositoryRelease}<p style="margin-top:18px"><a class="button primary" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">View source ↗</a></p></section>
    </article>`;
}

function showDetailError({ title, message, crumb }) {
  const content = document.querySelector("#detail-content");
  const error = document.querySelector("#detail-error");
  content.hidden = true;
  error.hidden = false;
  error.querySelector("h1").textContent = title;
  error.querySelector("p").textContent = message;
  document.querySelector("#crumb-name").textContent = crumb;
  document.title = `${title} | Omarchy Plugins`;
}

async function init() {
  setupThemeToggle();
  const id = new URLSearchParams(location.search).get("id");
  const content = document.querySelector("#detail-content");
  const engagementEnabled = Boolean(engagementApiBaseUrl());
  let pluginEngagement = { views: 0, copies: 0, hearts: 0 };
  let authoritativeEngagement = null;
  let engagementLoaded = false;
  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (reason) {
    console.error(reason);
    showDetailError({
      title: "Catalog unavailable",
      message: "The plugin catalog could not be loaded. Try again in a moment.",
      crumb: "Unavailable",
    });
    return;
  }

  if (!catalog || !Array.isArray(catalog.plugins)) {
    showDetailError({
      title: "Catalog unavailable",
      message: "The plugin catalog could not be loaded. Try again in a moment.",
      crumb: "Unavailable",
    });
    return;
  }

  const plugin = catalog.plugins.find((item) => item?.id === id);
  if (!plugin) {
    showDetailError({
      title: "Plugin not found",
      message: "This plugin does not exist in the current catalog.",
      crumb: "Not found",
    });
    return;
  }

  try {
    document.title = `${plugin.name} | Omarchy Plugins`;
    document.querySelector("#crumb-name").textContent = plugin.name;
    content.className = "";
    content.innerHTML = detailTemplate(plugin, pluginEngagement, {
      engagementEnabled,
      hearted: hasPluginHeart(plugin.id),
      pendingEngagement: engagementEnabled,
    });
    if (currentHashId() === "trust") {
      const url = new URL(location.href);
      url.hash = "terms";
      history.replaceState(history.state, "", url);
    }
    setupSectionNavigation({
      sectionSelector: "#detail-content .plugin-detail-article > [id]",
      linkSelector: ".right-aside .aside-link[href^='#'], .mobile-bottom a[href^='#']",
    });
    if (location.hash) {
      const targetId = currentHashId();
      const target = document.getElementById(targetId);
      if (target) {
        let allowDeferredScroll = true;
        const cancelDeferredScroll = () => { allowDeferredScroll = false; };
        const scrollToTarget = () => {
          if (!allowDeferredScroll || currentHashId() !== targetId) return;
          window.requestAnimationFrame(() => {
            if (allowDeferredScroll && currentHashId() === targetId) target.scrollIntoView();
          });
        };
        window.requestAnimationFrame(scrollToTarget);
        window.addEventListener("pointerdown", cancelDeferredScroll, { once: true, passive: true });
        window.addEventListener("wheel", cancelDeferredScroll, { once: true, passive: true });
        window.addEventListener("touchstart", cancelDeferredScroll, { once: true, passive: true });
        window.addEventListener("keydown", cancelDeferredScroll, { once: true });
        content.querySelectorAll("img:not([loading='lazy'])").forEach((image) => {
          if (image.complete) return;
          image.addEventListener("load", scrollToTarget, { once: true });
          image.addEventListener("error", scrollToTarget, { once: true });
        });
      }
    }
    document.querySelector("#aside-status").innerHTML = `<span class="status-label ${statusTone(plugin)}">${escapeHtml(plugin.status || "Available")}</span>`;
    const versionLabel = pluginVersionLabel(plugin);
    document.querySelector("#aside-version").textContent = versionLabel
      ? versionLabel.replace(/^manifest\s+/, "")
      : "—";
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

    const applyAuthoritativeEngagement = (result) => {
      if (!result?.recorded || !result.stats) return;
      authoritativeEngagement = {
        views: Math.max(authoritativeEngagement?.views || 0, result.stats.views),
        copies: Math.max(authoritativeEngagement?.copies || 0, result.stats.copies),
        hearts: Math.max(authoritativeEngagement?.hearts || 0, result.stats.hearts),
      };
      pluginEngagement = authoritativeEngagement;
      engagementLoaded = true;
      const engagementCluster = content.querySelector(".detail-engagement-cluster");
      if (engagementCluster) engagementCluster.hidden = false;
      updateEngagementSummary(document, plugin.id, pluginEngagement);
      updatePluginHeart(document, plugin.id, pluginEngagement, {
        hearted: hasPluginHeart(plugin.id),
      });
    };

    const heartButton = content.querySelector("[data-plugin-heart]");
    heartButton?.addEventListener("click", async () => {
      if (heartButton.getAttribute("aria-disabled") === "true" || heartButton.dataset.heartSubmitting === "true") return;
      heartButton.dataset.heartSubmitting = "true";
      heartButton.setAttribute("aria-busy", "true");
      const result = await recordPluginHeart(plugin.id);
      delete heartButton.dataset.heartSubmitting;
      heartButton.removeAttribute("aria-busy");
      if (!result?.recorded) {
        showToast("Heart could not be sent. Try again.");
        return;
      }
      applyAuthoritativeEngagement(result);
      updatePluginHeart(document, plugin.id, result.stats, {
        animate: true,
        hearted: true,
      });
      showToast("Heart sent.");
    });

    const copyButton = content.querySelector("[data-install-copy]");
    copyButton?.addEventListener("click", async () => {
      const command = plugin.builtIn ? plugin.officialCommand : plugin.installCommand;
      if (!await copyText(command, copyButton)) return;
      applyAuthoritativeEngagement(await recordEngagementEvent(plugin.id, "copy"));
    });

    if (engagementEnabled) {
      loadEngagementStats().then((stats) => {
        const current = stats[plugin.id] || { views: 0, copies: 0, hearts: 0 };
        pluginEngagement = authoritativeEngagement || current;
        engagementLoaded = true;
        updateEngagementSummary(document, plugin.id, pluginEngagement);
        updatePluginHeart(document, plugin.id, pluginEngagement, {
          hearted: hasPluginHeart(plugin.id),
        });
      }).catch((reason) => {
        console.warn("Engagement stats unavailable", reason);
        if (!engagementLoaded) {
          hidePendingEngagement(document);
          const engagementCluster = content.querySelector(".detail-engagement-cluster");
          if (engagementCluster) engagementCluster.hidden = true;
        }
      });
      recordPluginView(plugin.id).then(applyAuthoritativeEngagement);
    }
  } catch (reason) {
    console.error(reason);
    showDetailError({
      title: "Plugin details unavailable",
      message: "The plugin details could not be displayed. Return to the marketplace and try again.",
      crumb: "Unavailable",
    });
  }
}

init();
