# Devcontainer and Kind feasibility spike

Status: **phase one is incomplete; phases two through six have not started**.
The checked-in devcontainer is an experimental topology/auth probe, not a
complete Scope development environment. The broader implementation remains gated
on real local-browser and owner-private Codespaces PKCE login, including the
Portal/API handshake. Source inspection and localhost HTTP probes are not that
evidence. Existing Compose, worktree offsets, and k3d commands are unchanged.

## Prerequisites and isolation

The maintained Docker-in-Docker feature requires a **privileged outer container**.
The editor uses its own Docker daemon and persistent, devcontainer-scoped Docker
and containerd volumes, not a mounted host socket. This is **not a security
sandbox** for untrusted benchmark tasks. Use a disposable machine without
sensitive host mounts. Worker task toolchains still belong in worker images.

The spike uses Node 22.22.0, pnpm from the root `packageManager`, Kind 0.27.0,
kubectl 1.32.2, Compose 2.35.1, Buildx 0.22.0, Docker Engine 29.3.0, and the locked
DinD 4.1.3 feature. Release binaries use published checksums. Base/emulator/edge
and Kind node images are digest-pinned. Debian packages are **not snapshot-pinned**;
this is not the final reproducible toolchain. Node 24 selection, Rust, Python/uv,
browsers, Azure/PowerShell, and the remaining phase-two tools are still pending.

Initial sizing **targets, not verified minimums**: 4 CPUs / 16 GB for fast mode;
8 CPUs / 32 GB and at least 80 GB available disk for full Kind. On Docker Desktop,
configure the same CPU/RAM allocations and sufficient disk capacity under
Settings -> Resources (or the WSL2 resource configuration on Windows). The spike
bounds Compose concurrency at two; it does not start any workers. Full-stack
build and worker concurrency limits and cold/steady-state measurements remain
required. arm64 and Windows/macOS have not been validated; do not assume that
all images run natively on arm64. Windows worker execution and image validation
remain separate Windows targets, not Linux/Kind capabilities.

## Run the probe

Reopen the workspace in its devcontainer. Creation installs only locked root
dependencies. Attach prints guidance; it does not enroll users, migrate data,
run providers, restore a mode, or start watchers. The complete create/start/
attach lifecycle is phase-two work. No secrets or forwarding URLs are image
inputs. The experimental pnpm cache is devcontainer-scoped; do not reuse these
volumes between CPU architectures.

```bash
pnpm dev:spike doctor
pnpm dev:spike config
pnpm dev:spike up
pnpm dev:spike probe
pnpm dev:spike logs
pnpm dev:spike down
```

`doctor` reports tools, daemon availability, resources, and whether provider
credential variables are present, never their values. Presence does not prove
entitlement. It does not yet implement the complete resource/port/provider
acceptance checks. `config` generates ignored non-secret files under
`.dev-state/spike`. This spike uses **process environment > built-in defaults**;
it deliberately does not read or modify `.env.local` or worktree-generated
`.env`. A shared native/Compose/Kind precedence resolver is still required.

Inputs: `PUBLIC_ORIGIN`, `AUTH_TENANT_ID` (UUID), `EDGE_PORT` (Codespaces,
default 8080), `EDGE_TLS_PORT` (local, default 8443), and `SPIKE_ENTRA_PORT`
(internal loopback TLS, default 18443). Non-default local ports must be forwarded
unchanged. Stop, regenerate settings, and restart edge **and Vite** when the origin
changes. Startup rejects stale generated edge settings and occupied ports.

Codespaces resolves `https://${CODESPACE_NAME}-${EDGE_PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
at runtime, or uses an explicit `PUBLIC_ORIGIN` override for another remote
environment. Local origin defaults to `https://localhost:${EDGE_TLS_PORT}`.
Neither request `Host` nor forwarded headers establish trusted issuer settings.

