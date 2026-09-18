# Environment Variables for Criteria System

The sophisticated criteria system can be configured via environment variables in docker-compose or .env files.

## CLI Configuration

### SCOPE_API_URL
**Default:** `http://localhost:3100`
**Type:** URL string

Base URL of the Scope API used by all CLI commands. Override this to point the CLI at a remote or Docker-hosted API instance.

## Docker Development

### API_DEBUG_PORT
**Default:** `9200`
**Type:** integer (Docker Compose development only)

Host port for the API's Node inspector when using `docker-compose.dev.yml`,
including `pnpm docker:dev:portal`. The generated `.env` offsets this port per
worktree. The inspector listens on port `9229` inside the container and is
published to `127.0.0.1` only. Use the **Attach API (Docker)** VS Code launch
configuration and enter the current worktree's generated `API_DEBUG_PORT`.

## Agent Target Validation

### SCOPE_STRICT_AGENT_CAPABILITIES
**Default:** `false`
**Type:** boolean (`true` to enable)

When enabled on the API, run and profile writes reject requested reasoning
effort, MCP servers, skills, or extensions unless the selected registry agent
explicitly advertises the corresponding capability. The exact keys are
`supportsReasoningEffort`, `supportsMcpServers`, `supportsSkills`, and
`supportsExtensions`; omitted keys mean unsupported.

This is a temporary rollout switch for capability compatibility only. Unknown,
deleted, unavailable, versionless, inactive-version, and missing-queue targets
are rejected regardless of this setting.

### SCOPE_AGENT_VERSION
**Default:** worker-specific installed agent version
**Type:** non-empty string

Worker runtime identity override. Either this value or
`WorkerProcessor.getAgentVersion()` must provide the exact active registry
`agentVersion` advertised for that deployment; queue processor startup fails if
neither does. Queue consumers use this identity together with `WORKER_NAME` to
defer messages for another target when multiple workers or versions share a
queue. Local Compose sets it to the checked-in development manifest version.

## LLM Configuration (Portal AI Features)

