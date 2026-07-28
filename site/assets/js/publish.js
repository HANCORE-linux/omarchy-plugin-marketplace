import { setupCopyButtons, setupThemeToggle } from "./shared.js?v=20260728-4";

setupThemeToggle();
setupCopyButtons();

const sections = [...document.querySelectorAll(".docs-section")];
const links = [...document.querySelectorAll(".left-sidebar .sidebar-link[href^='#'], .right-aside .aside-link[href^='#']")];

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    links.forEach((link) => link.classList.toggle("active", link.hash === `#${visible.target.id}`));
  }, { rootMargin: "-20% 0px -65%", threshold: [0, 0.25, 0.6] });

  sections.forEach((section) => observer.observe(section));
}
