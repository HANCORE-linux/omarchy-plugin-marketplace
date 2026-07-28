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

export function isRecentlyAdded(plugin, now = Date.now(), windowDays = 14) {
  if (plugin?.placeholder || !plugin?.addedAt) return false;
  const addedAt = Date.parse(`${plugin.addedAt}T00:00:00Z`);
  if (!Number.isFinite(addedAt)) return false;
  const age = now - addedAt;
  return age >= 0 && age < windowDays * 24 * 60 * 60 * 1000;
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