The portal's AI features — criteria prompt generation, prompt-feature
extraction/generation, and task-prompt generation/variation — all call an
OpenAI-style chat-completions endpoint through the
[`@azure-rest/ai-inference`](https://www.npmjs.com/package/@azure-rest/ai-inference)
SDK. Two backends are supported, resolved in `acquireInferenceClient`
([`apps/api/src/llm-token.ts`](apps/api/src/llm-token.ts)) using the
following priority order. The **first source that returns a credential
wins**; later sources are not consulted.

| # | Source | Trigger | `via` log tag |
|---|--------|---------|---------------|
| 1 | Azure AI Foundry via env vars | `AZURE_AI_INFERENCE_ENDPOINT` + `AZURE_AI_INFERENCE_API_KEY` both set | `azure-ai-foundry-env` |
| 2 | Azure AI Foundry via Token Manager | At least one `azure-ai-foundry` key registered at the Portal `/secrets/keys/new` (recommended for integration / prod — credentials live in Key Vault, the API round-robins across valid keys) | `azure-ai-foundry-token-manager` |
| 3 | GitHub Models via env var | `GITHUB_MODELS_API_KEY` set | `github-models-env` |
| 4 | GitHub Models via Token Manager | A `github-models` key registered at `/secrets/keys/new` | `github-models-token-manager` |
| 5 | Bare GitHub token fallback | `GITHUB_TOKEN` set | `github-token` |

**Two important properties of this chain:**

- **Foundry beats GitHub Models, and env vars beat the Token Manager
  within each backend.** Having both a Foundry env var and a registered
  `github-models` key means every call goes to Foundry; the GitHub
  Models key is dormant.
- **There is no automatic failover at request time.** The chain only
  steps down when the predecessor returns *nothing* (env var unset, no
  key registered). It does **not** step down when the predecessor
  returns a credential that then 4xx/5xx's on the actual chat-completion
  call. This is intentional — silent fallback would mask misconfiguration
  (e.g. a wrong Foundry deployment name) and hide the real error from
  the user.

If no source returns a credential, the portal's AI buttons return HTTP
`503` with a single actionable error message (`LLM not configured: no
inference backend available. Please register a new secret key for GitHub
Model or Azure Foundry.`), and the rest of the API works unchanged.

Every successful acquisition also logs a single line so operators can
verify which provider served a given AI call:

```
[llm-token] inference provider: source=azure-ai-foundry via=azure-ai-foundry-env endpoint=https://<resource>.services.ai.azure.com/models model=gpt-4.1-mini
```

> **Local dev with Docker Compose:** the Foundry-related variables
> (`AZURE_AI_INFERENCE_ENDPOINT`, `AZURE_AI_INFERENCE_API_KEY`, and `LLM_MODEL`)
> must live in **`.env.local`** at the repo root, **not** `.env`. The `.env`
> file is auto-generated per worktree by `worktree-env` and will overwrite
> manual edits. `.env.local` is gitignored and is loaded into the `api`
> service via Compose's `env_file:` directive (`required: false`).
>
> ```bash
> cp .env.local.example .env.local
> # edit .env.local with your Foundry endpoint, key, and model
> docker compose up -d --force-recreate --no-deps api
> ```
>
> Compose only re-reads `env_file:` when the container is **created**, so
> `docker compose restart api` will *not* pick up `.env.local` changes.
> Use `--force-recreate` (or restart the whole stack with
> `pnpm docker:up:copilot` / `pnpm docker:dev:copilot`) after editing the
> file.

### AZURE_AI_INFERENCE_ENDPOINT
**Required (with `AZURE_AI_INFERENCE_API_KEY`) to use Azure AI Foundry**
**Type:** URL string

Base URL of the Azure AI Foundry inference endpoint (e.g.
`https://<foundry-resource>.services.ai.azure.com/models`). When set together
with `AZURE_AI_INFERENCE_API_KEY` the API issues all portal-LLM calls to this
endpoint and ignores GitHub Models. This is the recommended production
configuration: GitHub Models' public endpoint regularly takes >1 minute under
load (see [#847](https://github.com/growth-ecosystems/scope-core/issues/847)),
while a Foundry deployment of the same model returns in well under a second.

> **The `/models` suffix is required.** The Azure portal shows the resource
> URL without it, but the inference data plane only responds on
> `/models/chat/completions`. Without the suffix every call returns HTTP
> 404 "Resource not found". The API auto-appends `/models` when it detects
> a bare `services.ai.azure.com` host and emits a warning at startup, but
> you should fix the env var to silence it.
>
> ```
> ✅ https://<resource>.services.ai.azure.com/models
> ❌ https://<resource>.services.ai.azure.com
> ```

- **Docker Compose:** put in `.env.local` (see note above).
- **Kubernetes:** sourced from the `azure-ai-inference-secrets`
  ExternalSecret (Key Vault key `azure-ai-inference-endpoint`).

### AZURE_AI_INFERENCE_API_KEY
**Required (with `AZURE_AI_INFERENCE_ENDPOINT`) to use Azure AI Foundry**
**Type:** string

API key for the Foundry endpoint.

- **Docker Compose:** put in `.env.local` (see note above).
- **Kubernetes:** sourced from the `azure-ai-inference-secrets`
  ExternalSecret (Key Vault key `azure-ai-inference-api-key`).

### GITHUB_MODELS_API_KEY
**Optional (used as fallback when Foundry is not configured)**
**Type:** string

GitHub personal access token (with the `models` read permission) used to
authenticate with GitHub Models (`https://models.inference.ai.azure.com`).
Useful for local dev where no Foundry endpoint is available. Goes in `.env`
(or `.env.base`) since it is read via Compose variable substitution, not
the api service's `env_file`.

> **Note:** This is separate from `GITHUB_TOKEN`, which is used by the Judge
> and worker services for Copilot SDK / ACP access and does **not** need the
> `models` permission. If `GITHUB_MODELS_API_KEY` is unset the API also
> accepts `GITHUB_TOKEN` (or `TOKEN_MANAGER_URL` with a registered
> `github-models` token) as a fallback.

### LLM_MODEL
**Default:** `gpt-4.1` (applied inside the API when unset)
**Type:** string

Model name / deployment name used by both backends. For Foundry, this must
match the deployment name on the Foundry resource. Examples: `gpt-4.1`,
`gpt-4o`, `gpt-4.1-mini`, `gpt-5.4-mini`. Put in `.env.local` (see note above).
The API discovers supported token-limit and sampling parameters from structured
inference errors at runtime. Learned compatibility is cached in each API
process by endpoint and deployment name. It is relearned after a process
restart or when Azure rejects a previously accepted request shape.

## Prompt Storage Configuration

### PROMPT_INLINE_MAX_BYTES
**Default:** `16384` (16 KB)
**Type:** integer (UTF-8 byte length)
**Used by:** API (`apps/api`)

Threshold deciding where a task/AGENTS.md prompt body is stored. A body whose
UTF-8 byte length is at/under this value is stored **inline** in Mongo (`text`);
a larger body is uploaded to blob storage (`prompts/{promptId}.txt`) and the doc
references it via `contentBlobUrl` with no inline `text`. The decision is purely
size-based — independent of the prompt's `type`. Small task prompts stay inline
(today's behavior); large AGENTS.md bodies go to blob automatically.

## Project Scoping Configuration

Data Organization: Projects introduces a first-class **Project** container and an
immutable `projectId` on every user-scoped entity. See
[db.md § Project scoping (migration 025)](docs/architecture/db.md#project-scoping-migration-025)
and [app-design.md § Data Organization: Projects](docs/architecture/app-design.md#data-organization-projects).

### SCOPE_PROJECT
**Default:** _none_
**Type:** string (project ID)
**Used by:** CLI (`apps/cli`)

Project ID the CLI uses to scope commands when `--project` is omitted.
Resolution precedence is `--project <id>` → `SCOPE_PROJECT` → the saved selection
from `scope project use <id>` (persisted in `~/.config/scope/config.json`). There
is **no default project**: if none of these resolves, scoped lists and creates
**fail fast** with an error asking you to pick a project
(`scope project use <id>`). Point reads by `_id` (e.g. `run get -i <id>`) are
globally unique and do not require a project.

### SCOPE_INITIAL_PROJECT_NAME
**Default:** `Initial Project`
**Type:** string
**Used by:** DB migration `025-create-projects` (`packages/db-migrations`)

Human-readable name given to the single **initial project** that migration 025
seeds and files all pre-existing data into. Read once, only when the migration
first creates the project (a fresh UUID `_id`, **no `isDefault` flag**). On a
re-run the migration reuses the oldest existing project, so changing this value
after the initial run has no effect. It is an ordinary, re-nameable project — not
a fallback or default.

## Judge Strategy Configuration

### JUDGE_MODEL
**Default:** `gpt-5.4-mini`
**Type:** string

Model used by the judge to evaluate agent output against criteria. Defaults to
`gpt-5.4-mini` (set in code, docker-compose, and the K8s manifest). Override via
`JUDGE_MODEL` (e.g. in `.env`) to use a different model.

### FEEDBACK_MODEL
**Default:** `gpt-5.4-mini`
**Type:** string

Model used by the feedback generator that produces actionable feedback for the
coding agent between iterations. Defaults to `gpt-5.4-mini` (set in code,
docker-compose, and the K8s manifest). Override via `FEEDBACK_MODEL` (e.g. in
`.env`) to use a different model.

### JUDGE_STRATEGY
**Default:** `bundled`
**Options:** `bundled` | `independent`

- `bundled`: Evaluate all criteria in one judge session (faster, less granular)
- `independent`: Evaluate criteria separately in topological order with DAG awareness (slower, more accurate, skips descendants of failures)

### JUDGE_MAX_PARALLELISM
**Default:** `3`
**Type:** integer

Maximum number of criteria to evaluate in parallel when using `independent` strategy.

### JUDGE_TIMEOUT
**Default:** `480000` (8 minutes)
**Type:** integer (milliseconds)

Timeout for each Copilot SDK `sendAndWait` call. If the LLM takes longer than this to complete a response, the call will fail with a timeout error. Increase this if you see `Timeout after Xms waiting for session.idle` errors.

### JUDGE_RETRIES
**Default:** `3`
**Type:** integer

Number of retry attempts for judge-side LLM calls (`sendAndWait`). When a timeout or transient error occurs, the judge retries with exponential backoff (10s base, 30s max). Set to `0` to disable retries.

### JUDGE_CLIENT_TIMEOUT
**Default:** `600000` (10 minutes)
**Type:** integer (milliseconds)

Timeout for the HTTP request from workers to the judge service (`/api/v1/evaluate`). This covers the full end-to-end evaluation including all criteria. Increase this if you see `The operation was aborted due to timeout` errors in the multi-turn loop.

### JUDGE_CLIENT_RETRIES
**Default:** `2`
**Type:** integer

Maximum number of retry attempts when the judge client encounters a timeout or transient network error. Uses exponential backoff (5s base, 30s max). Set to `0` to disable retries.

### JUDGE_SKIP_PROTOCOL_CHECK
**Default:** `false`
**Type:** boolean (`true` to enable)

At startup the judge service runs a self-check that spawns the bundled Copilot CLI and asserts its ACP protocol version matches the installed `@github/copilot-sdk`. On a mismatch (e.g. the `@github/copilot` override in `package.json` drifted ahead of the SDK) the judge logs a clear fatal message and exits instead of serving opaque per-evaluation HTTP 500s. Set to `true` to bypass the check (not recommended).

### JUDGE_MAX_TOOL_CALLS
**Default:** `300`
**Type:** integer

Caps how many tool calls the judge's `list_tool_calls` tool returns in a single browse page. The judge assembles the coding agent's tool calls **cumulatively across every iteration of the run** (issue #1255), deduplicating byte-identical calls, so this bound keeps a long run's history from overflowing the judge's context. It applies **only** to the `list_tool_calls` browse page — `search_tool_outputs` (pattern search) and `get_tool_output` (fetch one call by global index) always reach the full deduped history, so a one-time action from an early iteration stays discoverable regardless of this cap.

## Feedback Configuration

### FEEDBACK_MAX_CRITERIA
**Default:** `1`
**Type:** integer

Maximum number of failed criteria to mention in feedback per iteration. The system automatically filters to root-cause failures only (failures whose parent criteria passed).

### FEEDBACK_DESCENDANT_GUARD
**Default:** `true`
**Type:** boolean (`true` | `false`)

When enabled, prevents feedback from hinting about descendant criteria (requirements that depend on the failed criterion). This ensures developers discover requirements progressively.

### CRITERIA_DIR
**Default:** `/app/config/criteria` (in Docker), `./config/criteria` (local)
**Type:** path

Path to the directory containing criteria definition YAML files for v2 scenarios.

## Codebase Configuration

### CODEBASE_MAX_EXTRACTED_BYTES
**Default:** `268435456` (256 MiB)
**Type:** integer (bytes)

Maximum total *uncompressed* bytes written while extracting a codebase archive (Git tarball or uploaded zip/tar). Guards against decompression bombs — the edge ingress cap limits compressed bytes only. Extraction is aborted with HTTP `413` once exceeded.

### CODEBASE_MAX_EXTRACTED_ENTRIES
**Default:** `50000`
**Type:** integer

Maximum number of entries (files + directories) extracted from a codebase archive. Aborts extraction with HTTP `413` once exceeded.

## Analysis Configuration

### ANALYSIS_MAX_RUNS
**Default:** `5000`
**Type:** integer
**Scope:** API (`apps/api`)

Maximum number of completed runs loaded into memory for a single Statistics / `GET /api/v1/analysis` pass. The endpoint fetches the most-recent `ANALYSIS_MAX_RUNS` done runs (sorted by `createdAt`, served by the existing `createdAt` index) with a slim projection, so server memory stays bounded as run history grows. When the cap is reached the response includes `truncated: true` and `runLimit`, and the portal shows a "most recent N runs" banner rather than dropping data silently or breaking the page. Raise it for richer all-time stats at the cost of memory; lower it on memory-constrained deployments.

## Portal Feature Flags

### VITE_SHOW_PASS_AT_K
**Default:** (not set, hidden)
**Type:** `"true"` | (any other value or unset)

When set to `"true"`, displays the Pass@k metrics table on the Insights page. By default, this table is hidden. This is a Vite env var and must be prefixed with `VITE_` to be exposed to the frontend.

## Portal Authentication (Microsoft Entra ID / MSAL)

Build-time (`VITE_*`) configuration for Portal sign-in via MSAL. These are
inlined into the bundle at build time (retargeting the IdP is a rebuild, not a
runtime change), matching the auth spec's "hardcoded per build" intent
(`docs/architecture/auth-rbac.md` §8, subtask 10).

In **dev** builds (`import.meta.env.DEV`) every value defaults to the seeded
[entra-local](https://github.com/cmaneu/entra-local) emulator (Docker tag
`0.0.3`), so sign-in works out of the box once the one-time local setup below is
done. In **production** builds the config is only considered valid when
`VITE_AUTH_CLIENT_ID` and `VITE_AUTH_AUTHORITY` are present; otherwise the Portal
renders a "not configured" screen instead of silently pointing at `localhost`.

**Docker builds:** the Portal Dockerfile accepts `VITE_AUTH_CLIENT_ID`,
`VITE_AUTH_AUTHORITY`, `VITE_AUTH_KNOWN_AUTHORITIES`, `VITE_AUTH_SCOPES`,
`VITE_AUTH_PROTOCOL_MODE`, `VITE_AUTH_REDIRECT_URI`,
`VITE_AUTH_POST_LOGOUT_REDIRECT_URI`, and `VITE_AUTH_CACHE_LOCATION` as build
arguments in its `builder` stage. Vite embeds them during `pnpm --filter portal
build`; setting these variables only on the final nginx container has no effect.
These are public client settings, not secrets; never pass client secrets or
access tokens as Portal build arguments.

- **Local Compose:** `pnpm docker:up:portal` forwards the settings from your shell
  or `.env.local` through `portal.build.args`, using the seeded emulator and
  per-worktree ports by default. `pnpm docker:dev:portal` supplies the same
  settings to the Vite dev-server environment instead.
- **CI:** the Portal image build in `.github/workflows/ci.yml` forwards the
  same-named GitHub Actions configuration variables (`vars.VITE_AUTH_*`).
  Configure at least the SPA client ID, authority, and the API's exposed scope
  before building an image intended for authenticated use. No GitHub variable
  values are provisioned by the workflow itself.
- **Direct Docker build:** supply the settings with `--build-arg`, for example:

  ```bash
  docker build -f apps/portal/Dockerfile -t scope-portal \
    --build-arg VITE_AUTH_CLIENT_ID="<spa-client-id>" \
    --build-arg VITE_AUTH_AUTHORITY="https://login.microsoftonline.com/<tenant-id>" \
    --build-arg VITE_AUTH_SCOPES="api://<api-client-id>/access_as_user" .
  ```

Rebuild and recreate the Portal after changing IdP settings. A single image
promoted between environments retains the same IdP settings; only
`SCOPE_AUTH_ENABLED` remains a runtime auth switch. Empty optional redirect
arguments retain the current Portal origin, while empty protocol/cache settings
retain their documented defaults. For Entra cloud through local Compose, also
set `VITE_AUTH_PROTOCOL_MODE=AAD` and `VITE_AUTH_KNOWN_AUTHORITIES=` to override
the emulator-specific defaults.

> The API verifies the IdP token on every non-public authenticated request, then
> resolves an active Scope user. Full route RBAC/ownership enforcement is still
> deferred. After a redirect callback, the Portal's first Scope API request is
> `POST /api/v1/users/me`; after a cached-account reload it is
> `GET /users/me`. `AuthContext` takes the Scope UUID and role from that response, not
> MSAL account claims. All eager queries, including feature flags, wait for it.

### ⚠️ IMPORTANT — Feature toggle (3 per-environment controls)

Portal auth is a **feature-flagged capability** with **three independent,
per-environment controls** — one each for **local dev**, **integration**, and
**production**. It is **ON by default (secure by default)** in every environment;
a control must **explicitly** opt out.

> **Coordinate API and Portal rollout per environment.** The API in this branch
> verifies bearer tokens and implements the explicit-login handshake. Do not infer
> a deployed environment's version or flag state from the source tree. Enable
> Portal auth after deploying/configuring the compatible API and verifying
> POST `/users/me` followed by GET `/me`. These controls are independent
> across environments and do not turn on global API lockdown.

When auth is disabled the Portal behaves **exactly as it did before auth
existed**: no sign-in gate, no account menu, and no `Authorization` header on API
calls. MSAL is never initialized.

**Why local is build-time but int/prod are runtime.** The production Portal image
is **built once and promoted** integration→production (the overlay `images.yaml`
files pin the same tag; see `.github/workflows/promote.yml`). A build-time
`VITE_*` flag is baked into that single image and therefore **cannot differ**
between integration and production. So int/prod are governed at **runtime** (an
env var read at container start), while local dev — which runs `vite dev`, not the
promoted image — uses a build-time flag.

| Environment | Control | Kind | Where to set | Default |
| --- | --- | --- | --- | --- |
| **Local dev** | `VITE_AUTH_ENABLED_LOCAL` | build-time (`import.meta.env.DEV`) | `docker-compose.dev.yml` or your shell | `true` |
| **Integration** | `SCOPE_AUTH_ENABLED` | runtime (container env) | integration portal deployment env | `true`; verify deployed override |
| **Production** | `SCOPE_AUTH_ENABLED` | runtime (container env) | production portal deployment env | `true`; verify deployed override |

**Type:** boolean-ish string. `true`/`1`/`yes`/`on` enable; `false`/`0`/`no`/`off`
disable (case-insensitive). Any other/unset value falls back to the secure
default (**enabled**).

**How it works at runtime (int/prod).** `SCOPE_AUTH_ENABLED` is read by
`apps/portal/docker-entrypoint.sh`, which writes `authEnabled` into `/config.js`
(→ `window.__SCOPE_CONFIG__.authEnabled`) when the container starts. The app reads
that value at load. This is the same mechanism already used for
`SCOPE_DOCS_BASE_URL`.

**Resolution precedence** (in `apps/portal/src/lib/auth/authConfig.ts`): the
runtime `window.__SCOPE_CONFIG__.authEnabled` (int/prod) wins whenever present;
otherwise, in local dev, `VITE_AUTH_ENABLED_LOCAL` applies; otherwise it defaults
to **enabled**. The dev `public/config.js` intentionally ships **no** `authEnabled`
so local always falls through to the Vite flag.

- **Local dev:** set `VITE_AUTH_ENABLED_LOCAL=false` in `docker-compose.dev.yml`
  (or your shell) to skip sign-in while iterating on UI, without standing up
  `entra-local`.
- **Integration / production:** set `SCOPE_AUTH_ENABLED=false` on the portal
  Deployment in that environment's overlay when an anonymous rollout is intended.
  No image rebuild is needed — it takes effect on the next
  pod start.

### Local dev setup (entra-local)

Sign-in works from a **single command** — no manual profile flag, no manual cert
trust, and no manual redirect-URI registration. Any `pnpm docker:dev:*` script
that starts the Portal (e.g. `pnpm docker:dev:copilot`, `pnpm docker:dev:portal`,
`pnpm docker:dev:all`) automatically:

1. Ensures a locally-trusted TLS cert exists via **mkcert** (`scripts/ensure-dev-certs.sh`,
   invoked by `scripts/dev-compose.sh`). mkcert installs a local root CA into the
   OS/browser trust store and mints `.certs/entra-local.pem` for `localhost`,
   loopback IPs, and the Compose hostname `entra-local`, so
   `https://localhost:<ENTRA_LOCAL_PORT>` is trusted with no cert warning. Older
   localhost-only certificates, certificates nearing expiry, and certificates
   signed by a different CA are regenerated automatically. The public CA is
   exported to `.certs/rootCA.pem`; the CA private key is never copied. MSAL
   requires the authority to be served over HTTPS, which is why the emulator uses
   TLS rather than plain HTTP.
2. Stages the public CA into a separate `entra_local_ca` volume. The API,
   emulator health check, and redirect-registration helper mount it read-only
   and use `NODE_EXTRA_CA_CERTS=/ca/rootCA.pem`. The API never mounts the
   emulator's private key, and TLS certificate verification stays enabled for
   both local and external HTTPS calls.
3. Starts the `entra-local` emulator (compose `auth` profile, added automatically
   by the dev scripts). `PUBLIC_ORIGIN`/`ISSUER` are pinned to
   `https://localhost:${ENTRA_LOCAL_PORT}` so the OIDC discovery document's
   `issuer`/endpoints use the host-facing port (the container binds `8443`
   internally; per-worktree port offsets would otherwise leak into the issuer and
   fail MSAL's authority match).
4. Runs the one-shot `entra-local-init` service, which waits for the emulator to
   become healthy and idempotently registers `http://localhost:${PORTAL_PORT}` as
   a `spa` redirect URI on the seeded Sample SPA app (the seed ships only
   `https://localhost:3000`, and each worktree gets its own `PORTAL_PORT`).

**Prerequisites:** [mkcert](https://github.com/FiloSottile/mkcert) and `openssl`
must be installed (`brew install mkcert nss` on macOS, with `openssl` available
on `PATH`). The first run triggers `mkcert -install`,
which asks for your password once to add the local CA to the system trust store.
For a browser using that same trust store, this is the only interactive step.

For WSL, remote development, or an integrated browser with a separate trust
store, trust `.certs/rootCA.pem` on the machine or in the browser that opens the
Portal as well. `mkcert -install` in the development shell cannot configure a
different browser host. An `ERR_CERT_AUTHORITY_INVALID` error when MSAL fetches
the emulator's discovery document means that browser-side trust is still
missing; do not work around it by disabling TLS verification. Import only the
public CA certificate, never `rootCA-key.pem` or the emulator private key.

For a Windows browser with a WSL development shell, run
`wslpath -w "$PWD/.certs/rootCA.pem"` in WSL to obtain the Windows path, then
use an interactive Windows PowerShell session:

```powershell
Import-Certificate -FilePath "<Windows path printed by wslpath>" -CertStoreLocation Cert:\CurrentUser\Root
```

Review and approve the Windows certificate confirmation, then reload the Portal
(restart the browser if it still caches the old trust result). This trusts
certificates signed by the development CA for the current Windows user, not
only the Scope certificate; it does not import a private key or require a
machine-wide trust change.

The CA initializer is optional when the `auth` profile is not enabled, so
cloud-only Compose setups do not require mkcert. Set `NODE_EXTRA_CA_CERTS=` in
that case to use only Node's normal CA trust store and avoid a missing-local-CA
warning on a fresh volume. After rotating the local CA, recreate the API and
emulator containers and update browser-side CA trust: Node reads extra CA
certificates only at process startup.

Then open the Portal at `http://localhost:${PORTAL_PORT}`, click **Log in**, and
sign in with a seeded user (`alice@entralocal.dev` / `bob@entralocal.dev`).

> `ENTRA_LOCAL_PORT` and `PORTAL_PORT` are derived per-worktree by
> `scripts/worktree-env.sh` from the `*_PORT` base values in `.env.base`
> (`ENTRA_LOCAL_PORT` base is `8500`). The compose files inject the resolved
> `VITE_AUTH_AUTHORITY`/`VITE_AUTH_KNOWN_AUTHORITIES` into the Portal dev
> container so the browser always targets the correct per-worktree emulator.

### VITE_AUTH_CLIENT_ID
**Default (dev):** `cccccccc-0000-0000-0000-000000000001` (entra-local seeded "Sample SPA" app)
**Type:** GUID string

Client ID of the SPA app registration. entra-local uses the app's object id as
its client id, so this is the value the emulator seeds and exposes at
`/admin/api/apps`. Required in production.

### VITE_AUTH_AUTHORITY
**Default (dev):** `https://localhost:8443/11111111-1111-1111-1111-111111111111/v2.0`
**Type:** URL string

OIDC authority (issuer) URL. Required in production (e.g.
`https://login.microsoftonline.com/<tenant-id>`).

### VITE_AUTH_KNOWN_AUTHORITIES
**Default (dev):** `localhost:8443`
**Type:** comma-separated host list

Hosts MSAL is allowed to talk to for non-Microsoft (custom OIDC) authorities.
Required for entra-local; typically unset for production Entra.

### VITE_AUTH_SCOPES
**Default (dev):** `api://cccccccc-0000-0000-0000-000000000005/access_as_user`
**Type:** comma-separated scope list

Scopes requested for the API access token (in addition to `openid`/`profile`,
which are always requested at login). Must be the API's exposed scope in
resource-qualified form so MSAL can resolve the access token's audience, e.g.
`api://<api-client-id>/access_as_user`.

### VITE_AUTH_PROTOCOL_MODE
**Default (dev):** `OIDC` — **Default (prod):** `AAD`
**Type:** `AAD` | `OIDC`

MSAL protocol mode. entra-local speaks generic `OIDC`; production Microsoft
Entra uses `AAD`.

### VITE_AUTH_REDIRECT_URI
**Default:** `window.location.origin`
**Type:** URL string

Redirect URI for the auth-code + PKCE flow. Must exactly match a redirect URI
registered on the app. In local dev this defaults to `window.location.origin`
(`http://localhost:${PORTAL_PORT}`), which the `entra-local-init` service
registers automatically — no manual step needed.

### VITE_AUTH_POST_LOGOUT_REDIRECT_URI
**Default:** `window.location.origin`
**Type:** URL string

Where MSAL navigates after sign-out.

### VITE_AUTH_CACHE_LOCATION
**Default:** `localStorage`
**Type:** `localStorage` | `sessionStorage`

Where MSAL persists its **IdP token** cache. This is unrelated to the API's Redis
user-access cache (`AUTH_USER_CACHE_TTL_SECONDS`). No Scope session token or
additional browser bearer store is introduced.

## Portal Runtime Configuration

### SCOPE_DOCS_BASE_URL
**Default:** `https://urban-disco-1qzzq7z.pages.github.io`
**Type:** URL string
**Scope:** Portal container (runtime)

Base URL for the public Scope docs site that in-app help tooltips link to. Unlike `VITE_*` flags (which Vite inlines into the bundle at build time), this is read at **container start**: the portal's entrypoint regenerates `/config.js` from this variable and the frontend reads it via `window.__SCOPE_CONFIG__.docsBaseUrl`. This means a single built image can be promoted across environments and still point at the correct docs deployment without a rebuild — set or override it via the portal's Kubernetes Deployment env. In local Vite development the static `apps/portal/public/config.js` provides the default.

## Docker Build Configuration

### NPM_REGISTRY
**Default:** `https://registry.npmjs.org/`
**Type:** URL string
**Scope:** Node image builds

Registry used to install pnpm and workspace dependencies in every Node Docker
image. Docker Compose forwards this value to all Node service builds, including
services behind optional profiles. For example:

```bash
NPM_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ docker compose build api
```

## Setting Variables

### Docker Compose
Variables can be set in docker-compose.yml or overridden via environment:

```bash
JUDGE_STRATEGY=independent docker compose up
```

### Local Development
Create a `.env` file in the project root:

```bash
JUDGE_STRATEGY=independent
JUDGE_MAX_PARALLELISM=5
FEEDBACK_MAX_CRITERIA=2
FEEDBACK_DESCENDANT_GUARD=true
```

## Example Configurations

### Fast Evaluation (Default)
```env
JUDGE_STRATEGY=bundled
```

### Thorough Evaluation with DAG
```env
JUDGE_STRATEGY=independent
JUDGE_MAX_PARALLELISM=3
FEEDBACK_MAX_CRITERIA=1
FEEDBACK_DESCENDANT_GUARD=true
```

### Debug Mode (Show More Failures)
```env
JUDGE_STRATEGY=independent
JUDGE_MAX_PARALLELISM=5
FEEDBACK_MAX_CRITERIA=3
FEEDBACK_DESCENDANT_GUARD=false
```

## Report Generator Configuration

### AZURE_STORAGE_QUEUE_REPORT
**Default:** `report-queue`
**Type:** string

Azure Storage Queue name for report generation jobs. The API enqueues messages here when a report is requested; the report-generator worker polls this queue.

### REPORT_MODEL
**Default:** `gpt-5.4-mini`
**Type:** string

The LLM model used by the report-generator worker (via the Copilot SDK) to generate run analysis reports. Examples: `gpt-5.4-mini`, `gpt-4.1`, `gpt-4o`, `claude-sonnet-4`.

### SCOPE_MT_API_URL
**Default:** `http://localhost:3001` (local), `http://api:80` (Docker)
**Type:** URL string

Base URL of the Scope API. The report-generator worker calls this to fetch run data (summary, turns, criteria trajectory) via REST tools during report generation.

### SESSION_TIMEOUT_MS
**Default:** `300000` (5 minutes)
**Type:** integer (milliseconds)

Timeout for the Copilot SDK session used by the report-generator worker. If the LLM takes longer than this to generate a report, the session will be terminated and the report marked as failed.

### GIT_COMMIT
**Default:** `development`
**Type:** string

Git commit hash embedded in reporter metadata. Automatically set during CI/CD builds. Used to track which version of the report-generator produced a given report.

## Scheduler Configuration

### SCHEDULER_POLL_INTERVAL_MS
**Default:** `2000`
**Type:** integer (milliseconds)

How often the request scheduler polls MongoDB for pending requests to dispatch to coder workers. Applies to all worker types. Lower values reduce queue latency; higher values save RUs.

The scheduler refreshes agents and versions from the registry on every poll.
There is no `SCHEDULER_WORKER_TYPES` allowlist.

### SCHEDULER_QUEUE_RECONCILIATION_INTERVAL_MS
**Default:** `30000`
**Type:** positive integer (milliseconds, minimum 1000)

How often the scheduler aggregates queued requests in MongoDB to detect stale
queue assignments and refresh its queued-request counts. The scheduler caches
those counts between reconciliations and increments them when it dispatches, so
the two-second dispatch loop does not repeat the RU-consuming aggregate.

### SCHEDULER_TARGET_QUEUE_DEPTH
**Default:** `5`
**Type:** positive integer

Maximum queued-request depth for each exact worker/version target discovered
from active `AgentVersion.queueName` records. The scheduler never derives a
queue name from the worker ID. Each active target must own a distinct physical
queue; a newer same-agent registration takes over its queue, registry writes reject
cross-agent queue reuse, and the scheduler fails legacy
conflicts closed.

### SCHEDULER_PP_POLL_INTERVAL_MS
**Default:** `30000`
**Type:** integer (milliseconds)

How often the post-processor dispatcher polls for completed runs needing post-processing. This is a **backfill/catch-up** mechanism — the primary dispatch path is event-driven (coder workers enqueue directly on run completion). The 30s default keeps idle RU consumption low while still catching missed events or version-upgrade backfills within a reasonable window. Reduce temporarily for large backfills.

### QUEUE_NAME_POST_PROCESSOR
**Default:** `post-processor-queue`
**Type:** string

Azure Storage Queue name used by both the scheduler (to enqueue post-processing work) and the post-processor worker (to dequeue). Must match between the two services.

### SCOPE_REAPER_ENABLED
**Default:** `false`
**Type:** boolean (`true` to enable)

Kill-switch for the scheduler's stuck-run reaper. **Disabled by default** — set to `true` (and ensure `REDIS_HOST` is set) to run a periodic backstop sweep that fails `processing` runs whose worker died without writing a terminal state and whose queue message no longer triggers recovery. When disabled, the queue redelivery path still operates. Redis is **non-fatal**: even when enabled, if `REDIS_HOST` is absent or the heartbeat store can't be constructed, the reaper self-disables and the dispatch loop keeps running.

### SCOPE_REAPER_POLL_INTERVAL_MS
**Default:** `60000`
**Type:** integer (milliseconds)

How often the stuck-run reaper sweeps MongoDB for stale `processing` runs. A run must look stale in **two consecutive** sweeps before it is reaped, so the effective time-to-reap after the staleness threshold is roughly one extra poll interval. Invalid/non-positive values fall back to the default.

### SCOPE_REAPER_MAX_PER_SWEEP
**Default:** `30`
**Type:** integer

Circuit-breaker bound on how many runs a single reaper sweep may fail. If a sweep would reap more than this, it **skips and logs loudly** instead — a high count implies a systemic slowdown (e.g. CosmosDB 429 storm lagging heartbeats fleet-wide) rather than that many independent worker deaths. Invalid/non-positive values fall back to the default.

The reaper reuses `SCOPE_RUN_HEARTBEAT_STALE_MS` (Worker Configuration, below) as its staleness threshold. The scheduler must therefore have Redis credentials (`redis-secrets`) to read per-run heartbeats; see [docs/architecture/queue-scheduler.md](docs/architecture/queue-scheduler.md#stuck-run-reaper-scheduler-backstop).

## Worker Configuration

### ACP_SESSION_TIMEOUT_MS
**Default:** `3600000` (60 minutes)
**Type:** integer (milliseconds)

Maximum time the `coder-acp-copilot` worker waits for a Copilot CLI ACP session to complete before terminating it. If the agent takes longer than this to produce a response, the session is killed and the iteration fails with a timeout error. Increase for complex tasks that require extended processing. Set to `0` to disable the timeout entirely (not recommended in production).

### COPILOT_AUTO_UPDATE
**Default:** `false` (set by the `coder-acp-copilot` and `coder-acp-copilot-windows` workers on the spawned CLI subprocess)
**Type:** boolean-ish (`"false"` to disable auto-update)

Disables the GitHub Copilot CLI's in-session auto-updater for the copilot workers. In headless `--acp --yolo` stdio mode the CLI otherwise downloads a newer binary mid-run, logs `restart to update`, and then **never restarts** — nothing relaunches it under ACP, so the process freezes after creating the ACP session but before its first model completion. The run records 0 turns / 0 AI calls / 0 tokens and rides the full `ACP_SESSION_TIMEOUT_MS` (60-min) timeout. See [issue #1179](https://github.com/growth-ecosystems/scope-core/issues/1179).

The workers set this env var in `buildSubprocessEnv` **and** pass `--no-auto-update` on the CLI args (belt-and-suspenders). This pins each run to the image's baked CLI version, making benchmarks deterministic and removing a per-cold-start binary download from the hot path. This is the actual fix for the hang — pinning the worker image version alone does **not** help, because the running binary still tries to update to "latest".

### CLAUDE_CODE_DISABLE_POLICY_SKILLS
**Default:** `1` (set in the `coder-acp-claude-code` Dockerfile)
**Type:** boolean-ish (`1` to disable, unset/`0` to allow)

Disables Claude Code "policy skills" — auto-loaded, Anthropic-managed Agent Skills — for the `coder-acp-claude-code` worker. As of `claude-agent-acp` 0.52.0 / `claude-agent-sdk` 0.3.191 the bundled agent auto-invokes a `claude-api` policy skill on ordinary coding prompts; its injected payload overflows the context window available to Claude **subscription** OAuth tokens, so the turn fails with `Internal error: Prompt is too long`. Earlier agent versions never loaded it. The worker's Dockerfile bakes this variable at the container level so every descendant process (the worker, `claude-agent-acp`, and the bundled `claude` binary it spawns) inherits it — setting it only on the immediate child process is not sufficient. Disabling these skills restores the prior behavior and keeps benchmark runs reproducible. Override by setting it to `0` in the deployment environment if policy skills are explicitly wanted.

### SCOPE_RUN_HEARTBEAT_STALE_MS
**Default:** `120000` (2 × `HEARTBEAT_VISIBILITY_SECONDS`)
**Type:** integer (milliseconds)

Threshold used by the queue-processor redelivery handler to decide whether an in-flight `processing` run is still alive. When a worker dequeues a duplicate message for a run already in `processing`, it reads the per-run liveness heartbeat from Redis (`run-heartbeat:<runId>`) and compares `Date.now() - lastBeat`:

- **≤ threshold** → original worker is alive; **re-defer** the duplicate (push its visibility out by `SCOPE_RUN_REDELIVER_DEFER_MS`), leave the run untouched. The message is **not** deleted — it is the recovery token if the original worker later dies hard.
- **> threshold** → worker presumed dead; mark the run failed atomically.
- **missing key** → fall back to `run.startedAt`. If picked up ≤ threshold ago, re-defer (transient race / Redis blip); otherwise mark failed.

Lower values fail crashed runs faster but increase the risk of false positives if the heartbeat is briefly delayed (network, throttling, GC). The default gives the per-run heartbeat (every 15s) a generous 8× margin. This value is also the staleness threshold used by the scheduler's stuck-run reaper — keep the scheduler and workers on the same value so both recovery paths agree on "worker dead". See [docs/architecture/queue-scheduler.md](docs/architecture/queue-scheduler.md#liveness-heartbeat--redelivery).

### SCOPE_RUN_REDELIVER_DEFER_MS
**Default:** value of `SCOPE_RUN_HEARTBEAT_STALE_MS` (`120000`)
**Type:** integer (milliseconds)

How far the queue-processor pushes out a duplicate message's visibility when the original worker is still alive (fresh heartbeat). The duplicate is re-deferred rather than deleted so the message survives as the at-least-once recovery token; each time it resurfaces, a fresh heartbeat re-defers it (cheap) and a stale heartbeat marks the run failed. Defaulting to the staleness threshold makes the re-check cadence match the staleness window.

### SCOPE_RUN_HEARTBEAT_REDIS_TTL_MS
**Default:** `300000` (5 × `HEARTBEAT_VISIBILITY_SECONDS`)
**Type:** integer (milliseconds)

TTL applied to per-run liveness heartbeat keys in Redis (`run-heartbeat:<runId>`). The TTL is refreshed on every beat (every 15s), so the key only expires when the worker stops beating. Set comfortably above `SCOPE_RUN_HEARTBEAT_STALE_MS` so a brief beat delay never causes premature TTL expiry; the default gives 2.5× the staleness threshold.

## API Authentication

The API verifies Microsoft Entra ID access-token signature/claims **before any
Redis/Mongo user lookup**. Every authenticated call keeps using the same IdP
bearer; there is no `/auth/login`, token exchange, Scope JWT, or signing secret.
`req.user` contains the resolved Scope UUID and database role, not an IdP role.

Only **`POST /api/v1/users/me`** creates missing users or refreshes
profile, `lastLoginAt`, and bootstrap-admin promotion. The upsert still precedes
the disabled-user check: an explicit login can update those fields before returning
`403`. `lastLoginAt` is the explicit upsert timestamp, not general activity or
trustworthy proof of an interactive sign-in. Every GET `/me` and other
routes read an existing active user from Redis, falling back to an exact
`(idp, tid, oid)` Mongo lookup on miss/unavailability; they never JIT or refresh profile.
Invalid/repeated/structured login values return `400`; HEAD never enrolls.

The `/users/me` responses, including failures, are **`Cache-Control: no-store`**.
Clients also use no-store; the enrollment POST has side effects and must never be
prefetched or polled. New CLI/raw-bearer identities must deliberately enroll through
it; already-enrolled callers remain compatible without any token change.

With auth unconfigured, the API still boots and uses the existing anonymous rollout,
so unauthenticated workers keep working. Partial auth configuration fails startup.
With auth configured, missing tokens remain anonymous except where a route requires
identity (`/users/me`); existing public exclusions remain unchanged. A verified
identity is never silently downgraded to anonymous: missing users are
`403 user_not_enrolled`, disabled users `403 user_disabled`, and the reserved `system`
principal `401`. Invalid/expired tokens on non-public routes are rejected with `401`
before cache access. Required Mongo/JWKS unavailability returns `503`; unexpected
implementation/database errors use the logged `500` path.

Full route RBAC/ownership enforcement is **not** part of this milestone. See
[the auth flow and method walkthrough](docs/architecture/auth-rbac.md#3-api-authentication-middleware).

### AUTH_USER_CACHE_TTL_SECONDS
**Default:** `300` (only when unset)
**Type:** positive safe integer (seconds)
**Scope:** API

Fixed, **non-sliding** lifetime of an existing active user's Redis snapshot.
Blank, zero, negative, fractional, nonnumeric, or unsafe values fail startup,
even when IdP auth is disabled.
This variable alone does **not** enable IdP authentication or count as partial
IdP configuration. Explicit login or successful Mongo fallback writes using
atomic `SET ... EX <ttl>`; hits only `GET` and never extend expiry.

Redis uses existing `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, and `REDIS_TLS`.
A missing/blank Redis host creates no cache client and logs rate-limited
unavailability; existing-user resolution falls back to Mongo.
The key is
`auth-user:v1:<encoded Mongo database namespace>:<encoded idp>:<encoded tid>:<encoded oid>`,
with each component independently encoded using `encodeURIComponent`. The namespace
is the configured MongoDB database name: independent databases sharing Redis must
use distinct database names/namespaces (or separate Redis instances). No new Redis
deployment or namespace secret is needed; verify this isolation in external
deployment overlays before rollout.

The repository's `.env.example`, `.env.local.example`, and API Compose environment
wire this TTL setting. No additional tracked deployment manifests with auth
configuration were found here; externally managed overlays and deployed values
must be checked separately.

Only validated active human principals are cached; no missing/disabled negative
entries, raw bearer tokens, or IdP-derived permissions. Invalid/mismatched payloads
are logged and evicted best-effort. Expected cache read/write/delete failures are
rate-limited in logs without tokens/PII and fall back to Mongo; recovery restores
caching. Connection/command waits are bounded, with no offline command queuing/replay
or process-local authorization cache. Cache-write failure does not discard a
successful Mongo result; required Mongo failure still fails the request.

Database-only role/disable edits can stay stale until TTL expiry. Future mutation
endpoints must evict this key; logout is not cache invalidation. No deployment-wide
immediate revocation guarantee is implied by this cache.

### AUTH_PROVIDER
**Default:** (not set)
**Type:** string (`entra`)

Selects the identity-provider implementation. Set to `entra` with the required
authority/audience settings to enable verification. When all IdP auth settings
are unset, auth is disabled and callers remain anonymous; setting other IdP
settings without `AUTH_PROVIDER` fails startup rather than disabling verification.

### AUTH_AUTHORITY
**Type:** URL string — **Required when `AUTH_PROVIDER` is set**

OIDC authority used to discover the JWKS (signing keys) and validate the token
issuer. For multi-tenant Entra apps this is typically
`https://login.microsoftonline.com/common`. Point it at the `entra-local`
emulator for offline development
(e.g. `https://localhost:8443/<tenant>`). The JWKS URI is derived as
`<AUTH_AUTHORITY>/discovery/v2.0/keys` unless `AUTH_JWKS_URI` is set. Scope
retains `jose`'s remote key caching and rollover behavior while additionally
validating the selected key's Entra-specific `issuer` metadata.

### AUTH_ISSUER_TEMPLATE
**Default:** `https://login.microsoftonline.com/{tenantid}/v2.0`
**Type:** URL template string with a `{tenantid}` placeholder

Per-tenant issuer the token's `iss` claim must match; `{tenantid}` is substituted
from each token's `tid`. Override this for a self-hosted issuer whose URL differs
from Entra cloud — e.g. the `entra-local` emulator uses
`https://localhost:8443/{tenantid}/v2.0`. Verification stays multi-tenant: any
tenant is accepted as long as its issuer matches this template. The selected
JWK's required `issuer` uses the same substitution rule when it contains
`{tenantid}`; otherwise it must exactly match the token issuer.

### AUTH_JWKS_URI
**Default:** derived as `<AUTH_AUTHORITY>/discovery/v2.0/keys`
**Type:** URL string

Explicit JWKS (signing keys) endpoint. Set this only when the JWKS URL cannot be
derived from `AUTH_AUTHORITY`. The `entra-local` emulator's default JWKS
(`<authority>/discovery/v2.0/keys`) already matches the derivation, so this is
usually left unset. Every selected key must contain a non-empty string `issuer`;
missing, malformed, ambiguous, or mismatched key issuer metadata rejects the
token.

> **entra-local compatibility prerequisite.** At the time this validation was
> introduced, the external `cmaneu/entra-local` JWKS omitted the `issuer`
> extension. Auth-enabled local development therefore requires an emulator
> version that publishes the configured per-tenant issuer on every signing key.
> This Scope change does not modify the external emulator.

> **Local dev TLS.** Compose trusts the emulator's mkcert CA through a read-only
> public-CA mount and `NODE_EXTRA_CA_CERTS`; the certificate covers the internal
> `entra-local` hostname as well as `localhost`. TLS verification remains enabled,
> including for external requests. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
>
> For a native API process, run `scripts/ensure-dev-certs.sh`, then launch with
> `NODE_EXTRA_CA_CERTS="$PWD/.certs/rootCA.pem" pnpm dev:api`. Use the host-facing
> `https://localhost:<ENTRA_LOCAL_PORT>/<tenant>/discovery/v2.0/keys` as
> `AUTH_JWKS_URI`, not the Compose-only `entra-local` hostname. Remove any old
> `NODE_TLS_REJECT_UNAUTHORIZED=0` override from the shell or local env files.

### AUTH_API_CLIENT_ID
**Type:** string (GUID) — **Required when `AUTH_PROVIDER` is set**

The API's App Registration (client) ID. Verified as the token `aud` (audience)
so tokens minted for other applications are rejected.

### AUTH_CLI_CLIENT_ID
**Type:** string (GUID)

The public client ID reserved for future CLI interactive sign-in configuration;
not used by API verification and not served by an `/auth/config` endpoint.

### AUTH_PORTAL_CLIENT_ID
**Type:** string (GUID)

Reserved client-configuration metadata; not used by API verification. The current
Portal uses build-time `VITE_AUTH_CLIENT_ID`, not this API setting or an
`/auth/config` endpoint.

### AUTH_SCOPES
**Default:** (empty)
**Type:** comma/space-separated string

Scopes intended for clients acquiring an API access token
(e.g. `api://<AUTH_API_CLIENT_ID>/access`). Not consumed by API verification or
served by a config endpoint; configure the current Portal through `VITE_AUTH_SCOPES`.

### AUTH_BOOTSTRAP_ADMINS
**Default:** (empty)
**Type:** comma-separated list of identity keys

Identities to promote to the `admin` role on explicit POST `/users/me`
enrollment or subsequent login refresh, formatted as
`${idp}:${idpTenant}/${idpSubject}` (e.g.
`entra:00000000-0000-0000-0000-000000000000/11111111-1111-1111-1111-111111111111`).
Promotion requires an exact match for the verified identity and an explicit tenant
match in `AUTH_BOOTSTRAP_TENANTS`. It is **promote-only**: an existing admin is never
demoted, and users not listed here are never auto-promoted.

Bootstrap does not depend on `email` or `email_verified`. Ordinary Entra workforce
and seeded entra-local identities can therefore bootstrap without custom email
claims when both allowlists match. Token verification remains required; this is
not a local authentication bypass. Email storage is unchanged: only an explicitly
verified profile email is persisted.

### AUTH_BOOTSTRAP_TENANTS
**Default:** (empty)
**Type:** comma-separated list of tenant IDs

Tenant allowlist that gates admin bootstrap. This setting is required when
`AUTH_BOOTSTRAP_ADMINS` is non-empty; otherwise the API fails startup. An
identity is promoted only when its tenant is explicitly listed here.

> **Future — Graph profile enrichment.** `email`/`displayName` are read directly
> from the verified token claims during explicit login today (no Microsoft Graph call, no client
> secret). A later On-Behalf-Of enrichment would introduce
> `AUTH_API_CLIENT_SECRET`; it is **not** used now.

## Token Manager Configuration

### TOKEN_MANAGER_URL
**Default:** (not set)
**Type:** URL string

Base URL of the Token Manager service. Workers, judge, and report-generator use the `TokenManagerClient` to dynamically acquire keys via `POST /api/v1/keys/acquire` (round-robin across enabled keys).

In Kubernetes, no static token secrets (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`) are injected into pods — all keys are acquired from the Token Manager at runtime. In local dev / Docker Compose, env vars can still be set as a fallback (the `TokenManagerClient` checks env vars first before calling the Token Manager HTTP API).

- **Docker Compose:** `http://token-manager:80`
- **Kubernetes:** `http://token-manager-service.scoped.svc.cluster.local:80`
- **Local dev:** Leave unset to use env var fallback (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, etc.)

### AZURE_KEYVAULT_URI
**Type:** URL string (token-manager only) — **Required**

Azure KeyVault URI for storing token secret values. The Token Manager uses `KeyVaultTokenStore` with `DefaultAzureCredential`.

- **Docker Compose:** Provided automatically via Lowkey Vault (Azure KV emulator): `https://lowkey-vault:8443`
- **Kubernetes:** Azure Key Vault URI (e.g., `https://my-vault.vault.azure.net`)
- **Local dev (no Docker):** Not supported without a vault; use Docker Compose

### VALIDATION_INTERVAL_MS
**Default:** `300000` (5 minutes)
**Type:** integer (milliseconds)

How often the Token Manager's scheduler validates all active tokens against their provider APIs. Each token is tested (e.g., GitHub PAT → `GET /user`, Anthropic → `GET /v1/models`) and its `lastValidationStatus` is updated in MongoDB.

### TOKEN_MANAGER_PORT
**Default:** `3102`
**Type:** integer (Docker Compose only)

Host port mapping for the token-manager service in Docker Compose.

## Kubedock Configuration (Container Access)

### DOCKER_HOST
**Default:** (none)
**Type:** URI string

Points to the Docker-compatible socket. When set, workers can create containers during Build/Test gates. The value is passed through to agent subprocesses so they can use standard Docker commands.

- **Kubernetes:** Set in deployment manifest to `unix:///var/run/kubedock/kubedock.sock` (auto-configured when kubedock sidecar is present)
- **Docker Compose:** Set to `unix:///var/run/docker.sock` (direct host socket mount)
- **Used by:** `coder-acp-copilot`, `coder-acp-claude-code` (subprocess passthrough)

### KUBEDOCK_ENABLED
**Default:** (none)
**Type:** boolean string (`true`)

Enables kubedock-specific container cleanup (purge on setup, remove on teardown). **Must only be set when kubedock is the Docker backend** — if set with a direct Docker socket, the cleanup will force-remove ALL containers on the host.

- **Kubernetes:** Set to `true` in deployment manifest (where kubedock manages container lifecycle)
- **Docker Compose:** Do NOT set (direct socket — no cleanup needed)
- **Used by:** `coder-acp-copilot`, `coder-acp-claude-code` (via `KubedockClient.isEnabled()`)

## Proxy & HAR Capture Configuration (Gateway / DevProxy)

Workers capture agent↔provider traffic as HAR via one of two interchangeable backends,
selected by `PROXY_BACKEND`. Both converge on the same `extractHarMetadata()` pipeline, so
HAR output is identical regardless of backend.

### PROXY_BACKEND
**Default:** `devproxy` (worker adapter default; deployment manifests set `gateway`)
**Type:** enum (`gateway` | `devproxy`)

Selects the proxy backend returned by `createProxyClient()` (`packages/shared/src/devproxy/index.ts`):

- `gateway` — the shared Rust [AI Gateway](docs/architecture/ai-gateway.md). Records both
  HTTP and **WebSocket** frames — required for Copilot CLI ≥ 1.0.65, whose `/responses`
  traffic is carried over a WebSocket that DevProxy's HTTP-only HAR generator cannot see.
  HAR is downloaded via the gateway session API, so no shared `har-output` volume is
  needed. Used by the VS Code Electron worker and both Copilot ACP workers (Linux + Windows).
- `devproxy` — the legacy per-worker [Microsoft DevProxy](https://github.com/dotnet/dev-proxy)
  sidecar. Records HTTP only; HAR is read from a shared filesystem volume. Still used by the
  ACP Claude Code worker.

### GATEWAY_TOKEN_PLUGIN_ENABLED
**Default:** `true` (effective only when `TOKEN_MANAGER_URL` is also set)
**Type:** boolean (`true` | `false`)

Only relevant when `PROXY_BACKEND=gateway`. When `true` (and `TOKEN_MANAGER_URL` is set) the
worker asks the gateway to enable the `copilot_token` plugin, which mints and refreshes
Copilot session tokens for that session. Set to `false` for workers whose agent manages its
own token lifecycle: both Copilot ACP workers set `false` because the Copilot CLI handles
token minting/refresh itself (enabling the plugin caused upstream 502s — #1058). The VS Code
Electron worker leaves it enabled.

### DEV_PROXY_ENABLED
**Default:** `false`
**Type:** boolean (`true` | `false`)

Enables DevProxy integration for capturing HTTP traffic as HAR files. When `true`, the worker starts/stops DevProxy recording around each coding agent session, extracts tool calls from the HAR, and uploads the HAR to blob storage.

- **Docker Compose:** Set via `DEV_PROXY_ENABLED=true` in `.env` or inline
- **Kubernetes:** Set in the deployment manifest env vars (auto-set when sidecar is present)

### DEV_PROXY_API_URL
**Default:** `http://localhost:18000`
**Type:** URL string

URL of the gateway/DevProxy REST API. Used to start/stop recording, check status, and download the CA certificate. Points at the gateway control API when `PROXY_BACKEND=gateway`, or the DevProxy management port when `PROXY_BACKEND=devproxy`.

- **Docker Compose (gateway):** `http://gateway:18000` (shared service — Copilot + VS Code Electron)
- **Docker Compose (devproxy, Claude Code):** `http://devproxy-claude-code:18897` (per-worker sidecar)
- **Kubernetes (gateway):** `http://gateway-service.scoped.svc.cluster.local:18000` (shared service)

### DEV_PROXY_HAR_DIR
**Default:** `/har-output`
**Type:** path

**`PROXY_BACKEND=devproxy` only.** Directory where DevProxy writes HAR files, shared between the DevProxy process and the worker via a volume mount. Unused by the gateway backend, which downloads HAR over HTTP instead of via a shared volume.

### DEVPROXY_COPILOT_API_PORT
**Default:** `18800`
**Type:** integer (Docker Compose only)

Host port mapping for the Copilot DevProxy REST API in Docker Compose.

## Observability

### OTEL_COLLECTOR_ENDPOINT
**Default:** *(none — collector mode disabled)*
**Type:** URL
**Used by:** All services

OTLP HTTP endpoint for an in-cluster OTel Collector gateway (e.g., `http://otel-collector.scoped.svc.cluster.local:4318`). When set, services export telemetry via OTLP HTTP to the collector instead of directly to App Insights. The collector handles forwarding to Azure Monitor via the `azuremonitor` exporter.

Takes priority over `APPLICATIONINSIGHTS_CONNECTION_STRING` for export mode selection. Automatically injected by the `otel-collector` Kustomize Component (`deploy/components/otel-collector/`).

### APPLICATIONINSIGHTS_CONNECTION_STRING
**Default:** *(none — telemetry disabled when unset)*
**Type:** Azure Application Insights connection string
**Used by:** API, all workers, judge, scheduler, token-manager, post-processor, report-generator, model-scanners

Connection string for Azure Application Insights. Used for direct export mode (when `OTEL_COLLECTOR_ENDPOINT` is not set). Also consumed by the OTel Collector's `azuremonitor` exporter when the collector component is deployed.

When both this and `OTEL_COLLECTOR_ENDPOINT` are unset, all telemetry calls are no-ops and the service operates normally without instrumentation.

The telemetry module is initialized via `initTelemetry()` from `packages/telemetry/` and must be called early in the service startup (before Express/MongoDB connections) to ensure auto-instrumentation patches are applied.

- **Docker Compose:** Set in `.env` file or leave unset for local development
- **Kubernetes:** Sourced from `appinsights-secrets` ExternalSecret (workers) or `appinsights-secrets` secretRef (API), which reads from Key Vault secret `appinsights-connection-string`

### TELEMETRY_SAMPLING_RATIO
**Default:** `1.0`
**Type:** float (`0.0`–`1.0`)
**Used by:** API, all workers

Fraction of telemetry that is sampled and exported to Application Insights. `1.0` sends everything; `0.0` sends nothing. Passed to Azure Monitor as `samplingRatio`. Invalid or out-of-range values fall back to `1.0`.

### TELEMETRY_LOG_LEVEL
**Default:** `Warning`
**Type:** string (`Verbose` | `Information` | `Warning` | `Error` | `Critical`)
**Used by:** all workers

Minimum severity level for forwarding subprocess/trace logs to Application Insights via `trackTrace()`. Only traces at or above this level are forwarded. Because subprocess logs are debug-level (`Verbose`), they are suppressed by default and only forwarded when set to `Verbose`.
