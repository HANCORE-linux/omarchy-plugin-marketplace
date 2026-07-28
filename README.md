# omarchy-plugin-marketplace

A community-curated Omarchy plugin marketplace, published at [omarchyplugins.com](https://omarchyplugins.com/).

![omarchy-plugin-marketplace preview](preview.png)

## Plugin previews

Plugin authors can add a `preview.png` directly to the root of their GitHub repository. The catalog build detects that file automatically and displays it on every marketplace entry sourced from that repository.

## Submit a plugin

Open the [plugin submission form](https://github.com/HANCORE-linux/omarchy-plugin-marketplace/issues/new?template=submit-plugin.yml). Approved repositories are added to `registry.json`; GitHub Actions refreshes the catalog and deploys the static site.

See [PLAN.md](PLAN.md) for the planned registry, validation, and GitHub Pages architecture.
