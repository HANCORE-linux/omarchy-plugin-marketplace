# Submit a plugin from the CLI or an AI agent

Use this guide to submit a public Omarchy plugin repository without the GitHub issue form. The marketplace applies the `submission` label and starts validation when the title and body match the format below.

## Check the repository

Before submitting, confirm that the repository:

- Is public and hosted at a GitHub repository root URL
- Contains one plugin with `manifest.json` in the repository root
- Contains a root README with installation and removal instructions
- Contains a root license file and documents external dependencies
- Uses a unique plugin ID outside the reserved `omarchy.*` namespace
- Optionally contains a root `preview.png` for the marketplace listing

Marketplace validation checks repository structure and Omarchy Quattro compatibility. It is not a security review, and plugins run as unsandboxed upstream code.

## Choose listing metadata

Choose one category:

- `Appearance`
- `Desktop`
- `Developer Tools`
- `Hardware`
- `Productivity`
- `System`
- `Widgets`
- `Other`

Choose one to three tags:

- `ai`
- `bar`
- `hyprland`
- `launcher`
- `media`
- `power-management`
- `quickshell`
- `security`
- `system`
- `workspaces`

Copy category and tag values without the bullet marker or backticks. Categories are case-sensitive and must match the spelling above exactly. Tags may be comma-separated or entered one per line.

You may suggest one missing reusable tag under `Suggest a missing tag`. Reviewers decide whether to add it.

## Create the submission

Create a temporary issue body:

```bash
cat > /tmp/omarchy-plugin-submission.md <<'EOF'
### Repository URL

https://github.com/your_github_name/your_plugin_repository

### Category

selected_category

### Tags

selected_tag, another_selected_tag

### Suggest a missing tag

_No response_

### Maintainer notes

_No response_

### Submission checklist

- [x] The repository is public and contains installation and removal instructions.
- [x] I have documented the plugin license and any external dependencies.
- [x] I confirm that I own or have permission to submit this plugin and its preview assets.
- [x] The plugin does not overwrite user configuration without explicit consent.
- [x] I understand that approval is for listing and is not a security review.
EOF
```

Replace every placeholder before submitting:

- Replace the example repository URL with the public GitHub repository root URL, without a trailing slash or a path such as `/tree/main`
- Replace `selected_category` with one category exactly as written above, without backticks
- Replace both tag placeholders with one to three allowed tags, or remove the unused placeholder and comma
- Replace `plugin_name` in the command below with the plugin's human-readable name

Replace `_No response_` when you want to suggest a tag or add maintainer notes. Keep all six headings in their current order.

Review every checklist statement. Submit only if all five statements are true, then keep each checkbox checked.

Create the issue with an authenticated [GitHub CLI](https://cli.github.com/):

```bash
${EDITOR:-vi} /tmp/omarchy-plugin-submission.md

gh issue create \
  --repo HANCORE-linux/omarchy-plugin-marketplace \
  --title "[Plugin]: plugin_name" \
  --body-file /tmp/omarchy-plugin-submission.md
```

Replace `plugin_name` with the plugin's human-readable name. Run `gh auth login` first if the GitHub CLI is not authenticated.

## Instructions for AI agents

When preparing a submission for someone:

1. Read the plugin repository's root `manifest.json`, README, and license file.
2. Use one category and one to three tags from the allowed values above.
3. Preserve every submission heading, its order, and the exact checklist text.
4. Ask the plugin owner to confirm the ownership statement and every other checklist item.
5. Show the completed title and body to the owner before creating the issue.
6. Create the GitHub issue only after the owner explicitly approves the submission.

After a correctly formatted issue opens, automated validation posts its result on the issue. A maintainer must still review and approve the plugin before it appears in the marketplace.

If no automated validation comment appears, the CLI submission was not recognized. Edit the existing issue and verify that its title starts with `[Plugin]:`, all six headings remain in their original order, the category matches exactly, and all five checklist items are checked. Editing the issue runs submission detection again.
