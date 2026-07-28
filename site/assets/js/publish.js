import {
  setupCopyButtons,
  setupSectionNavigation,
  setupThemeToggle,
} from "./shared.js?v=20260728-20";

setupThemeToggle();
setupCopyButtons();

setupSectionNavigation({
  sectionSelector: ".docs-section",
  linkSelector: ".left-sidebar .sidebar-link[href^='#'], .right-aside .aside-link[href^='#'], .mobile-bottom a[href^='#']",
});
