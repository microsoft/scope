# Secret Scan Viewer

A Copilot CLI **canvas extension** that scans the repository's entire git
history for accidentally-committed secrets, keys, and credentials, and renders
the results as an interactive dashboard. Built to vet the repo before open
sourcing.

## What it does

Scans in **three passes** over the full history (all commits, all refs):

1. **Diff content** — streams `git log -p -U0` and matches every *added* line
   against a catalog of secret-detection rules (`scanner.mjs`).
2. **Commit messages** — scans every commit subject + body (secrets are
   sometimes pasted into messages, not just files).
3. **Key / credential files** — flags committed files whose path is key material
   (private keys, keystores, `.pfx`/`.p12`/`.jks`, `id_rsa`, `.netrc`,
   `.pgpass`, AWS `credentials`, …), including **binary blobs** whose contents
   the diff pass can never see.

Each finding is tagged with **severity**, **file:line**, **source** (diff /
commit msg / file), **commit provenance** (author/date/subject), and whether it
is reachable from the publish branch (`main`) — i.e. whether it would actually
ship. Obvious non-secrets are classified **likely-safe** (see below) so the
signal isn't drowned in noise.

## Safety model

- **Raw secrets never leave the scanner.** Every value is masked
  (`ghp_ab************yz`) before it reaches the browser, the agent, or any log.
  Nothing is written to disk inside the repo.
- The dashboard is served on a **loopback-only** (`127.0.0.1`) ephemeral port,
  one server per open canvas instance, torn down on close.

## Detection rules

**Content rules** (diff + commit messages): private keys (PEM/OpenSSH/PGP), AWS,
Azure Storage/Service Bus keys & SAS tokens, GCP API keys / service accounts,
GitHub & GitLab tokens, OpenAI / Anthropic / Hugging Face keys, Slack/Discord
webhooks, Stripe, SendGrid, Twilio, Mailgun, npm/PyPI tokens, npm/yarn
`_authToken`, JWTs, credentials embedded in connection URLs, and a gated generic
"hardcoded secret assignment" heuristic. See `RULES` in `scanner.mjs`.

**File rule** (`sensitive-file`): path-based detection of committed key/keystore/
credential files, so binary key material is caught even though it is never
diff-scanned.

### Likely-safe gating

A content match is demoted to *likely-safe* (hidden by default, one toggle away)
when it is a known public/dev constant (e.g. the Azurite `devstoreaccount1`
key), a placeholder, a `${VARIABLE}` reference, an `ENV_VAR_NAME`, descriptive
text containing whitespace, low-entropy, or lives in an `*.example` /
test-fixture / vendored path. Structural markers (private-key blocks,
service-account JSON) are never demoted by value shape.

A `sensitive-file` match stays **real** regardless of binary-vs-text (git's
binary heuristic is unreliable), and is demoted only by example/fixture/vendor
path or when it is a low-risk config file (`.npmrc`/`.yarnrc`) already covered by
the auth-token content rule.

## Usage

The extension auto-loads from `.github/extensions/`. Ask the agent to open the
**Secret Scan Viewer** canvas (or `open_canvas` with `canvasId:
"secret-scan-viewer"`). It scans on open and shows a live dashboard.

Canvas input / actions:

| Surface | Name | Purpose |
| --- | --- | --- |
| open input | `allRefs` | Scan all refs (default `true`) or only `HEAD`. |
| action | `rescan` | Re-run the scan (optionally toggling `allRefs`). |
| action | `get_summary` | Return stats + top masked findings to the agent. |

Dashboard controls: severity filters, rule filter, free-text search, "on publish
branch only", "show likely-safe", and "group by commit".

## Files

- `scanner.mjs` — detection rules, gating heuristics, and the streaming
  git-history scanner. Reusable/standalone (`import { scanRepo } from …`).
- `dashboard.mjs` — the static single-page UI (`DASHBOARD_HTML`).
- `extension.mjs` — wiring: per-instance loopback server + canvas registration.
