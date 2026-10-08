# Responsible AI FAQ for Scope

## Overview

Scope is an open-source benchmarking platform for evaluating AI coding agents through repeatable, evidence-backed runs. It helps developers and evaluators define coding tasks, run those tasks against different agent surfaces and models, inspect the resulting artifacts, and compare outcomes against explicit evaluation criteria.

Scope supports benchmark execution through a Portal, CLI, scheduler, worker services, and an automated Judge. It can run coding agents such as GitHub Copilot (on Linux and Windows) and Claude Code, then preserve run evidence including logs, workspace snapshots, criteria results, captured tool-call activity, and generated reports.

## Intended uses

Scope is intended to help users:

- Define realistic benchmark tasks for AI coding agents.
- Compare coding agents, model versions, skills, prompts, personas, and product surfaces.
- Evaluate agent outputs against reusable criteria organized as a dependency graph.
- Inspect evidence from each run, including generated files, agent responses, logs, tool-call outputs, workspace snapshots, and derived artifacts.
- Generate summaries, reports, and insights about benchmark runs.
- Support engineering analysis of AI coding agent behavior over time.

Scope is designed for technical users who can interpret benchmark results, review generated artifacts, and decide whether outputs are appropriate for their environment.

## Out-of-scope uses

Scope is not intended to:

- Certify that an AI model or coding agent is generally safe, secure, fair, or production-ready.
- Replace human code review, security review, legal review, or release approval.
- Make autonomous deployment, employment, compliance, or other consequential decisions.
- Serve as a secure sandbox for arbitrary untrusted code unless the deployment owner has configured appropriate isolation.
- Process secrets, credentials, personal data, or confidential source code unless the deployment has been approved for that data.
- Guarantee that generated code is correct, secure, license-compliant, or free of defects.

## AI capabilities

Scope uses AI in several places, depending on deployment configuration:

| Capability | Description |
|---|---|
| Coding-agent workers | Run configured AI coding agents against benchmark tasks. Supported surfaces include GitHub Copilot (Linux and Windows) and Claude Code, integrated through the ACP SDK. |
| Automated Judge | Uses an LLM to evaluate agent output against criteria. The Judge can inspect workspace snapshots, captured tool outputs, and the coding agent’s own response, but it is designed to use read-only evidence rather than execute new commands. |
| Criteria authoring assistance | Portal AI features can help generate evaluation criteria, suggested criterion IDs, and dependency suggestions. |
| Prompt-feature assistance | Portal AI features can generate and detect task-prompt features. |
| Task-prompt generation | Portal AI features can generate benchmark task prompts or variations from user-provided descriptions. |
| Report generation | A report-generation worker can use an LLM to analyze completed runs and produce Markdown reports and reusable insights. |
| Model discovery | Model scanners can discover available capabilities from supported providers such as Copilot and Anthropic integrations. |

For its LLM-assisted platform features (Judge, criteria/prompt/report generation), Scope routes inference through a unified backend that supports Azure AI Foundry and GitHub Models. Coding-agent surfaces reach their own model backends directly: GitHub Copilot via the GitHub Copilot SDK/APIs, and Claude Code via Anthropic APIs. The available providers depend on the deployment and registered credentials.

## Inputs and outputs

Scope may process inputs such as:

- Benchmark task prompts
- Personas
- Evaluation criteria
- Prompt features
- Skills and MCP server definitions
- Source code repositories or uploaded codebase archives
- Agent credentials or provider tokens configured by the deployment owner
- Agent outputs, logs, command results, and workspace snapshots

Scope may produce outputs such as:

- Agent responses
- Modified or generated code
- Pass/fail criteria results
- Judge feedback
- Run logs and status events
- Workspace snapshots
- HAR captures and ATIF trajectory files
- Reports and insights about completed benchmark runs

## Limitations

Scope results are benchmark-specific. A passing run means that the selected agent satisfied the configured criteria for that task, environment, worker version, and model configuration. It does not prove that the agent will perform equally well on other tasks, languages, repositories, or production environments.

The automated Judge may produce incorrect or inconsistent evaluations. Criteria quality, evidence availability, model behavior, prompt wording, and captured artifacts can all affect the result. Users should review important evaluations manually.

Generated code may contain bugs, insecure patterns, incomplete implementations, or license concerns. Users should apply the same engineering controls used for human-written code, including review, testing, linting, dependency review, and security scanning.

Scope may capture detailed benchmark artifacts, including prompts, generated code, logs, tool outputs, and network interaction metadata. Sensitive headers such as authorization tokens, API keys, and cookies are redacted in supported HAR capture paths, but user-provided content can still contain sensitive information. Users should avoid including secrets or confidential data unless their deployment is approved for that data.

Prompt injection is a relevant risk. Benchmark tasks, repository files, AGENTS.md instructions, tool outputs, MCP content, and other external content may contain instructions intended to influence the coding agent, Judge, or report generator. Users should treat external content as untrusted and review outputs before taking action.

