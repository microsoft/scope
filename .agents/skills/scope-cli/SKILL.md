---
name: scope-cli
description: Interact with the Scope benchmarking platform using the Scope CLI — submit runs, list results, manage criteria, generate reports, and administer agents, skills, and MCP servers.
allowed-tools: Bash
metadata:
  author: scope-core-team
  version: "1.0"
---

# Scope CLI

You have access to the **Scope** CLI — an AI coding-agent benchmarking platform.
Run it with `pnpm cli` from the repository root (`scope-core`).

> **All commands below assume you are in the repo root.** Prefix every invocation with `pnpm cli`.

---

## Authentication and enrollment

The CLI's shared API transport can attach a caller-provided `SCOPE_TOKEN` containing
an **IdP access token**. Already-enrolled users keep using that bearer unchanged;
there is no Scope-token exchange or new CLI login implementation in this milestone.
Do not assume the deferred `scope auth login`/keychain commands exist.

A new identity must explicitly call **`POST /api/v1/users/me`** using its
IdP bearer before ordinary authenticated commands. Use the configured Scope API URL:

```bash
curl --fail-with-body -sS \
  -X POST \
  -H "Authorization: Bearer $SCOPE_TOKEN" \
  -H "Cache-Control: no-store" \
  "${SCOPE_API_URL%/}/api/v1/users/me"
```

This POST creates/refreshes the user, profile, `lastLoginAt`, and eligible bootstrap
promotion; never prefetch, poll, or automatically use it to recover an ordinary
lookup. GET `/users/me` only checks existing access. `403 user_not_enrolled` calls
for explicit enrollment; `403 user_disabled` is a denial, not a refresh-token prompt.
Invalid/expired bearer → `401`; required Mongo/JWKS outage → `503`.

All non-public bearer calls verify the IdP token before Redis/Mongo resolution.
The active-user cache is fixed/non-sliding (300 seconds by default), so DB-only
role/disable edits may remain stale until expiry. No raw bearer is cached by the API.
Never echo tokens or include them in URLs/debug output. Public and anonymous rollout
behavior is unchanged; full RBAC and interactive CLI auth remain deferred.

See [Authentication & RBAC](../../../docs/architecture/auth-rbac.md).

---

## Quick Reference

In order to get the full updated reference, run `pnpm cli --help` or `pnpm cli <command> --help` for specific commands. Below is a summary of the most common commands.

### Runs (benchmark executions)

| Action | Command |
|--------|---------|
| List runs | `pnpm cli run list` |
| List runs (JSON) | `pnpm cli run list -o json` |
| Filter by worker | `pnpm cli run list -w coder-acp-copilot` |
| Get run details | `pnpm cli run get -i <id>` |
| Check status | `pnpm cli run status -i <id>` |
| Stream logs | `pnpm cli run logs -i <id>` |
| Stream logs from start | `pnpm cli run logs -i <id> --from-start` |
| Submit a run | `pnpm cli run submit -s <scenario.yaml> -w <worker>` |
| Submit with message | `pnpm cli run submit -m "your task" -w coder-acp-copilot` |
| Submit with model | `pnpm cli run submit -s <scenario> -w <worker> --model <model>` |
| Submit with skills | `pnpm cli run submit -s <scenario> -w <worker> --skills <slug...>` |
| Submit with MCP servers | `pnpm cli run submit -s <scenario> -w <worker> --mcp-servers <slug...>` |
| Delete a run | `pnpm cli run delete -i <id>` |
| Download artifacts | `pnpm cli run download -i <id>` |
| Download & extract | `pnpm cli run download -i <id> -e` |
| Upload archive | `pnpm cli run upload <path>` |
| Demo (multi-worker TUI) | `pnpm cli run demo -m "task" -w coder-acp-copilot,coder-acp-claude-code` |


### Reports

| Action | Command |
|--------|---------|
| List reports | `pnpm cli report list` |
| List for a run | `pnpm cli report list -r <run-id>` |
| Generate report | `pnpm cli report generate -i <run-id> --stream` |
| Get report | `pnpm cli report get -i <report-id>` |
| Get as markdown | `pnpm cli report get -i <report-id> -o markdown` |
| Stream report logs | `pnpm cli report logs -i <report-id> --from-start` |

### Report Templates

| Action | Command |
|--------|---------|
| List templates | `pnpm cli report-template list` |
| Get template | `pnpm cli report-template get -i <id>` |
| Import templates | `pnpm cli report-template import <path>` |

### Criteria (evaluation rubrics)

