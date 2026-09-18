---
title: Development guide
description: Repository layout, development commands, and architecture references for Scope contributors.
---

The repository is a pnpm workspaces monorepo, primarily TypeScript 5, with a
React Portal and a Rust AI gateway. Start with
[Local development](/getting-started/local-development/) to install
dependencies and run the stack, then read
[Contributing](/resources/contributing/) before opening a pull request.

## Repository structure

| Path | Contents |
| --- | --- |
| [apps/api/](https://github.com/microsoft/scope/tree/main/apps/api) | REST API and live event streaming |
| [apps/portal/](https://github.com/microsoft/scope/tree/main/apps/portal) | Web UI and Storybook components |
| [apps/cli/](https://github.com/microsoft/scope/tree/main/apps/cli) | CLI for evaluation management and automation |
| [apps/scheduler/](https://github.com/microsoft/scope/tree/main/apps/scheduler) and [apps/judge/](https://github.com/microsoft/scope/tree/main/apps/judge) | Run dispatch and criteria evaluation |
| [apps/workers/](https://github.com/microsoft/scope/tree/main/apps/workers) | Coding-agent, post-processing, and report workers |
| [apps/gateway/](https://github.com/microsoft/scope/tree/main/apps/gateway) and [apps/token-manager/](https://github.com/microsoft/scope/tree/main/apps/token-manager) | AI traffic capture and credential management |
| [packages/](https://github.com/microsoft/scope/tree/main/packages) | Shared types, storage clients, migrations, and supporting libraries |
| [config/](https://github.com/microsoft/scope/tree/main/config) and [docs/](https://github.com/microsoft/scope/tree/main/docs) | Evaluation examples and technical documentation |
| [website/](https://github.com/microsoft/scope/tree/main/website) | This documentation website |

## Development commands

Run these commands from the repository root:

```bash
pnpm test                  # Unit tests
pnpm lint                  # Workspace lint and type checks
pnpm build                 # Workspace builds
pnpm storybook             # Portal component catalog
pnpm test:integration      # Integration tests; requires .env and backing services
```

For service-by-service development, Rust commands, migrations, and code
conventions, read
[CONTRIBUTING.md](https://github.com/microsoft/scope/blob/main/CONTRIBUTING.md).
For documentation authoring and preview commands, see
[website/README.md](https://github.com/microsoft/scope/blob/main/website/README.md).

## Architecture and configuration references

These detailed engineering references live alongside the source code:

| Topic | Guide |
| --- | --- |
| Architecture and run lifecycle | [System architecture](https://github.com/microsoft/scope/blob/main/docs/architecture/system-architecture.md) |
| Domain models and API design | [Application design](https://github.com/microsoft/scope/blob/main/docs/architecture/app-design.md) |
| Project organization | [Projects](https://github.com/microsoft/scope/blob/main/docs/architecture/data-organization-projects.md) |
| Evaluation and criteria DAGs | [Criteria provider](https://github.com/microsoft/scope/blob/main/docs/architecture/criteria-provider.md) |
| Agent context | [Skills](https://github.com/microsoft/scope/blob/main/docs/architecture/skills.md) and [codebases](https://github.com/microsoft/scope/blob/main/docs/architecture/codebases.md) |
| Scheduling and recovery | [Queue scheduler](https://github.com/microsoft/scope/blob/main/docs/architecture/queue-scheduler.md) |
| Configuration and authentication | [Environment variables](https://github.com/microsoft/scope/blob/main/ENV_VARIABLES.md) |
| AI limitations and data handling | [Responsible AI FAQ](https://github.com/microsoft/scope/blob/main/docs/responsible-ai-faq.md) |
| More architecture, operations, and research | [Documentation index](https://github.com/microsoft/scope/blob/main/docs/README.md) |
