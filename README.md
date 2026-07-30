# omarchy plugins

> Browse and discover community plugins for [Omarchy](https://omarchy.org/) at [omarchyplugins.com](https://omarchyplugins.com/).

![omarchy-plugin-marketplace preview](preview.png)

## Submit a Plugin

Have a plugin you'd like listed? [Open a submission](https://github.com/HANCORE-linux/omarchy-plugin-marketplace/issues/new?template=submit-plugin.yml). Add a `preview.png` to the repository root to display it in the marketplace.

CLI and agent submissions should use the same Markdown fields as the issue form and run `gh issue create --repo HANCORE-linux/omarchy-plugin-marketplace --title "[Plugin]: Plugin name" --body-file submission.md`. A correctly structured CLI submission is detected and labeled automatically.

New submissions use one plugin per repository with `manifest.json` at the repository root. Multi-plugin repositories remain discoverable only when added manually and do not receive an automatic install command until Omarchy provides a transactional subdirectory install and update path.

After the automated compatibility checks pass and the submission has been reviewed for listing, a maintainer applies the `approved-for-listing` label. GitHub Actions then records the validated commit, adds the plugin, rebuilds and deploys the marketplace, and closes the issue. Listing is not a security review; plugins run as unsandboxed upstream code.

## Disclaimer

Omarchy Plugins is an independent community project and is not affiliated with, sponsored by, or endorsed by Omarchy or 37signals.

## Credits

Interface design inspired by [bjarneo](https://github.com/bjarneo)'s [ContextOwl developer documentation](https://developer.contextowl.co/docs/platform/cli).

Marketplace structure and submission workflow inspired by [limehawk's Omarchy Theme Website](https://github.com/limehawk/omarchy-theme-website).

## License

MIT