Only forward the selected edge port. In Codespaces, keep it **private to its
owner**, with forwarding protocol **HTTP**, even though the external URL is
HTTPS. The configuration disables automatic forwarding. Authenticate to the
forwarded application with a top-level browser navigation. Never make Entra's
port public or inject a repository token into the browser. External REST clients
need forwarding-layer authentication separately from their unchanged IdP bearer;
internal CLI/API/JWKS requests must bypass that layer.

The probe starts **only Entra Local and dev-edge**, plus certificate staging.
It registers the exact current origin on the seeded SPA app via the loopback
admin endpoint. Only 201/already-present 409 succeed; bounded transient retries
and five-second request timeouts apply. It checks discovery URLs, every JWK's
external issuer, nginx discovery proxying, and denied admin/unknown-auth routes.
It does not perform interactive enrollment, logout, or model calls.

The edge runs in the editor network namespace, with native upstream slots
`localhost:3100` (API) and `localhost:5100` (Vite). **Those applications and their
infrastructure are not provisioned by this spike.** Portal/API routes return
502 until the applications run; this is not a usable full-stack browser URL yet.
API and auth routes precede SPA fallback; streaming and WebSocket upgrades are
configured. Full HMR/upload/download/SSE/artifact verification remains pending.

The generated `public.json` records external issuer/authority/redirect settings
and the native JWKS URL. It contains no credentials. It is not automatically
loaded into API/Vite. Compose and Kind settings must later use their own private
DNS JWKS addresses while preserving the external issuer and unchanged bearer
validation, including selected-key issuer checks. Exact Vite allowed hosts and
Codespaces `wss`/443 HMR configuration remain integration work.

## TLS and state

mkcert generates the CA in `.dev-state/spike/authority`, outside mounted leaf
certificates. **Never transfer `rootCA-key.pem`**. Only leaf certificates/keys and
the public `rootCA.pem` enter the certificate volume; clients receive public CA
material. The nginx, Node, and curl probes keep TLS verification enabled.
Generated state and certificates are excluded from image build contexts.

