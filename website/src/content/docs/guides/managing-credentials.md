---
title: Manage provider credentials
description: Store, validate, and rotate the GitHub, Anthropic, and Azure AI Foundry keys that Scope's coding agents and Judge use.
---

Coding agents and the Judge call model providers on your behalf. Scope
keeps the credentials for those providers in its Token Manager, which
validates each key, derives what it can be used for, and hands keys out
round-robin to the services that need them.

You can manage these credentials from the Portal (**Secrets → Keys**) or
with the `scope secret` CLI command. Both use the same
`/api/v1/keys` endpoints; see the [REST API reference](/reference/api/).

## Credential types and capabilities

Each key has a **type**. When a key validates successfully, the Token
Manager derives its **capabilities** from that type. Services request a
key by capability, not by type.

| Type | Capabilities when valid |
| --- | --- |
| `github-pat-classic` | `github-public-api`; plus `copilot-sdk` and `copilot-cli` when the token has the `copilot` scope |
| `github-pat-fine-grained` | `github-public-api`; plus `github-models` when the token can use GitHub Models |
| `github-oauth` | `github-models`, `github-public-api`, `copilot-models`, `copilot-sdk`, `copilot-cli` |
| `anthropic-api-key` | `claude-code-cli`, `anthropic-api` |
| `anthropic-oauth` | `claude-code-cli` |
| `azure-ai-foundry` | `azure-ai-inference` |

A key whose validation status is not `valid` has no capabilities and
is never handed out. The Token Manager picks round-robin among
**valid, enabled** keys that provide the requested capability.

The services in this repository request these capabilities:

| Service | Capability |
| --- | --- |
| `coder-acp-copilot` worker | `copilot-cli` |
| `coder-acp-claude-code` worker | `claude-code-cli` (prefers an `anthropic-oauth` key) |
| Judge and report generator | `copilot-sdk` |

If a service's environment sets the variable that matches the capability
(`GITHUB_TOKEN` for GitHub capabilities, `ANTHROPIC_API_KEY` for
Anthropic capabilities), the service uses that value directly instead
of acquiring a stored key. The Claude Code worker checks
`CLAUDE_CODE_OAUTH_TOKEN` first.

## Prerequisites

- The `scope` CLI is [installed](/getting-started/install-cli/).
- `SCOPE_API_URL` points to your Scope deployment, or pass `-u <url>`
  on each command.

## Add a credential

Pipe the secret on stdin so it never appears in your shell history or
the process list:

```bash
printf '%s' "$ANTHROPIC_API_KEY" | scope secret create \
  --type anthropic-api-key --value-stdin --comment "Claude Code worker"
```

`create` stores the key and prints its metadata straight away.
Validation runs on the server; check its result with `scope secret get`
or `scope secret list`.

`--value <secret>` also works, but the CLI prints a warning because the
value is exposed in shell history and process listings. Interactive
entry is not supported: `--value-stdin` requires piped input.

Other `create` options:

| Flag | Purpose |
| --- | --- |
| `--no-enabled` | Store the key disabled |
| `--comment <text>` | Free-text annotation shown in listings |
| `--expires-at <date>` | Expiration date |

### Azure AI Foundry keys

Foundry credentials combine an endpoint, an API key, and an optional
model. Pass the parts separately and the CLI builds the stored value:

```bash
printf '%s' "$FOUNDRY_KEY" | scope secret create --type azure-ai-foundry \
  --endpoint https://<resource>.services.ai.azure.com/models \
  --api-key-stdin --model <deployment>
```

Alternatively, pass the complete JSON value
(`{"endpoint": "...", "apiKey": "...", "model": "..."}`) with
`--value-stdin`. `--endpoint` and `--model` are only accepted for
`azure-ai-foundry` keys, and cannot be combined with `--value` or
`--value-stdin`.

## Check a credential before storing it

`scope secret preview` takes the same credential flags as `create`,
validates the credential with its provider, and prints the status and
capabilities without storing anything:

```bash
printf '%s' "$GITHUB_TOKEN" | scope secret preview \
  --type github-pat-classic --value-stdin
```

## List and inspect keys

```bash
scope secret list
scope secret list --capability claude-code-cli
scope secret get <key-id>
```

Listings show the ID, type, enabled state, validation status,
capabilities, comment, and the last validation error. The validation
status is one of `valid`, `invalid`, `expired`, `error`, or `unknown`.

Add `-o json` or `-o yaml` for machine-readable output. No output format
includes the secret value: the CLI never retrieves it.

To re-run validation on a stored key, for example after the provider
fixes an outage:

```bash
scope secret validate <key-id>
```

## Update, rotate, and delete

Secret values are immutable. `scope secret update` changes metadata
only:

```bash
scope secret update <key-id> --disable --comment "Paused for rotation"
scope secret update <key-id> --enable
scope secret update <key-id> --expires-at 2027-01-31
scope secret update <key-id> --clear-expiry
scope secret update <key-id> --comment ""   # clears the comment
```

To rotate a credential, create a key with the new value, confirm it
validates, then delete the old one:

```bash
scope secret delete <old-key-id>
```

`delete` is a soft delete: the key no longer appears in listings and is
never handed out again.

## Safety notes

- Request and response bodies for `create`, `preview`, and `validate`
  are fully redacted in the CLI's API logs.
- `create`, `preview`, and `validate` are never retried automatically,
  so a transient failure cannot store a key twice. Reads and metadata
  updates retry transient network errors and `429`/`5xx` responses.

## Related

- [Submitting requests (CLI)](/guides/submitting-requests-cli/)
- [Choose a coding agent](/guides/choosing-a-coding-agent/)
- [Coding agents & capabilities](/reference/workers/)
