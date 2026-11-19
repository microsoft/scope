---
title: Support and security
description: Get help, report vulnerabilities privately, and understand Scope's responsible-use requirements.
---

## Getting help

For usage questions, bugs, and feature requests, see
[SUPPORT.md](https://github.com/microsoft/scope/blob/main/SUPPORT.md).
Search [existing issues](https://github.com/microsoft/scope/issues) before
opening a new issue. Include reproduction steps and relevant versions, but
remove credentials and sensitive run content from logs.

## Reporting vulnerabilities

Report vulnerabilities privately through
[SECURITY.md](https://github.com/microsoft/scope/blob/main/SECURITY.md), which
links to the current Microsoft security reporting guidance. Never report a
vulnerability through a public GitHub issue.

## Responsible use

Evaluation artifacts can contain prompts, source code, tool output, and
network metadata. Only use data and credentials approved for your deployment,
configure appropriate access controls, and review generated code before
using it.

Scope doesn't certify that an agent or its output is safe or production-ready.
Results describe the tasks and configurations you tested, not a universal
agent ranking. The automated Judge can make mistakes; important conclusions
need human review.

Local development is not a security sandbox. The ACP worker configuration
mounts the Docker socket so agents can run containers. Use a dedicated
environment for untrusted tasks, and don't expose the development stack to
the internet.

Read the
[Responsible AI FAQ](https://github.com/microsoft/scope/blob/main/docs/responsible-ai-faq.md)
before running sensitive or untrusted workloads. See
[Data collection and privacy](/resources/data-collection/) for the data Scope
handles and the deployment operator's responsibilities.