For a real local-host browser test, copy **only**
`.dev-state/spike/certs/rootCA.pem` to the host and import it into that host's
trusted root certificate store (and Firefox's store if separate). On Linux,
use the distribution's public-root installation procedure; macOS uses the System
Keychain; Windows uses Trusted Root Certification Authorities. Container-side
`mkcert -install` cannot establish host-browser trust. Remove the public root
from the host when retiring the environment. Codespaces browsers instead trust
GitHub's external certificate. Lowkey Vault trust is not configured in this spike;
its later integration must not reuse a TLS-verification bypass.

Normal `down`, container stop, and rebuild preserve emulator data in the scoped
Docker volume. CA files remain in the ignored workspace directory. Back up these
separately before deleting the workspace or outer Docker volumes. Destructive
reset requires the exact project name printed by `doctor`:

```bash
pnpm dev:spike reset-data --confirm=scope-spike-<workspace-hash>
```

This deletes only that Compose project's emulator/certificate volumes, including
registrations and signing keys, not other projects or the CA directory. It does
not remove a Kind cluster. Failed startup leaves state for diagnosis; use `logs`
and `down`, not global Docker prune/reset commands.

## Kind boot only

Stop the auth spike first; its Codespaces listener and Kind mapping both use
8080. The optional boot probe has no application manifests, PVCs or workers.

```bash
pnpm dev:spike kind-up
pnpm dev:spike kind-down
```

The single node maps NodePort 30080 to loopback 8080. No Service is installed by
the spike. Every client operation names the cluster context and
`.dev-state/spike/kubeconfig`; the default kubeconfig is untouched and the API
is never browser-forwarded. Kind deletion removes only this named cluster.
Persistent workload storage, ServiceAccounts/RBAC, Kubedock, and the full local
Kustomize stack remain phase-four work. No privileged kubeconfig or Docker/runtime
socket is mounted into application pods; none are deployed yet.

## Runtime inventory and remaining sequence

This is the reviewed coverage checklist for the later implementation, not a
claim that every target currently exists.

| Category | Required targets | Spike coverage |
| --- | --- | --- |
| Backing services | Replica-set MongoDB, Redis, all Azurite APIs, Lowkey Vault, Entra Local | Entra only |
| Initialization | Certificates, replica set, migrations, blobs/queues, redirects, agents/versions | Certificates and exact redirects only |
| Applications | API, Portal, Judge, token-manager, scheduler, Rust gateway | Edge upstream slots only |
| Workers | Copilot, Claude Code, report-generator, post-processor; existing enabled proxy/MCP sidecars | None; do not start paid workloads |
| Utilities | Copilot/Anthropic scanners, checked-in version checkers, cookie updater | None; explicit commands/jobs required |
| Developer tools | CLI, migrations, Vitest, Storybook, prompt evals, separate Astro install, Python environment | Focused Vitest tests only |
| Libraries | Workspace dependencies built/watched in dependency order | Not provisioned |
| Windows | Separate image/runtime, private tunnel, `C:/app` mapping, Windows CI | Existing Windows exception preserved |

After the real login gate: phase two supplies the full pinned toolchain and
lifecycle; phase three supplies replica-set infrastructure, native launch tasks,
container workers and host-gateway routes; phase four supplies all images,
Kustomize/Jobs, persisted Kind state and least-privilege identities/Kubedock;
phase five supplies runtime-wide debugging, supervised private tunnels and
validated Skaffold sync/rebuild; phase six supplies credential-free CI smoke,
opt-in trusted provider tests and the complete acceptance matrix. Proposed
`dev:doctor`, `dev:up --mode=...`, `dev:down`, and `dev:debug` commands are **not
implemented**; do not confuse them with `dev:spike`.

## Evidence ledger

Observed on 2026-11-02, Linux amd64 Codespaces host, 8 CPUs, 31.3 GiB RAM,
49 GiB initially free disk (below the full-Kind target):

| Check | Result |
| --- | --- |
| Origin, routing, retries, workspace names and metadata unit tests | 58 passed |
| Base spike image and maintained DinD feature | Built; privileged container started with CLI 0.90.0 |
| Dockerfile checks / isolated Compose configuration | Passed |
| DinD Entra + nginx HTTP and HTTPS probes | Passed with verified internal CA |
| Redirect repeated probe and stop/start | Passed without removing data volumes |
| Wrong-host TLS certificate | Rejected by curl with exit 60 |
| Kind internal `/readyz` with scoped kubeconfig | Passed; node readiness reported 17 seconds, not total cold-start time |
| Idle auth-only snapshot | Entra 51.15 MiB / 9.90% CPU; edge 8.434 MiB / 0.00% CPU; not a sustained/full-stack measurement |
| Real PKCE/refresh/logout, Portal POST enrollment/GET reload, invalid-token tests | **Not run; phase-one exit gate remains open** |
| Private forwarding, host-browser trust, HMR/SSE/downloads, full-stack/provider/debugger/RBAC/platform acceptance | **Not run** |

Immutable references used:

- Node 22.22.0 bookworm: `sha256:20a424ecd1d2064a44e12fe287bf3dae443aab31dc5e0c0cb6c74bef9c78911c`
- Entra Local 0.1.1: `sha256:70584ef110914d100409cb3d63a63548ccdde10ca780f9751755f1482dec5d7e`
- nginx 1.28.2 alpine: `sha256:5b4900b042ccfa8b0a73df622c3a60f2322faeb2be800cbee5aa7b44d241649e`
- Kind node 1.32.2: `sha256:142f543559cc55d64e1ab9341df08e5ced84bd2e893736da8f51320f26f5950b`
- DinD 4.1.3: feature digest/integrity in `.devcontainer/devcontainer-lock.json`.

No live-provider entitlement, cold full-stack build, sustained resource load,
debugger breakpoint, arm64, Docker Desktop, or Windows success is implied.