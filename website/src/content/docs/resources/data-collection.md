---
title: Data collection and privacy
description: What data Scope handles, why it is needed, and where it may be sent.
---

Last updated: October 16, 2026

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

### Optional website analytics

The published documentation website uses Microsoft One Observability
(1DS) to understand website usage and reliability. Microsoft Web Cookie
Policy (WCP) provides the consent banner and saves your cookie choices.
The banner appears at the top of the page, above the site header.
The WCP consent script loads when you visit the published site; the 1DS
script loads only after you opt in to the **Analytics** category.
The same opt-in requirement applies to visitors worldwide, without
granting analytics consent based on location.

When enabled, 1DS automatically captures page views, page-load and
page-unload events, clicks, scrolling, resizing, JavaScript errors, and
browser context. This information is sent to Microsoft's 1DS collector
to understand how the documentation is used and identify problems.
Your Analytics choice is also passed to 1DS as consent metadata.
The SDK is configured not to use analytics cookies and not to collect
query strings or fragments in page URLs. WCP's consent-preference cookie
is separate from analytics.

You can reject optional cookies and still read all documentation.
Use **Manage cookies** in the footer to review or withdraw consent at
any time. Withdrawal stops analytics collection and pauses transmission
before the SDK unloads; it does not undo processing that occurred before
withdrawal. Supported **Global Privacy Control** and **Do Not Track**
signals also prevent 1DS initialization, even if analytics was previously
accepted. If consent cannot be established, analytics remains disabled.

This integration is limited to the published documentation website.
By default, local development, local production previews, and sites on
other hosts do not load WCP or 1DS. An explicit development-only consent
preview can show the WCP banner without enabling 1DS, even after accepting
analytics. This integration does not instrument the Scope Portal, CLI,
API, or workers and does not give website analytics access to your
Scope deployment's prompts, source code, credentials, or run results.

### Privacy policies and regional rights

Microsoft's [Privacy & Cookies](https://go.microsoft.com/fwlink/?LinkId=521839),
[Your Privacy Choices](https://aka.ms/yourcaliforniaprivacychoices), and
[Consumer Health Privacy](https://go.microsoft.com/fwlink/?linkid=2259814)
links are available in the footer on every page. Your Privacy Choices
includes information for California residents. The
[Microsoft Privacy Statement](https://www.microsoft.com/en-us/privacy/privacystatement)
describes Microsoft's data practices, retention considerations,
international transfers, and how to contact Microsoft or make a privacy
request about data it processes.

Depending on your location and the applicable law, privacy rights may
include access, correction, deletion, portability, objection, restriction
of processing, or withdrawal of consent. The following official resources
describe several regional frameworks; this is not an exhaustive list:

| Region | Official privacy-law resource |
| --- | --- |
| European Union and European Economic Area | [General Data Protection Regulation (GDPR)](https://commission.europa.eu/law/law-topic/data-protection/legal-framework-eu-data-protection_en) |
| United Kingdom | [UK GDPR privacy notices](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-be-informed/) and [PECR cookie rules](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/) |
| California, United States | [California Consumer Privacy Act (CCPA), as amended by the California Privacy Rights Act (CPRA)](https://cppa.ca.gov/regulations/) |
| Brazil | [Lei Geral de Proteção de Dados (LGPD) and the ANPD](https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/competencias) |
| Canada | [Personal Information Protection and Electronic Documents Act (PIPEDA)](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/) |
| Australia | [Privacy Act 1988 and Australian Privacy Principles](https://www.oaic.gov.au/privacy/privacy-legislation/the-privacy-act) |
| Japan | [Act on the Protection of Personal Information (APPI)](https://www.ppc.go.jp/en/legal/) |

Consent controls and these references are not a certification of GDPR or
worldwide legal compliance. Applicable obligations depend on the
operator, purposes, data flows, contracts, retention, and jurisdiction,
and require an appropriate privacy and legal review. The Microsoft
website privacy policies do not replace the policies of an organization
operating its own Scope deployment. Direct requests about deployment
data to that organization's administrator or privacy contact.

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