Project scoping organizes data by project, but current architecture documentation describes it as a data organization layer, not a security boundary. Deployments that handle sensitive or multi-user data should ensure authentication, authorization, tenant isolation, and access-control requirements are implemented and reviewed before use.

## Responsible use guidance

Users should:

- Review generated code and reports before relying on them.
- Treat benchmark results as evidence for a specific scenario, not as a universal model ranking.
- Keep benchmark criteria clear, observable, and tied to the evidence Scope can inspect.
- Use representative tasks, codebases, personas, and environments when comparing agents.
- Record agent versions, model versions, worker versions, and configuration so results remain interpretable.
- Avoid including secrets, credentials, personal data, or confidential data in prompts, repositories, logs, or uploaded artifacts unless approved.
- Use least-privilege credentials for model providers, GitHub, MCP servers, and other integrations.
- Run generated code in isolated environments appropriate for the risk of the benchmark.
- Validate generated artifacts with tests, security scanning, dependency scanning, and human review.
- Review generated reports and insights for accuracy before sharing.

## Risk mitigations

| Risk | Mitigation |
|---|---|
| Inaccurate benchmark conclusions | Scope stores run evidence, criteria results, logs, snapshots, and reports so users can inspect why a run passed or failed. |
| Ungrounded Judge decisions | The Judge is instructed to use available evidence from workspace files, captured tool outputs, and agent responses, and not to run new commands itself. |
| Insecure generated code | Scope is an evaluation tool; users remain responsible for code review, testing, linting, and security scanning before using generated code. |
| Secret exposure in captured traffic | Supported HAR capture paths redact sensitive headers such as authorization, API key, cookie, and set-cookie headers before storage. |
| Credential misuse | Provider credentials are managed through a Token Manager with capability-based token acquisition and Key Vault-backed storage in production-style deployments. |
| Prompt injection | Users should treat repository content, prompts, MCP data, and external inputs as untrusted. Scope’s Judge uses read-only tools, and outputs should be reviewed before action. |
| Overreliance on AI-generated reports | Reports are generated from run data and should be reviewed by a human before being used for decisions. |
| Cross-project data confusion | Scope uses explicit project IDs for scoped entities and fails fast when project context is missing. Deployment owners should still implement and verify access control for shared environments. |

## Evaluation approach

Scope should be evaluated through manual and automated testing before open-source release and before any production deployment. Evaluation should cover:

- Correct benchmark submission through Portal and CLI.
- Worker execution for supported agent surfaces.
- Criteria DAG resolution and dependency handling.
- Judge behavior across passing, failing, partial, and multi-iteration runs.
- Evidence handling from workspace snapshots, captured tool calls, and agent responses.
- Prompt, criteria, and report-generation quality.
- Security behavior for token storage, secret redaction, path handling, and external service calls.
- Failure handling for queue retries, stale runs, unavailable model providers, and missing evidence.
- Telemetry behavior when observability is enabled or disabled.

Public transparency documentation should describe evaluation at this high level and should not include internal-only metrics, exact defect rates, or internal review tooling details.

## Data, privacy, and telemetry

Scope stores benchmark configuration and run data in configured backing services such as MongoDB or Cosmos DB for MongoDB, Azure Blob Storage, Azure Storage Queues, Redis, and Key Vault depending on deployment mode.

Run artifacts may include source code, prompts, logs, workspace snapshots, tool-call outputs, HAR captures, ATIF trajectories, reports, and insights. Deployment owners are responsible for configuring storage, retention, access control, and data handling according to their organization’s requirements.

Telemetry is optional and deployment-configured. When OpenTelemetry or Application Insights settings are not configured, the telemetry package operates as a no-op. When telemetry is enabled, Scope can emit operational metrics and traces for services such as API, workers, scheduler, Judge, token manager, post-processor, report generator, and model scanners.

## Supported languages

Scope can benchmark coding tasks across languages and frameworks supported by the selected coding agent, worker environment, and configured runtime images. Current worker runtime documentation includes support for common development stacks such as Node.js, Python, PowerShell, Go, .NET, Rust, Java, Maven, Gradle, and pnpm.

Benchmark quality may vary by language, framework, model, task prompt, and available execution environment. Users should validate results for each language and scenario they intend to rely on.

## Feedback and issue reporting

Users can report bugs, unexpected behavior, documentation issues, and feature requests through GitHub Issues after the repository is open sourced.

Security vulnerabilities should not be reported through public GitHub issues. Users should follow the process in `SECURITY.md`, which points to Microsoft’s security reporting guidance at `https://aka.ms/SECURITY.md`.

## Documentation update triggers

This document should be updated when:

- Scope adds new AI capabilities or worker types.
- Scope changes supported model providers or inference backends.
- Scope changes how evidence is captured, redacted, stored, or evaluated.
- Scope adds or changes authentication, authorization, or access-control behavior.
- New unsupported uses or limitations are identified.
- New evaluation information becomes available.
- Scope moves to a new release stage.
