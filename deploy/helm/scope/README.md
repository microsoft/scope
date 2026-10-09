# Scope Helm chart

Installs the Scope application onto the AKS cluster provisioned by
[`deploy/azure/`](../azure/README.md) (the "Deploy to Azure" Bicep template).

## Three-phase deployment

Deploying Scope end to end is three separate steps:

1. **Deploy Azure infrastructure** — `deploy/azure/` (the "Deploy to Azure"
   Bicep template) provisions AKS, Cosmos DB, Key Vault, Redis, Storage, ACR,
   and networking. It does **not** install the app.
2. **`helm install` the core app** (this chart) — api, portal, judge,
   token-manager, scheduler, and report-generator. Images are pulled from
   **GHCR** (`ghcr.io/<owner>/scope-<service>`, published by
   [`.github/workflows/publish-images.yml`](../../../.github/workflows/publish-images.yml))
   by default, so no registry build step is required for this phase — AKS
   pulls these public images directly.
3. **Bring the ACP coding-agent workers online separately** —
   `coder-acp-copilot` and `coder-acp-claude-code` are disabled by default
   in this chart (no MCPJungle/AI Gateway/Kubedock sidecars are templated
   yet — see [`docs/architecture/kubedock.md`](../../docs/architecture/kubedock.md)
   for the intended production pattern). Run
   `scripts/bootstrap-workers.sh --acr <acrName>` to build/push both worker
   images, prompt for and register their GitHub/Anthropic credentials,
   `helm upgrade` to enable the worker Deployments this chart already ships,
   and register both agent types with the API — all in one command. See
   ["Phase 3: ACP workers"](#phase-3-acp-coding-agent-workers) below.

This chart only automates phase 2.

## What this does **NOT** automate

- Provisioning Azure infrastructure — that's `deploy/azure/`.
- Populating bring-your-own secrets in Key Vault (GitHub token, Anthropic API
  key, etc.) — add those yourself before or after installing this chart (see
  [Secrets](#secrets) below).
- Building/pushing the two ACP coding-agent worker images, enabling their
  Deployments, or registering their agent types with the API — that's the
  separate "Phase 3" step above, disabled by default
  (`workers.coderAcpCopilot.enabled` / `workers.coderAcpClaudeCode.enabled`)
  and automated end-to-end by `scripts/bootstrap-workers.sh`.
- TLS/cert-manager or DNS — bring your own ingress controller and certificates.

## Prerequisites

- An AKS cluster with:
  - The **Azure Key Vault Secrets Provider** CSI driver add-on enabled
    (`--enable-addons azure-keyvault-secrets-provider`)
  - **OIDC issuer** + **workload identity** enabled
  - A user-assigned managed identity federated to
    `system:serviceaccount:<namespace>:<serviceAccountName>`, granted
    `Key Vault Secrets User` on the Key Vault and
    `Storage Blob Data Contributor` + `Storage Queue Data Contributor` on the
    Storage account

  All of the above is exactly what `deploy/azure/main.bicep` provisions.

- `helm` and `kubectl` configured against the target cluster.

## Install (Phase 2)

Read the Bicep deployment's outputs and populate a values override file:

```bash
az deployment group show \
  --resource-group <resource-group-name> \
  --name <deployment-name> \
  --query properties.outputs -o json
```

```yaml
# my-values.yaml
azure:
  tenantId: <your-tenant-id>
  keyVaultName: <keyVaultName>
  keyVaultUri: <keyVaultUri>
  workloadIdentityClientId: <workloadIdentityClientId>
  serviceAccountName: <workloadIdentityServiceAccountName>
  storageAccountName: <storageAccountName>
  redisHostName: <redisHostName>

api:
  ingress:
    enabled: true
    host: api.example.com

portal:
  ingress:
    enabled: true
    host: app.example.com
```

```bash
kubectl create namespace scope
helm install scope deploy/helm/scope -n scope -f my-values.yaml
```

This pulls all 6 core images from `global.imageRegistry` (defaults to
`ghcr.io/microsoft`, i.e. `ghcr.io/microsoft/scope-api`, etc. — override with
`--set global.imageRegistry=ghcr.io/<your-fork-owner>` if you publish your
own fork's images). The `db-migrate` Job (a `post-install,post-upgrade` Helm
hook) runs automatically after the Deployments are created.

## Configuration

See [`values.yaml`](./values.yaml) for the full set of configurable values —
every service section supports `enabled`, `image.{repository,tag,registry}`,
`replicas`, and `resources`. `image.registry` overrides `global.imageRegistry`
per-image — used by the workers (which point at ACR, not GHCR) and
`jobs.dbMigrate` (which needs a distinct `:builder`-tagged image; see
`templates/jobs/db-migrate.yaml`).

### Secrets

Two Azure auth patterns are used side by side:

1. **CSI-synced secrets** (static values like connection strings and API
   keys): listed in `secrets.keyVaultSecretNames`, synced from Key Vault into
   a single Kubernetes `Secret` (`secrets.k8sSecretName`) by the
   `SecretProviderClass`, and consumed via `envFrom.secretRef`.
   `mongoConnectionString` (`cosmos-connection-string`, a full connection
   string) and `redisPassword` (`redis-primary-key`, a bare access key —
   pairs with the non-secret `azure.redisHostName`/`redisPort`/`redisTls`
   values to form `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`/`REDIS_TLS`) are
   pre-populated in Key Vault by `deploy/azure/`. `githubToken`
   (`github-token`) and `anthropicApiKey` (`anthropic-api-key`) are
   bring-your-own and are what the ACP workers (Phase 3) and the portal's
   GitHub Models fallback (`apps/api/src/llm-token.ts`) read directly as
   plain `GITHUB_TOKEN`/`ANTHROPIC_API_KEY` env vars — this is the simplest
   path and bypasses token-manager entirely:

   ```bash
   az keyvault secret set --vault-name <keyVaultName> --name github-token --value <pat>
   az keyvault secret set --vault-name <keyVaultName> --name anthropic-api-key --value <key>
   ```

   Pods pick these up on their next restart (`kubectl rollout restart` after
   setting a secret, since the CSI driver only re-syncs on pod start/the
   configured polling interval).

2. **Via the token-manager API** (more capable: multiple keys per
   capability, round-robin, rotation, OAuth tokens) — register credentials
   directly against the running `token-manager` service instead of writing
   fixed-name Key Vault secrets:

   ```bash
   kubectl port-forward -n scope svc/scope-token-manager 3300:80
   curl -X POST http://localhost:3300/api/v1/keys \
     -H 'Content-Type: application/json' \
     -d '{"type":"github-oauth","value":"<token>","capabilities":["github-models","copilot-cli"]}'
   ```

   `token-manager` stores these itself (its own `DefaultAzureCredential`
   Key Vault client — see `azure.keyVaultUri`), independent of the
   `secrets.keyVaultSecretNames` list above. See `apps/token-manager/src/routes.ts`
   for the full `type`/`capabilities` enum.

3. **Direct workload identity** (in-process `DefaultAzureCredential` calls,
   no secret at all): used for Blob/Queue Storage access (RBAC-only) and by
   `token-manager` itself for its live Key Vault calls (option 2 above).

All Azure-dependent Pods run under the shared ServiceAccount named by
`azure.serviceAccountName`, which must match the Bicep template's federated
subject.

## Phase 3: ACP coding-agent workers

Once the core app is up, bring the two ACP workers online with one command:

```bash
./scripts/bootstrap-workers.sh --acr <acrName>
```

This builds/pushes both worker images via `az acr build`, interactively
prompts for (and registers via the Token Manager API) the GitHub PAT and
Anthropic API key they need, runs `helm upgrade --reuse-values` to point
each worker's `values.yaml` image fields at the image it just built and
flip `workers.<name>.enabled: true`, waits for both Deployments to roll
out, and registers both agent types with the API
(`scripts/register-agent.sh`). Run `./scripts/bootstrap-workers.sh --help`
for all flags (`--skip-build`, `--skip-secrets`, `--skip-copilot`,
`--skip-claude-code`, `--skip-agent-registration`, `-y`/`--yes` for
non-interactive use, custom `--namespace`/`--release`/`--chart`/`--image-tag`).

Credentials can also be registered manually instead of through the script's
prompts: the Portal's **Create Token** page (or a direct `POST /api/v1/keys`
call against the API) writes straight to Key Vault via the token-manager's
workload identity and requires no chart changes. Populating
`secrets.keyVaultSecretNames.githubToken`/`.anthropicApiKey` in Key Vault
yourself works too, as a static fallback the worker falls back to only if
Token Manager has no credential registered.

### What the script does under the hood

Each worker's Deployment is templated by this chart
(`templates/workers/coder-acp-copilot/`,
`templates/workers/coder-acp-claude-code/`), reusing the common env
ConfigMap/Secret and Key Vault CSI mount the rest of the app uses — the
script just flips `workers.<name>.enabled: true` and sets
`workers.<name>.image.registry`/`.tag` via `helm upgrade --set`. These are
minimal background Storage Queue consumers only: no MCPJungle MCP-gateway
sidecar (MCP server support), no AI Gateway/DevProxy sidecar (HAR capture),
and no Kubedock (in-task `docker build`/`docker run` support) — see
`docs/architecture/kubedock.md` for the intended production pattern for
that last one. Scenarios needing those features aren't supported by this
chart yet.

`workers.coderAcpCopilot.agentVersion`/`.coderAcpClaudeCode.agentVersion`
must match the `agentVersion` in whatever version manifest gets registered
— the script's defaults point at the `-dev` manifests under each worker's
directory, intended for chart smoke-testing only; pass a real version
manifest (and matching `imageTag`/`queueName`/`gitCommit`/`buildTime`) for
anything beyond that, and keep `values.yaml`'s `agentVersion` fields in
sync. Agent registration is not run automatically by `helm install`/
`upgrade` on its own — rerun `scripts/bootstrap-workers.sh` (or
`scripts/register-agent.sh` directly) whenever you roll a new worker image
or version.

## Quickstart: run a sample scenario

Scenarios and personas (`config/scenarios/`, `config/personas/`) are **not**
server-side data — `scope run submit --scenario <path> --persona <path>`
reads them straight off disk, so there's nothing to import for those. The
one piece that *is* server-side and project-scoped is **criteria**: several
scenarios (the `version: v2` ones) reference reusable criteria IDs like
`has_react`/`has_typescript` instead of inlining their own, and those IDs
must exist in the target project before the judge can evaluate a run
against them.

This seed step is deliberately **not** templated as a Helm hook. Unlike
`db-migrate`, it's project-scoped business data, not infrastructure, and no
project exists until the `db-migrate` Job's "Initial Project" migration has
run — baking a project assumption into the chart would be surprising for
anyone bringing their own projects. Run it yourself once the core app (and
at least one Phase 3 worker, to actually execute the run) is up:

```bash
kubectl -n scope port-forward svc/api 18080:80 &

# Discover the project to seed into (the "Initial Project" created by
# db-migrate on first install, or one of your own)
scope project list --url http://localhost:18080

# Import every reusable criterion (upsert — safe to rerun)
scope criteria import config/criteria --project <project-id> --url http://localhost:18080

# Try the simplest sample scenario end to end
scope run submit \
  --scenario config/scenarios/hello-world-express-v2.yaml \
  --persona config/personas/vibe-coder.yaml \
  --worker coder-acp-copilot \
  --project <project-id> \
  --url http://localhost:18080
```

`--worker` must be one of the agent IDs registered in Phase 3
(`scope agent list --url http://localhost:18080`). `hello-world-express-v2.yaml`
only needs `has_azure_doc`/`has_azure_azd` (plus their `has_iac`/`has_azure`/
`has_cloud` ancestors); importing the whole `config/criteria` directory is
simpler than cherry-picking a dependency closure and covers every sample
scenario, including `react-snake-game-v2.yaml`.

> **Note:** this quickstart surfaced (and this change fixes) a bug where
> `scope criteria import`/`scope prompt-feature import` never sent the
> `projectId` the API's `/criteria/seed`/`/prompt-features/seed` routes
> require, so both commands always failed with a 400. Make sure your CLI
> build includes the `--project` option on `criteria import` /
> `prompt-feature import` before following the steps above.

