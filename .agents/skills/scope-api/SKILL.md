---
name: "scope-api"
description: "Query and control the Scope platform API for analyzing benchmark data, managing runs/requests, skills, agents, reports, and insights. Use when the user asks about SCOPE data, wants to trigger runs, check status, generate reports, or interact with the SCOPE platform programmatically."
---

## Scope API Skill

The Scope platform benchmarks AI coding agents. This skill explains how to query and control it.

### Base URL

```
http://localhost:${API_PORT}
```

The `API_PORT` variable is defined in the project `.env` file (default: `3116`). Always read it from the environment or `.env` before making calls.

### Authentication

For authenticated calls, pass the existing **IdP access token** unchanged:
```
-H "Authorization: Bearer $SCOPE_TOKEN"
```

Use the caller-provided `SCOPE_TOKEN` when available; never print/log the token or
put it in a URL. There is no Scope session JWT, `/auth/login`, or token exchange.
The API verifies signature/claims before consulting its user-access cache.

**Enrollment is explicit.** Already-enrolled bearer callers remain compatible.
For a new identity, intentionally call this once before other authenticated calls:

```bash
curl --fail-with-body -sS \
  -X POST \
  -H "Authorization: Bearer $SCOPE_TOKEN" \
  -H "Cache-Control: no-store" \
  "http://localhost:$API_PORT/api/v1/users/me"
```

Only POST `/api/v1/users/me` may JIT-create the user or update profile,
`lastLoginAt`, and eligible bootstrap-admin promotion. This POST has side effects:
**never prefetch or poll it**, and do not silently invoke it as an ordinary lookup
retry. `lastLoginAt` records this explicit upsert, not proof of an interactive login.
For normal identity checks use GET `/api/v1/users/me`; Invalid/repeated/structured 
login values return `400`; HEAD never enrolls.

Plain `/me` and other authenticated routes resolve an existing active Scope UUID/role
from Redis; miss/unavailability reads Mongo by exact `(idp, tid, oid)` and warms the
cache, without JIT. Missing users return `403 user_not_enrolled`, disabled users
`403 user_disabled`, reserved/invalid principals `401`; required Mongo/JWKS outages
return `503`, unexpected errors `500`. Do not interpret a cache miss as a denial or
turn a verified-identity denial into anonymous access.

The fixed/non-sliding cache TTL (`AUTH_USER_CACHE_TTL_SECONDS`, default 300 seconds)
means DB-only role/disable changes may not be visible until expiry. Public endpoints
and existing no-token/auth-disabled anonymous rollout remain supported; this is not
full route RBAC. See [the auth contract](../../../docs/architecture/auth-rbac.md).

### Before Making API Calls

**Always fetch the OpenAPI spec first** to understand available endpoints, required parameters, and response schemas:

```bash
curl -s http://localhost:$API_PORT/openapi.json
```

Parse it with `jq` to find the relevant endpoint and its schema before constructing your API call. For example:

```bash
# Find endpoints matching a keyword
curl -s http://localhost:$API_PORT/openapi.json | jq '.paths | keys[] | select(contains("requests"))'

# Get schema for a specific endpoint
curl -s http://localhost:$API_PORT/openapi.json | jq '.paths["/api/v1/requests"]'
```

### Key Endpoint Groups

- **System**: `/health`, `/ready`, `/about`, `/api/v1/version`
- **Identity**: GET `/api/v1/users/me` (read-only); POST `/api/v1/users/me` (explicit enrollment/login refresh)
- **Requests & Runs**: `/api/v1/requests/*` (create, cancel, retry, pause, resume, bulk ops, logs, HAR, video, snapshots, tool-calls)
- **Skills**: `/api/v1/skills/*` (discover, search, external, resolve, revisions)
- **Agents**: `/api/v1/agents/*` (CRUD, versions)
- **Reports & Insights**: `/api/v1/reports/*`, `/api/v1/insights/*` (trigger, bulk, upvote/downvote)
- **Criteria & Prompt Features**: `/api/v1/criteria/*`, `/api/v1/prompt-features/*` (MDP, graph, seed, generate, extract)
- **Task Prompts**: `/api/v1/task-prompts/*` (generate, extract features)
- **Models**: `/api/v1/models/*` (list, sync)
- **Feature Flags**: `/api/v1/feature-flags`

### Usage Pattern

When the user asks about SCOPE data or wants to control SCOPE:

1. **Fetch the OpenAPI spec** from `http://localhost:$API_PORT/openapi.json`
2. **Find the relevant endpoint** and inspect its parameters/schemas
3. **Make the API call** with `curl` and parse results with `jq`
4. For complex queries, combine multiple API calls

### Example Workflow

```bash
# 1. Fetch spec and find the endpoint you need
curl -s http://localhost:$API_PORT/openapi.json | jq '.paths["/api/v1/requests"].get'

# 2. Make the call
curl -s http://localhost:$API_PORT/api/v1/requests | jq '.[:5]'

# 3. Drill into details
curl -s http://localhost:$API_PORT/api/v1/requests/{id} | jq .
```
