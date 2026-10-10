# Workers

The ACP coding-agent workers (`coder-acp-copilot`, `coder-acp-claude-code`)
are disabled by default in this chart — no MCPJungle/AI Gateway/Kubedock
sidecars are templated yet (see
[`docs/architecture/kubedock.md`](../../docs/architecture/kubedock.md) for
the intended production pattern). Bring them online with one command:

```bash
./scripts/bootstrap-workers.sh --acr <acrName>
```

This:

1. Builds and pushes both worker images with `az acr build`.
2. Prompts for the GitHub PAT and Anthropic API key they need, and
   registers them through the Token Manager API.
3. Runs `helm upgrade` to point each worker's image fields at the image it
   just built, and flips `workers.<name>.enabled: true`.
4. Waits for both Deployments to roll out.
5. Registers both agent types with the API (`scripts/register-agent.sh`).

Run `./scripts/bootstrap-workers.sh --help` for all flags, including
`--skip-build`, `--skip-secrets`, `--skip-copilot`, `--skip-claude-code`,
`--skip-agent-registration`, `-y`/`--yes` for non-interactive use, and
custom `--namespace`/`--release`/`--chart`/`--image-tag`.

> Pass `--values-file <path>` so the upgrade re-merges your original values
> override file against the chart's current defaults, instead of freezing a
> historical `--reuse-values` snapshot (which silently drops any default key
> added to `values.yaml` after your first `helm install`).

## Registering credentials another way

You don't have to go through the script's prompts:

- The Portal's **Create Token** page, or a direct `POST /api/v1/keys` call
  against the API, writes straight to Key Vault through token-manager's
  workload identity. No chart changes needed.
- Populating `secrets.keyVaultSecretNames.githubToken`/`.anthropicApiKey` in
  Key Vault yourself also works, as a static fallback — the worker only
  falls back to it when Token Manager has no credential registered.

## How the chart templates workers

Each worker's Deployment is templated by this chart
(`templates/workers/coder-acp-copilot/`,
`templates/workers/coder-acp-claude-code/`), reusing the common env
ConfigMap/Secret and Key Vault CSI mount the rest of the app uses. The
script just flips `workers.<name>.enabled: true` and sets
`workers.<name>.image.registry`/`.tag` with `helm upgrade --set`.

These are minimal background Storage Queue consumers only:

- No MCPJungle MCP-gateway sidecar (MCP server support).
- No AI Gateway/DevProxy sidecar (HAR capture).
- No Kubedock (in-task `docker build`/`docker run` support — see
  [`docs/architecture/kubedock.md`](../../docs/architecture/kubedock.md)
  for the intended production pattern).

Scenarios needing those features aren't supported by this chart yet.

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
