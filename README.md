# omarchy plugins

> Browse and discover community plugins for [Omarchy](https://omarchy.org/) at [omarchyplugins.com](https://omarchyplugins.com/).

![omarchy-plugin-marketplace preview](preview.png)

## Submit a Plugin

Use one public GitHub repository per plugin with `manifest.json`, README, and license files at the repository root.

1. Choose a category and one to three tags.
2. [Open the submission form](https://github.com/HANCORE-linux/omarchy-plugin-marketplace/issues/new?template=submit-plugin.yml), or follow the [CLI and AI submission guide](SUBMISSION.md).
3. Wait for automated compatibility checks and maintainer approval.

Read the [security baseline guidelines](SECURITY_BASELINE.md) before submitting a plugin or changing marketplace security automation.

An optional root preview is resized and optimized automatically.

## Engagement Metrics

The marketplace displays anonymous aggregate plugin detail views, successful command-copy actions, and hearts. A detail view is guarded once per plugin and browser session as a best-effort refresh limit. Copy activity is recorded only after the clipboard action succeeds. A heart is guarded once per plugin in local browser storage.

These counters are marketplace interactions, not downloads, installations, unique people, verified votes, quality rankings, or security signals. Browser storage can be cleared or bypassed, so hearts remain anonymous reactions rather than unique votes. The application sends only the catalog plugin ID and the fixed action type to the Cloudflare Worker. It does not store accounts, cookies, IP addresses, user-agent strings, command text, or repository URLs in D1. Cloudflare uses the request IP only as an ephemeral edge rate-limit key and otherwise processes normal request metadata as the network provider under the account's Cloudflare configuration.

## Security Notice

> Community plugins are developed and maintained by independent third parties. They execute as unsandboxed code and may access or modify files,
> settings, credentials, network resources, or other parts of your system according to their implementation and permissions.

> The Marketplace performs limited automated checks on the identified plugin commit and may conduct manual review. These checks are not a security
> audit, certification, endorsement, or guarantee that a plugin is safe, secure, error-free, or suitable for a particular purpose. Upstream code may
> change after review unless the installed version is explicitly pinned to the reviewed commit.

> Before installation, review the plugin’s source code, requested capabilities, dependencies, and installation and removal instructions. Report
> suspected malicious or compromised plugins immediately through the [private security report form](https://github.com/HANCORE-linux/omarchy-plugin-marketplace/security/advisories/new). The Marketplace may suspend or remove listings while concerns are investigated.

> Nothing in this notice excludes or limits liability where exclusion or limitation is prohibited by applicable law.

## Disclaimer

Omarchy Plugins is an independent community project and is not affiliated with, sponsored by, or endorsed by Omarchy or 37signals.

## Credits

Interface design inspired by [bjarneo](https://github.com/bjarneo)'s [ContextOwl developer documentation](https://developer.contextowl.co/docs/platform/cli).

Marketplace structure and submission workflow inspired by [limehawk's Omarchy Theme Website](https://github.com/limehawk/omarchy-theme-website).

## License

The [MIT License](LICENSE) applies only to original source code and associated documentation authored for this marketplace, except where a file states otherwise. It does not grant rights to plugin code, repositories, names, trademarks, logos, screenshots, previews, or other third-party content. Those materials remain subject to the licenses and rights of their respective owners.

Marketplace listings may link to third-party repositories and cache optimized copies of submitted preview assets. The marketplace relies on each submitter's rights confirmation. A listing does not transfer ownership, verify third-party rights, or imply endorsement. Submitters remain responsible for their code, assets, documentation, and associated rights.

The Omarchy name and wordmark are used only to identify compatibility. All trademarks and logos remain the property of their respective owners.

If you believe a listing or asset infringes your rights, submit a [rights or asset removal request](https://github.com/HANCORE-linux/omarchy-plugin-marketplace/issues/new?template=rights-request.yml) identifying the material and the basis for your request so it can be reviewed or removed.
