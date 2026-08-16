# Engagement Worker

This Cloudflare Worker stores anonymous aggregate marketplace engagement in D1.
It records three actions:

- `view`: a successfully rendered plugin detail page, guarded once per browser session
- `copy`: a successful plugin command copy action
- `heart`: an anonymous positive reaction, guarded once per plugin in local browser storage

These values describe marketplace activity. They are not downloads, installations,
unique people, verified votes, quality signals, or security signals.

## Privacy and trust boundary

The application does not send or store accounts, cookies, IP addresses, user-agent
strings, command text, repository URLs, or plugin metadata. Event bodies contain only
a catalog plugin ID and the fixed action type. Cloudflare still processes normal request
metadata as the network provider under the account's Cloudflare configuration.

The public API contains no credentials. D1 is available only through the Worker binding.
Keep the real `wrangler.jsonc`, `.dev.vars`, local Wrangler state, and all credentials out
of version control.

## Local configuration

Copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc`, create the D1 database,
and replace only the local `REPLACE_WITH_D1_DATABASE_ID` value. Apply the migration
before starting the Worker on `127.0.0.1:8787`.

The production custom-domain route is intentionally commented out in the template.
Verify a workers.dev deployment before adding `api.omarchyplugins.com` to the local
configuration.

## API

- `GET /v1/stats` returns aggregate counts keyed by plugin ID.
- `POST /v1/events` accepts `{ "pluginId": "...", "type": "view" }`,
  `{ "pluginId": "...", "type": "copy" }`, or
  `{ "pluginId": "...", "type": "heart" }` from an allowed marketplace origin.

The Worker validates plugin IDs against the published marketplace catalog, applies a
Cloudflare edge rate limit before catalog or D1 access, and enforces a daily ceiling per
plugin and event type. The rate limiter uses the request IP as an ephemeral Cloudflare
edge key; the application does not write that key to D1. Public stats are cached at the
edge for up to five minutes, while browser storage is disabled and successful event
responses return authoritative fresh counts for immediate UI feedback.

Anonymous public counters remain inherently susceptible to manipulation. Local browser
storage is only a best-effort repeat guard and can be cleared or bypassed. Hearts must be
presented as anonymous reactions, never as unique or verified votes, trust, or quality
rankings.
