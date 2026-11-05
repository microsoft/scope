---
title: Sharing runs
description: Publish configurable, read-only run links that recipients can open without signing in.
---

Share a run's results with someone who does not have a Scope account. Each link
is **read-only**, exposes only its selected sections, and stays attached to one
execution attempt even if the request is retried.

Your installation must enable `SCOPE_RUN_SHARING_ENABLED` on the API. You must
be an active signed-in Scope user to create links. Recipients do not sign in.

## Create a link in the Portal

1. Open a run and select the attempt to share.
2. Click **Share**.
3. Choose **Summary** or **Full detail**, then adjust individual sections.
4. Set an expiry, or select **No expiry**. New links default to seven days.
5. Review the exposed sections and any sensitive-content confirmation, then
   click **Create link**.
6. Copy and save the URL immediately. Scope stores only its hash; the secret
   cannot be retrieved later.

Summary includes run status, agent/model, timing, and structured evaluation
results. It does not include task prompts, judge explanations, conversations,
logs, or downloads. The label you choose is public.

Full detail enables prompts, evaluation explanations, conversations, persisted
logs, and reports. **Source archives, network captures, and videos remain
off until you explicitly select them.** You can turn individual sections off
or on with either preset.

:::caution[Review before publishing]
Anyone with the URL can read and redistribute its content. Logs, reports,
agent responses, source files, network captures, and recordings can contain
credentials, private code, or copies of other sections. Category switches do
not automatically redact those copies or remove secrets.
:::

## View a shared link

Open the complete URL, including the part after `#`. The public viewer does not
require a Scope account, project selection, or login.

Only permitted tabs appear. Shared results refresh periodically while the page
is visible. Logs show a bounded tail of persisted entries, not a live SSE
connection. Reports without a verified association to the selected attempt
are omitted; older unbound reports need to be regenerated to become shareable.

Raw conversation downloads and tool calls require the conversations, prompts,
and evaluation explanations categories together. Source archives are individual
workspace snapshots, not the full private run archive. Downloads are limited to
128 MiB per artifact; logs contain up to the last 1 MiB of persisted entries.
Reports are shown without active HTML, external images, or clickable links.

## Manage access

Open **Share** again to see **Your links for this attempt**:

- **Edit** changes the label, content selection, or expiry.
- **Rotate URL** issues a new secret and immediately invalidates the previous
  URL. Save and distribute the replacement.
- **Revoke** permanently disables the link. Create a new link if you need to
  share the run again.

You manage only links you created. Invalid, expired, revoked, and deleted-target
links show the same unavailable message. Revocation stops future reads but
cannot remove files someone already downloaded or retract a response already
in flight.

## Use the CLI

Publishing uses your existing authenticated Scope CLI configuration. Use the
request ID and the exact attempt ID, not an attempt number.

```bash
scope run share create REQUEST_ID --attempt ATTEMPT_ID \
  --portal-url https://scope.example.com --output json

scope run share create REQUEST_ID --attempt ATTEMPT_ID \
  --preset full --include snapshots,video --exclude logs \
  --acknowledge-sensitive-content \
  --expires-at 2099-01-01T00:00:00Z \
  --portal-url https://scope.example.com --output json

scope run share list REQUEST_ID --attempt ATTEMPT_ID --output json

scope run share update REQUEST_ID SHARE_ID --attempt ATTEMPT_ID \
  --preset summary --no-expiry --output json

scope run share rotate REQUEST_ID SHARE_ID --attempt ATTEMPT_ID \
  --portal-url https://scope.example.com --output json

scope run share revoke REQUEST_ID SHARE_ID --attempt ATTEMPT_ID --output json
```

Set `SCOPE_API_URL` or pass `--url` for management commands. `--portal-url` makes
the returned link absolute; without it, the API returns a Portal-relative path.
Use `--after` with the returned `next` ID to continue a management listing.
Content changes in `update` require `--preset` to make the replacement policy
explicit; `--include` and `--exclude` customize that policy.

Anonymous reads never send your IdP bearer:

```bash
scope run share view 'https://scope.example.com/shared/runs#SHARE_TOKEN'
scope run share view 'https://scope.example.com/shared/runs#SHARE_TOKEN' --section logs
scope run share view 'https://scope.example.com/shared/runs#SHARE_TOKEN' --section reports
scope run share download 'https://scope.example.com/shared/runs#SHARE_TOKEN' \
  ARTIFACT_ID --file ./artifact.tar.gz
```

Quote URLs so your shell preserves the fragment. Public reads default to the
configured API URL, or the shared URL's origin if none is configured; override
with `--url` when the Portal and API use different origins. Read output supports
JSON or YAML. Report pages accept `--after`; artifact IDs come from the shared
view's `artifacts` array. Downloads never overwrite existing files.

## Installation notes

Apply database migration 031 and update the report-generator worker before
enabling the API switch. Reports generated by older workers lack the required
attempt-source verification and are not shared. Disabling the switch
denies public reads and link management without deleting records; re-enabling
restores links that are still valid. Revoke links first if they must not return.

The URL fragment is sent to fixed API paths through `X-Scope-Run-Share`.
Use HTTPS for Internet-facing Portal and API deployments.
Deployment-specific logging and analytics must not capture that header or
secret-bearing creation/rotation responses. These links are unlisted access,
not confidential sharing or a replacement for platform-wide authorization.
