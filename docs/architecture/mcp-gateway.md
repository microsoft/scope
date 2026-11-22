# MCP Gateway Sidecar

MCPJungle sidecar per worker pod. Aggregates stdio and remote HTTP MCP servers behind a single streamable HTTP endpoint (`/mcp`). Enables ACP workers to use stdio servers (which require local filesystem access) alongside remote servers, with clean per-message isolation.

**POC**: `~/tmp/mcp-gateway-poc-devproxy` — validated stdio + remote HTTP + Dev Proxy HAR capture end-to-end.

---

## Traffic Flow

```
Worker process
  → MCPJungle /api/v0/* (registration)   — localhost, bypasses Dev Proxy
  → ACP session → localhost:8080/mcp     — localhost, bypasses Dev Proxy

Agent subprocess (copilot/claude-code)
  → Copilot API (HTTPS)                  — through Dev Proxy → captured in HAR
  → localhost:8080/mcp (tool calls)      — localhost, bypasses Dev Proxy

MCPJungle sidecar
  → stdio child process (/workspace)     — in-process, shared volume
  → remote HTTP (context7, etc.)         — direct outbound
```

Dev Proxy captures tool calls from the **Copilot API response body**. It never sees MCP wire traffic — that's fine, the tool names and arguments are fully captured in the LLM's response. The exact shape depends on the model's API: chat-completions models use `tool_calls[]`, while gpt-5.x uses the **Responses API** (`function_call` / `custom_tool_call` items). `extractToolCalls` (`packages/shared/src/har/har-parser.ts`) parses all supported formats — see [gates.md](../design/gates.md) §3 for the full list.

---

## Per-Message Lifecycle

```
1. Purge stale servers        GET /api/v0/servers → DELETE /api/v0/servers/{name} each
2. Resolve slugs              GET /api/v1/mcp/servers/:slug?projectId=<run's project> (Scope API)
3. Hydrate secrets            resolveSecrets(projectId, slug) → Token Manager {projectId, mcpId, name}
4. Register servers           POST /api/v0/servers?force=true (one per server, named by slug)
5. ACP session                mcpServers: [{ type: "http", url: "http://localhost:8080/mcp" }]
6. Agent runs                 tool calls go through gateway, captured in HAR via Copilot API
7. Cleanup (finally)          DELETE /api/v0/servers/{name} each
```

Step 1 is crash recovery — under normal operation step 7 cleans up. Both are needed.

**Project-scoped resolution.** Steps 2–3 both carry the **run's `projectId`**
(`requestDoc.projectId`, threaded through `queue-processor.ts` to
`McpServerClient.resolveServers(projectId, slugs)` and `McpSecretClient.resolveSecrets(projectId,
slug)`). A slug minted in one project no longer resolves inside another — resolution is the first
isolation layer. The gateway server is always **named by the human `slug`** (`config.slug`), never
the internal UUID `_id`: `mapToMcpServerConfig` sets `config.slug = data.slug ?? data._id` (the
`?? _id` fallback covers legacy pre-migration-027 rows whose `_id` is still the slug). If this ever
regressed to the UUID `_id`, the gateway would register/deregister and namespace tools
(`{slug}__{tool}`) under a UUID — breaking cleanup and the human-slug contract.

### Cross-project isolation invariant

Two projects may both define slug `ms-learn` pointing at **different** URLs/secrets. Because the
gateway names servers by **bare slug**, that could *in principle* collide — it doesn't, guaranteed by
two independent layers:

1. **Resolution (project-scoped).** Each run resolves its server by `{ projectId, slug }` and its
   secret by `{ projectId, mcpId, name }`, so the config registered for a run is always *that run's
   project's* config.
2. **Runtime serialization (pre-existing).** The gateway is a **localhost sidecar, one per worker
   pod**, and each pod drains its queue **strictly serially** (`base-queue-processor.ts` single
   `this.processing` flag). Every run `purgeAll()`s at setup and deregisters at teardown, so the
   gateway only ever holds **one run's** servers at a time — the bare-slug name cannot collide across
   projects.

