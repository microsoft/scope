---
title: Submitting requests (CLI)
description: Submit, monitor, and manage Scope benchmark runs from the terminal.
---

The `scope` CLI gives you the same submit-and-inspect workflow as the
Portal and REST API, but from the terminal — with real-time log
streaming, flexible output formats, and easy integration into shell
scripts.

For Portal usage, see
[Submitting requests (Portal)](/guides/submitting-requests-portal/).
For raw API calls, see
[Submitting requests (REST API)](/guides/submitting-requests-api/).

## Prerequisites

- The `scope` CLI is
  [installed](/getting-started/install-cli/) and on your `PATH`.
- `SCOPE_API_URL` points to your Scope deployment.

## Submit a run

The primary command is `scope run submit`. At a minimum you need a
task message and a worker:

```bash
scope run submit \
  -m "Create a Hello World Node.js / Express REST API." \
  -w coder-acp-copilot \
  -c has_package_json has_express_dependency has_get_route
```

Logs stream in real time by default. Add `--no-stream` to submit
silently and poll later.

### Using a scenario file

For repeatable benchmarks, define the task and criteria in a scenario
YAML file and pass it with `-s`:

```bash
scope run submit -s scenarios/hello-world.yaml -w coder-acp-copilot
```

### Specifying a profile

Instead of inlining worker, model, and extensions on every call, use
a saved [profile](/guides/defining-profiles/):

```bash
scope run submit \
  -m "Implement a REST API with authentication." \
  --profile my-copilot-profile
```

### Starting from a codebase

Use `--codebase` to seed the workspace from a registered codebase.
Pass a bare slug to resolve the latest revision, or pin a numbered ref
for reproducibility:

```bash
scope run submit \
  -m "Add input validation to the inventory API." \
  --profile my-copilot-profile \
  --codebase inventory-service@r3
```

See [Managing codebases](/guides/managing-codebases/).

### Additional options

| Flag | Purpose |
| --- | --- |
| `--model <model>` | Override the model (e.g. `gpt-4o`) |
| `--mcp-servers <slugs...>` | Attach MCP servers to this run |
| `--skills <slugs...>` | Attach skills |
| `--codebase <ref>` | Seed the workspace from a codebase slug, numbered ref, or revision ID |
| `--extensions <ids...>` | Install VS Code extensions |
| `--max-iterations <n>` | Max judge iterations (multi-turn) |
| `--agent-version <ver>` | Pin to a specific agent version |

## Stream logs

Logs stream automatically after `run submit`. To attach to an
existing run:

```bash
scope run logs -i <request-id>
```

Add `--from-start` to replay from the beginning of the run.

## Check status

```bash
scope run status -i <request-id>
```

## List runs

```bash
scope run list
scope run list -w coder-acp-copilot        # filter by worker
scope run list --submission-id <id>         # filter by submission
scope run list -o json                      # machine-readable
```

## Share related results

Profile variations and repetitions created by one submit call share a
`submissionId`, printed by `scope run submit`. Generate one link to all of them:

```bash
scope run share \
  --submission-id <submission-id> \
  --project <project-id> \
  --portal-url https://your-scope-portal.example.com
```

The command prints a Portal results link grouped by profile, including the
project so recipients do not need to select it first. It does not contact the
API. Supply the Portal origin, not the API URL. You can omit `--project` when
`SCOPE_PROJECT` or a saved project selection already supplies it.

The link does not grant access; recipients still need access to your Scope
deployment.

## Get full run details

```bash
scope run get -i <run-id>
scope run get -i <run-id> -o yaml
```

## Cancel a run

```bash
scope run cancel -i <request-id>
```

Marks the request as failed and signals the active worker to exit.
You can cancel multiple IDs at once:

```bash
scope run cancel -i <id1> <id2> <id3>
```

## Download artifacts

Download all artifacts (workspaces + run document) as an archive:

```bash
scope run download -i <request-id>
scope run download -i <request-id> -e -d ./output  # extract
```

For bulk downloads:

```bash
scope run download-batch --submission-id <id> -e -d ./batch
```

## Retry a failed run

```bash
scope run retry -i <request-id>
```

This starts a new attempt while preserving the previous attempt
history.

## Output formats

All list and detail commands accept `-o` / `--output`:

| Format | Use case |
| --- | --- |
| `table` | Human-readable (default) |
| `tsv` | Pipe into `cut`, `awk`, `grep`, `xargs` |
| `json` | Programmatic access, AI agents |
| `yaml` | Human-friendly structured data |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `SCOPE_API_URL` | Override the default API URL |
| `SCOPE_API_PORT` | Derive localhost URL (for local dev) |

Variables are also loaded from a `.env` file in the current
directory.

## Tips

- **Stream by default.** `run submit` streams unless you pass
  `--no-stream`. No need for a separate `run logs` call.
- **Use TSV for scripting.** Pipe `scope run list -o tsv` into
  standard Unix tools for quick filtering.
- **Pin for CI.** Pass `--agent-version` and a fixed profile version
  in automated pipelines for reproducibility.

## Next steps

- [Defining evaluation criteria](/guides/defining-criteria/) — build
  the criteria DAG that judges your runs.
- [Defining profiles](/guides/defining-profiles/) — save reusable
  agent configurations.
- [Managing codebases](/guides/managing-codebases/) — seed runs from
  versioned project snapshots.
- [Choosing a coding agent](/guides/choosing-a-coding-agent/) —
  understand the available workers.
