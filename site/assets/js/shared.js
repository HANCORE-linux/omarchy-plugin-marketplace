const accentColors = {
  lime: "#b7ef51",
  violet: "#a78bfa",
  amber: "#f4bd62",
  cyan: "#68d6e8",
  coral: "#f18c75",
  blue: "#74a7f7",
  mint: "#69d4a7",
  rose: "#e896ba"
};

export function accentColor(name) {
  return accentColors[name] || accentColors.lime;
}

export async function loadCatalog() {
  const response = await fetch("catalog.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
  return response.json();
}

export function formatDate(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(value));
}

export function formatStars(value = 0) {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

export function listingTime(plugin) {
  if (plugin?.listedAt) return Date.parse(plugin.listedAt);
  if (plugin?.addedAt) return Date.parse(`${plugin.addedAt}T00:00:00Z`);
  return Number.NaN;
}

export function currentHashId() {
  const raw = location.hash.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function isRecentlyAdded(plugin, now = Date.now(), windowDays = 3) {
  if (plugin?.builtIn || plugin?.placeholder) return false;
  const listedAt = listingTime(plugin);
  if (!Number.isFinite(listedAt)) return false;
  const age = now - listedAt;
  return age >= 0 && age < windowDays * 24 * 60 * 60 * 1000;
}

export function isRecentlyUpdated(plugin, now = Date.now(), windowDays = 3) {
  if (!plugin?.versionUpdatedAt || plugin?.builtIn || plugin?.placeholder) return false;
  const updatedAt = Date.parse(plugin.versionUpdatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  const age = now - updatedAt;
  return age >= 0 && age < windowDays * 24 * 60 * 60 * 1000;
}

export function pluginVersionLabel(plugin) {
  if (plugin?.placeholder || !plugin?.version) return "";
  const version = String(plugin.version).trim();
  if (!version) return "";
  return `manifest ${/^v\d/i.test(version) ? version : `v${version}`}`;
}

export function listingCheckState(plugin) {
  const upstreamChanged = Boolean(
    plugin?.upstreamObservedCommit
    && plugin?.listingValidatedCommit
    && plugin.upstreamObservedCommit !== plugin.listingValidatedCommit
  );

  if (plugin?.upstreamCheckStatus === "passed") {
    return {
      statusLabel: "Passed",
      statusTone: "is-passed",
      commitLabel: "Checked commit",
      checkedCommit: plugin.upstreamValidatedCommit,
      comparison: upstreamChanged ? "changed" : "unchanged",
    };
  }

  if (plugin?.upstreamCheckStatus === "failed") {
    return {
      statusLabel: "Failed",
      statusTone: "is-failed",
      commitLabel: "Checked commit",
      checkedCommit: plugin.upstreamObservedCommit,
      lastCompatibleCommit: plugin.upstreamValidatedCommit,
      comparison: upstreamChanged ? "changed" : "unchanged",
    };
  }

  return {
    statusLabel: "Status unknown",
    statusTone: "is-caution",
    commitLabel: "Last compatible",
    checkedCommit: plugin?.upstreamValidatedCommit,
    lastSuccessfulAt: plugin?.upstreamValidatedAt,
    comparison: "unknown",
  };
}

export function setupSectionNavigation({
  sectionSelector,
  linkSelector,
  markerRatio = 0.55,
  markerMax = Number.POSITIVE_INFINITY,
  activateLastAtPageEnd = true,
}) {
  const sections = [...document.querySelectorAll(sectionSelector)];
  const links = [...document.querySelectorAll(linkSelector)];
  if (!sections.length || !links.length) return () => {};

  let frame = 0;
  let pinnedId = "";
  let pinTimer = 0;

  const setActive = (id) => {
    for (const link of links) {
      const sectionIds = link.dataset.sectionIds
        ?.trim()
        .split(/\s+/)
        .filter(Boolean) || [link.hash.slice(1)];
      const active = sectionIds.includes(id);
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };

  const update = () => {
    frame = 0;
    const atPageEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    let active = sections[0];

    if (activateLastAtPageEnd && atPageEnd) {
      active = sections.at(-1);
    } else {
      const marker = window.scrollY + Math.min(markerMax, window.innerHeight * markerRatio);
      for (const section of sections) {
        const sectionTop = section.getBoundingClientRect().top + window.scrollY;
        if (sectionTop <= marker) active = section;
        else break;
      }
    }

    if (!pinnedId) setActive(active.id);
  };

  const scheduleUpdate = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };

  const pinSection = (id) => {
    pinnedId = id;
    window.clearTimeout(pinTimer);
    pinTimer = window.setTimeout(() => {
      pinnedId = "";
    }, 900);
    setActive(id);
  };

  for (const link of links) {
    link.addEventListener("click", () => pinSection(link.hash.slice(1)));
  }
  const releasePinnedSection = () => {
    if (!pinnedId) return;
    window.clearTimeout(pinTimer);
    pinnedId = "";
    scheduleUpdate();
  };
  const releaseOnNavigationKey = (event) => {
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) {
      releasePinnedSection();
    }
  };
  window.addEventListener("scroll", scheduleUpdate, { passive: true });
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("wheel", releasePinnedSection, { passive: true });
  window.addEventListener("touchstart", releasePinnedSection, { passive: true });
  window.addEventListener("keydown", releaseOnNavigationKey);
  const handleHashChange = () => {
    const id = currentHashId();
    if (sections.some((section) => section.id === id)) {
      pinSection(id);
    }
  };
  window.addEventListener("hashchange", handleHashChange);

  const initialId = currentHashId();
  if (sections.some((section) => section.id === initialId)) {
    pinSection(initialId);
  } else {
    update();
  }

  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    window.clearTimeout(pinTimer);
    window.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("wheel", releasePinnedSection);
    window.removeEventListener("touchstart", releasePinnedSection);
    window.removeEventListener("keydown", releaseOnNavigationKey);
    window.removeEventListener("hashchange", handleHashChange);
  };
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function setupThemeToggle() {
  const toggle = document.querySelector(".theme-toggle");
  if (!toggle) return;

  toggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("omarchy-theme", next);
  });
}

let toastTimer;

export function showToast(message = "Copied to clipboard") {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

export async function copyText(value, button) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }

  const label = button?.querySelector("[data-copy-label], .copy-button > span");
  const oldLabel = label?.textContent;
  if (label) label.textContent = "Copied";
  showToast("Command copied");
  setTimeout(() => {
    if (label) label.textContent = oldLabel;
  }, 1400);
}

export function setupCopyButtons(root = document) {
  root.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.copy, button));
  });
}

export function starIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/></svg>';
}

export function clockIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>';
}
