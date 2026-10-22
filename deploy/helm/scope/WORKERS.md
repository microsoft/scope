# Workers

The ACP coding-agent workers (`coder-acp-copilot`, `coder-acp-claude-code`)
are disabled by default in this chart. Each gets an MCPJungle MCP-gateway
sidecar (`workers.<name>.mcpGateway`, enabled by default — see "MCP-gateway
sidecar" below); the AI Gateway/DevProxy sidecar and Kubedock are not
templated yet (see
[`docs/architecture/kubedock.md`](../../docs/architecture/kubedock.md) for
the intended production pattern). Bring them online with one command:

```bash
./scripts/bootstrap-workers.sh --acr <acrName>
```

This:

1. Builds and pushes both worker images with `az acr build`.
2. Runs `helm upgrade` to point each worker's image fields at the image it
   just built, and flips `workers.<name>.enabled: true`.
3. Waits for both Deployments to roll out.
4. Registers both agent types with the API (`scripts/register-agent.sh`).

The script does **not** register worker credentials. Add the GitHub PAT
and/or Anthropic API key each worker needs through the Portal's **Secrets**
tab (**Register key**) after the workers are up — see "Registering
credentials" below.

Run `./scripts/bootstrap-workers.sh --help` for all flags, including
`--skip-build`, `--skip-copilot`, `--skip-claude-code`,
`--skip-agent-registration`, and custom
`--namespace`/`--release`/`--chart`/`--image-tag`.

> Pass `--values-file <path>` so the upgrade re-merges your original values
> override file against the chart's current defaults, instead of freezing a
> historical `--reuse-values` snapshot (which silently drops any default key
> added to `values.yaml` after your first `helm install`).

## Registering credentials

Workers need a GitHub PAT (`coder-acp-copilot`) and/or an Anthropic API key
(`coder-acp-claude-code`) to drive their respective CLIs/SDKs. Register
these yourself, through either:

- The Portal's **Secrets** tab (**Register key**), or a direct
  `POST /api/v1/keys` call against the API, writes straight to Key Vault
  through token-manager's workload identity. No chart changes needed.
- Populating `secrets.keyVaultSecretNames.githubToken`/`.anthropicApiKey` in
  Key Vault yourself also works, as a static fallback — the worker only
  falls back to it when Token Manager has no credential registered.

## How the chart templates workers

Each worker's Deployment is templated by this chart
(`templates/workers/coder-acp-copilot/`,
`templates/workers/coder-acp-claude-code/`), reusing the common env
ConfigMap/Secret the rest of the app uses, but under their own
narrower-identity ServiceAccount (see "Worker identity isolation" below —
no Key Vault CSI mount). The script just flips
`workers.<name>.enabled: true` and sets
`workers.<name>.image.registry`/`.tag` with `helm upgrade --set`.

These are minimal background Storage Queue consumers, plus an MCPJungle
MCP-gateway sidecar:

- No AI Gateway/DevProxy sidecar (HAR capture).
- No Kubedock (in-task `docker build`/`docker run` support — see
  [`docs/architecture/kubedock.md`](../../docs/architecture/kubedock.md)
  for the intended production pattern).

Scenarios needing those two features aren't supported by this chart yet.

## MCP-gateway sidecar

Each worker Pod runs an [MCPJungle](https://github.com/mcpjungle/mcpjungle)
sidecar (`workers.<name>.mcpGateway`, enabled by default) that aggregates
MCP servers for the worker, mirroring docker-compose's
`mcp-gateway-copilot`/`mcp-gateway-claude-code` services:

- Templated as a **native sidecar** (`initContainers` entry with
  `restartPolicy: Always`, GA since Kubernetes 1.29) rather than a regular
  container, so kubelet starts it first and holds the Pod at `NotReady`
  until its `/health` readiness probe passes — the worker's first task
  never races a gateway that isn't listening yet.
- Shares an `emptyDir` volume mounted at `/workspace` with the worker
  container (compose's `copilot_workspace`/`claude_workspace` volumes).
- The worker reaches it at `http://localhost:8080` (same Pod — no
  `Service` object needed).

Set `workers.<name>.mcpGateway.enabled: false` only if your scenarios never
configure MCP servers.

## Worker identity isolation

Both ACP workers run benchmark-controlled agent code, so they get a
separate, narrower `ServiceAccount`/identity than the rest of the app:
`azure.workerWorkloadIdentityClientId`/`azure.workerServiceAccountName`
(Storage Blob/Queue only — no Key Vault access), instead of the shared
identity's Key Vault Secrets Officer role. Their pods also don't mount the
`kv-secrets` CSI volume. They still read `GITHUB_TOKEN`/`ANTHROPIC_API_KEY`
fallback values and `MONGO_CONNECTION_STRING`/`REDIS_PASSWORD` (needed to
claim/lock queue work) via `envFrom.secretRef` on the common K8s Secret —
that secret is synced by the `api` pod's own CSI mount, so the workers don't
need their own mount to receive it.

`scripts/generate-values-from-bicep.sh` picks up the worker identity's
outputs automatically if your Bicep deployment provisioned one; otherwise
those two values stay blank and are only required once you set
`workers.<name>.enabled: true`.

**Known limitation**: full isolation needs worker code changes this chart
can't make alone. `coder-acp-copilot`/`coder-acp-claude-code` are a single
process today — the same container that claims Storage Queue work via Mongo
and Redis also spawns the benchmark agent subprocess, so the pod can't be
handed queue credentials without also handing them to the agent's
environment/filesystem. True separation (a trusted queue-processor process
with no agent execution, and an executor with zero backend credentials —
`automountServiceAccountToken: false`, no Mongo/Redis/API-key env) is
tracked as follow-up work, not part of this chart.

## Agent versions

`workers.coderAcpCopilot.agentVersion`/`.coderAcpClaudeCode.agentVersion`
must match the `agentVersion` in whatever version manifest you register.
The script's defaults point at the `-dev` manifests under each worker's
directory — intended for chart smoke-testing only. For anything beyond
that, pass a real version manifest (and matching
`imageTag`/`queueName`/`gitCommit`/`buildTime`), and keep `values.yaml`'s
`agentVersion` fields in sync.

Agent registration doesn't run automatically on `helm install`/`upgrade` —
rerun `scripts/bootstrap-workers.sh` (or `scripts/register-agent.sh`
directly) whenever you roll a new worker image or version.
