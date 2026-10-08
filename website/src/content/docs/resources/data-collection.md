---
title: Data collection and privacy
description: What data Scope handles, why it is needed, and where it may be sent.
---

Last updated: October 7, 2026

Scope is deployable software. The organization operating your Scope
deployment controls its data, chooses its connected services, and sets its
retention and access policies. Contact your deployment administrator for the
policies that apply to your organization.

## This documentation website

This documentation is a static website hosted on GitHub Pages, separate
from any Scope deployment. Its theme preference is saved in your browser.
The interactive landing-page example uses local mock data, and its
showreel videos are served by the documentation site.

Community videos are links to YouTube, not embedded players. Visiting a
documentation page does not load a YouTube player or thumbnail. Following
an article, event, or video link takes you to an external site governed by
that site's privacy practices.

Microsoft's [Privacy & Cookies](https://go.microsoft.com/fwlink/?LinkId=521839),
[Your Privacy Choices](https://aka.ms/yourcaliforniaprivacychoices), and
[Consumer Health Privacy](https://go.microsoft.com/fwlink/?linkid=2259814)
links are available in the footer on every page. Your Privacy Choices
includes information for California residents.

## Microsoft does not collect Scope deployment data

Scope does not send prompts, source code, run results, credentials, telemetry,
or other deployment data to Microsoft or the Scope project maintainers by
default. Microsoft does not operate a central Scope data-collection service.
Operational telemetry is disabled unless the deployment operator configures
it.

A deployment operator can choose to use Microsoft services, such as Azure
Application Insights, Azure storage, Azure databases, GitHub, or Microsoft
hosted AI models. In that case, those services process the data the operator
sends to them under the operator's applicable agreements and configuration.
This is not data collection by the Scope project itself.

## Data Scope handles

| Data | Why Scope uses it |
| --- | --- |
| Project names, descriptions, and user-provided configuration | To organize benchmark work and reproduce runs |
| Task prompts, criteria, profiles, and other evaluation settings | To instruct coding agents and evaluate their output |
| Codebase references and uploaded codebase revisions | To prepare the workspace in which an agent performs a task |
| Agent responses, conversation turns, tool calls, tool output, logs, and run status | To execute runs, diagnose failures, and show what the agent did |
| Generated or modified workspace files, reports, and evaluation results | To preserve run results and support comparison and review |
| Agent, model, software version, operating system, timing, and token usage information | To compare configurations, measure performance, and troubleshoot runs |
| Provider credentials and connection secrets entered by an administrator | To connect Scope to coding agents, model providers, repositories, and other configured services |
| Sign-in information, when authentication is enabled | To sign users in and control access |
| Browser preferences, such as theme, selected project, filters, and layout | To preserve the user's interface preferences |

Task prompts, source code, tool arguments, tool output, logs, and generated
files can contain personal or confidential information. Users should only
submit data that their organization permits Scope and its configured
providers to process.

## Operational telemetry

When enabled by the deployment operator, Scope records operational telemetry
such as service names, request and dependency timings, run or request
identifiers, worker and model names, error information, and aggregate counts.
This data is used to monitor reliability, investigate failures, and improve
system performance.

Telemetry is sent to the OpenTelemetry endpoint or Azure Application Insights
instance configured by the deployment operator. If neither is configured,
Scope does not export telemetry.

## Services that may receive data

Scope sends data to services selected by the deployment operator when needed
to perform a requested action. These services can include:

- Coding agent and model providers, which receive prompts and relevant run
  context
- Source control providers, which receive repository requests
- Cloud database, object storage, queue, secret storage, and telemetry
  providers used to operate Scope
- MCP servers and other integrations selected for a run

Each service processes data under its own terms and the agreement established
by the deployment operator.

## Storage, retention, and deletion

Scope stores configuration, run records, reports, and metadata in its
configured database. It stores larger artifacts, such as codebase revisions
and run snapshots, in configured object storage. Credentials are available
only to the Scope components that need them to connect to configured
services.

Some delete operations preserve records as soft-deleted data so historical
references remain valid. Scope does not define one universal retention
period. The deployment operator is responsible for setting retention,
backup, access, and permanent deletion policies across the database, object
storage, secret store, and telemetry service.

To request access to or deletion of your data, contact the administrator of
the Scope deployment you use.

## User choices

Users can choose what task content and codebases they submit. Administrators
choose which agents, models, integrations, telemetry destinations, and
credentials are available. Browser preferences can be cleared through the
browser's site-data controls.
