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
3. **Build/push the ACP coding-agent workers separately** —
   `coder-acp-copilot` and `coder-acp-claude-code` are *not* installed by
   this chart (they need the Kubedock/MCP-gateway sidecar pattern described
   in [`docs/architecture/kubedock.md`](../../docs/architecture/kubedock.md),
   which isn't templated here yet). Build and push those two images to the
   Bicep-provisioned **ACR** (`az acr build`), then register the
   GitHub/Anthropic credentials they need — either directly in Key Vault or
   via the running token-manager's admin API — and enable them with
   `helm upgrade` once their manifests exist. See
   ["Phase 3: ACP workers"](#phase-3-acp-coding-agent-workers-not-automated)
   below.

This chart only automates phase 2.

## What this does **NOT** automate

- Provisioning Azure infrastructure — that's `deploy/azure/`.
- Populating bring-your-own secrets in Key Vault (GitHub token, Anthropic API
  key, etc.) — add those yourself before or after installing this chart (see
  [Secrets](#secrets) below).
- Building/pushing the two ACP coding-agent worker images, or deploying them
  — that's the separate "Phase 3" step above; this chart disables both by
  default (`workers.coderAcpCopilot.enabled` / `workers.coderAcpClaudeCode.enabled`)
  and ships no Deployment templates for them yet.
- Registering agent types with the API (`scripts/register-agent.sh`) — a
  manual Phase 3 step alongside enabling the workers.
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
own fork's images). The `db-migrate` Job (a `pre-install,pre-upgrade` Helm
hook) runs automatically before the Deployments start.

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

## Phase 3: ACP coding-agent workers (not automated)

Once the core app is up, bring the two ACP workers online separately:

```bash
az acr build --registry <acrName> --image scope-coder-acp-copilot:latest \
  -f apps/workers/coder-acp-copilot/Dockerfile \
  --build-arg COPILOT_CLI_VERSION=$(grep COPILOT_CLI_VERSION apps/workers/coder-acp-copilot/versions.env | cut -d= -f2) .

az acr build --registry <acrName> --image scope-coder-acp-claude-code:latest \
  -f apps/workers/coder-acp-claude-code/Dockerfile \
  --build-arg CLAUDE_CODE_ACP_VERSION=$(grep CLAUDE_CODE_ACP_VERSION apps/workers/coder-acp-claude-code/versions.env | cut -d= -f2) \
  --build-arg CLAUDE_AGENT_SDK_VERSION=$(grep CLAUDE_AGENT_SDK_VERSION apps/workers/coder-acp-claude-code/versions.env | cut -d= -f2) .
```

Then register the GitHub/Anthropic credentials the workers need (see
[Secrets](#secrets) above — either Key Vault directly or the token-manager
API) and register each agent type with the API
(`scripts/register-agent.sh`, pointed at `API_URL`/`TOKEN_MANAGER_URL`).
Deploying the worker Pods themselves (with their Kubedock/MCP-gateway
sidecars) is not yet templated in this chart — see
`docs/architecture/kubedock.md` for the intended production pattern.