| Action | Command |
|--------|---------|
| List criteria | `pnpm cli criteria list` |
| Search criteria | `pnpm cli criteria list -q "search term"` |
| Get criterion | `pnpm cli criteria get -i <id>` |
| Create criterion | `pnpm cli criteria create --id <snake_case_id> --prompt "eval prompt"` |
| Update criterion | `pnpm cli criteria update -i <id> --prompt "new prompt"` |
| Delete criterion | `pnpm cli criteria delete -i <id>` |
| Show dependency graph | `pnpm cli criteria graph` |
| Import from YAML | `pnpm cli criteria import <path>` |
| Dry-run import | `pnpm cli criteria import <path> --dry-run` |

### Prompt Features

| Action | Command |
|--------|---------|
| List features | `pnpm cli prompt-feature list` |
| Get feature | `pnpm cli prompt-feature get -i <id>` |
| Show graph | `pnpm cli prompt-feature graph` |
| Import from YAML | `pnpm cli prompt-feature import <path>` |
| Extract from task | `pnpm cli prompt-feature extract -t "task text"` |
| Extract from scenario | `pnpm cli prompt-feature extract -s <scenario.yaml>` |

### Agents

| Action | Command |
|--------|---------|
| List agents | `pnpm cli agent list` |
| Get agent | `pnpm cli agent get -i <id>` |
| List models | `pnpm cli agent model list -i <agent-id>` |
| List agent versions | `pnpm cli agent version list -i <agent-id>` |
| Active versions only | `pnpm cli agent version list -i <agent-id> --status active` |

### Skills

| Action | Command |
|--------|---------|
| List skills | `pnpm cli skill list` |
| Search skills | `pnpm cli skill search -q "query"` |
| Get skill | `pnpm cli skill get -i <slug>` |
| Import skill | `pnpm cli skill import --source <owner/repo> --skill-name <name>` |
| Resolve (fetch latest) | `pnpm cli skill resolve -i <slug>` |
| List revisions | `pnpm cli skill revisions -i <slug>` |
| Delete skill | `pnpm cli skill delete -i <slug>` |

### MCP Servers

| Action | Command |
|--------|---------|
| List MCP servers | `pnpm cli mcp server list` |
| Get MCP server | `pnpm cli mcp server get -i <slug>` |
| Create MCP server | `pnpm cli mcp server create --id <slug> --name "Name" --type sse --url <url>` |
| Delete MCP server | `pnpm cli mcp server delete -i <slug>` |

### Insights

| Action | Command |
|--------|---------|
| List insights | `pnpm cli insight list` |
| Search insights | `pnpm cli insight list -q "keyword"` |
| Blocked only | `pnpm cli insight list --blocked` |
| Get insight (markdown) | `pnpm cli insight get -i <id> -o markdown` |
| Create insight | `pnpm cli insight create --title "Title" --description "md body"` |
| Upvote / downvote | `pnpm cli insight upvote -i <id>` |

### Task Prompts

| Action | Command |
|--------|---------|
| List task prompts | `pnpm cli task-prompt list` |
| Search prompts | `pnpm cli task-prompt list -s "search text"` |
| Get prompt | `pnpm cli task-prompt get -i <uuid>` |
| Create prompt | `pnpm cli task-prompt create -t "prompt text"` |
| Create from file | `pnpm cli task-prompt create -f <path>` |
| Extract features | `pnpm cli task-prompt extract-features -i <uuid>` |

---

## Output Formats

All list/get commands accept `-o, --output <format>`:

| Format | Use case |
|--------|----------|
| `table` | Human-readable (default) |
| `tsv` | Pipe to Unix tools (`cut`, `awk`, `grep`) |
| `json` | Programmatic access, AI agents |
| `yaml` | Human-friendly structured data |

**Examples:**
```bash
# Get run details as JSON for parsing
pnpm cli run get -i <id> -o json

# List runs as TSV and filter with awk
pnpm cli run list -o tsv | awk -F'\t' '$3 == "completed"'
```

---

## Common Workflows

### Submit a benchmark and watch it

```bash
# Submit with streaming
pnpm cli run submit -s config/scenarios/my-scenario.yaml -w coder-acp-copilot

# Or submit without streaming and watch later
pnpm cli run submit -s config/scenarios/my-scenario.yaml -w coder-acp-copilot --no-stream
pnpm cli run logs -i <id> --from-start
```

### Generate and read a report

```bash
pnpm cli report generate -i <run-id> --stream
pnpm cli report list -r <run-id>
pnpm cli report get -i <report-id> -o markdown
```

### Import criteria and scenarios

```bash
pnpm cli criteria import config/criteria/ --dry-run
pnpm cli criteria import config/criteria/
pnpm cli criteria graph
```

---

## Tips

- Use `-o json` when you need to parse output programmatically.
- Use `--no-stream` on `run submit` to get the ID immediately without blocking.
- Scenario files are YAML and live in `config/scenarios/`.
- Persona files live in `config/personas/`.
- Traits files default to `config/traits.yaml` next to the persona.
- Skill slugs use the format `owner/repo/skill-name`.
- Run IDs are UUIDs — use tab completion or copy from `run list` output.