> **⚠️ Invariant to protect.** This holds *only while a pod processes runs serially against a
> per-pod, bare-slug-keyed gateway*. If per-pod parallelism is ever raised above 1 while the gateway
> stays a shared per-pod sidecar, the `purgeAll()` + bare-slug model breaks (one run's purge/register
> clobbers another's). Preferred guard: **keep processing serial per pod**. If concurrency is later
> required, **namespace the gateway server name per run** (e.g. `{runId}__{slug}`) and update the
> tool-prefix/deregister contract accordingly. Proven live (MS Learn MCP, same slug across two
> projects) in the migration-027 validation gate.

---

## MCPJungle HTTP API (confirmed in POC)

| Method   | Path                         | Purpose                                   |
| -------- | ---------------------------- | ----------------------------------------- |
| `GET`    | `/health`                    | Health check (HEAD returns 404 — use GET) |
| `GET`    | `/api/v0/servers`            | List registered servers                   |
| `POST`   | `/api/v0/servers?force=true` | Register server                           |
| `DELETE` | `/api/v0/servers/{name}`     | Deregister server                         |
| `POST`   | `/mcp`                       | MCP streamable HTTP endpoint              |

Registration payload varies by transport:

```json
// stdio
{ "name": "filesystem", "transport": "stdio", "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "/workspace"],
  "session_mode": "stateful" }

// remote HTTP
{ "name": "context7", "transport": "streamable_http",
  "url": "https://mcp.context7.com/mcp" }
```

Tool names are namespaced: `{server-name}__{tool-name}` (e.g. `filesystem__read_text_file`).
For stdio servers, a stored `version` pins the executable package argument during
registration (`npx -y @scope/server@1.2.3` or `uvx server@1.2.3`). The server slug,
and therefore the names exposed to coding agents, stay unchanged. The gateway
is purged and re-registered for each run, so the current pin takes effect then.
Use `scope mcp server create --pkg-version <version>` or
`scope mcp server update --id <slug> --pkg-version <version>` to set the pin;
`scope mcp server get` displays it.

---

## Required Code Changes

### 1. `packages/shared/src/types/mcp.ts`

Extend transport type and `McpServerDocument` for stdio fields:

```typescript
export type McpTransportType = "sse" | "http" | "stdio";

export interface McpServerDocument {
  _id: string;
  name: string;
  type: McpTransportType;
  url?: string; // required for sse/http
  command?: string; // required for stdio
  args?: string[]; // stdio args
  env?: Record<string, string>; // stdio env vars
  headers?: McpServerHeader[]; // sse/http auth headers
  sessionMode?: "stateful" | "stateless";
  version?: string; // stdio only — npm package version
  description?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}
```

> **Post-migration-027 identity.** `_id` is now an internal **UUID** and the human slug lives in a
> separate `slug` field (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`), unique per project. Gateway
> registration/tool-namespacing/deregistration all key on **`config.slug`**, never `_id`. See
> [db.md → Per-project entity keying (migration 027)](db.md#per-project-entity-keying-migration-027).

> ⚠️ Secrets in `headers` and `env` are stored plaintext in MongoDB. Migrate to Key Vault (ESO) in a follow-up.

### 2. `packages/shared/src/mcp/mcp-gateway-client.ts` (new)

HTTP client wrapping the MCPJungle `/api/v0/` endpoints:

```typescript
export class McpGatewayClient {
  constructor(private baseUrl = "http://localhost:8080") {}
  async listServers(): Promise<string[]>; // GET /api/v0/servers → names[]
  async registerServer(doc: McpServerDocument): Promise<void>; // POST /api/v0/servers?force=true
  async deregisterServer(name: string): Promise<void>; // DELETE /api/v0/servers/{name}
  async purgeAll(): Promise<void>; // listServers → deregister each
  get mcpEndpoint(): string {
    return `${this.baseUrl}/mcp`;
  }
}
```

Transport mapping (`McpServerDocument.type` → MCPJungle `transport` field):

| DB type | MCPJungle transport |
| ------- | ------------------- |
| `http`  | `streamable_http`   |
| `sse`   | `sse`               |
| `stdio` | `stdio`             |

### 3. Worker `processMessage()` (both ACP workers)

Replace direct `mcpServers` pass-through with gateway lifecycle:

```typescript
const gateway = new McpGatewayClient();
await gateway.purgeAll();
for (const config of mcpConfigs) await gateway.registerServer(config);

try {
  result = await runACPSession(message, {
    mcpServers:
      mcpConfigs.length > 0
        ? [{ type: "http", name: "mcp-gateway", url: gateway.mcpEndpoint }]
        : [],
  });
} finally {
  for (const config of mcpConfigs) await gateway.deregisterServer(config.slug);
}
```

When `mcpConfigs` is empty, pass no `mcpServers` — gateway is never touched. **Deregister by
`config.slug`** (the name servers are registered under) — never `config._id`, which after migration
027 is an internal UUID.

### 4. `buildSubprocessEnv()` (both ACP workers)

Add `NO_PROXY` so the agent subprocess reaches the gateway directly:

```typescript
...(devProxyEnabled ? {
  NODE_OPTIONS: [..., "--use-env-proxy"],
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",   // Go binaries check lowercase
})
```

### 5. Portal — MCP server create/edit form

Add fields for stdio servers (shown/hidden based on `type` selection):

| Field         | Type                                 | When shown                    |
| ------------- | ------------------------------------ | ----------------------------- |
| `type`        | select: `http \| sse \| stdio`       | always                        |
| `url`         | text                                 | `http`, `sse`                 |
| `headers`     | key-value list                       | `http`, `sse`                 |
| `command`     | text                                 | `stdio`                       |
| `args`        | text (space-separated or JSON array) | `stdio`                       |
| `env`         | key-value list                       | `stdio`                       |
| `version`     | text                                 | `stdio`                       |
| `sessionMode` | select: `stateful \| stateless`      | always (default: `stateless`) |

### 6. API — MCP server CRUD

Update Zod schemas to validate stdio fields. `url` becomes optional (required only when type is `http`/`sse`); `command` required when type is `stdio`.

### 7. Docker Compose

Add MCPJungle sidecar service per worker profile and `NO_PROXY` env var:

```yaml
mcp-gateway-copilot:
  image: ghcr.io/mcpjungle/mcpjungle:latest-stdio
  volumes:
    - workspace_copilot:/workspace
  environment:
    SESSION_IDLE_TIMEOUT_SEC: "0"

coder-acp-copilot:
  environment:
    NO_PROXY: "...,mcp-gateway-copilot"
    MCP_GATEWAY_URL: http://mcp-gateway-copilot:8080
  depends_on:
    mcp-gateway-copilot:
      condition: service_healthy
```

Use `latest-stdio` image tag — the base image doesn't include `npx`/Node for stdio servers.

### 8. Kubernetes manifests

Add MCPJungle as a second container in each worker Deployment. Share the `workspace` emptyDir volume. No service needed (sidecar pattern — worker accesses via localhost).

---

## Key POC Findings

- MCPJungle management API is `/api/v0/` (not `/servers/` as the old design assumed)
- `SESSION_IDLE_TIMEOUT_SEC=0` disables idle timeout; `-1` is invalid
- `GET /health` works; `HEAD /health` returns 404
- `?force=true` on registration is idempotent — safe to always use
- Tool names are namespaced `{server}__{tool}` — both agent and HAR parser must handle this
- `latest-stdio` image tag required for stdio support (includes Node/npx)
- Dev Proxy captures tool calls from Copilot API responses — no changes needed to HAR capture
- `--use-env-proxy` (Node 22 built-in fetch) honours `HTTP_PROXY`/`NO_PROXY` without `undici`
