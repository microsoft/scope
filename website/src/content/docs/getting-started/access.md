---
title: Access
description: How to reach the Scope Portal.
---

You can access Scope through the web Portal, the REST API, or the
`scope` CLI.

This page assumes you have access to an existing deployment. To run Scope
yourself, follow [Local development](/getting-started/local-development/) for
prerequisites, setup, authentication, and a first evaluation.

## Requirements

Your deployment administrator provides the Portal URL and any required
authentication details.

## Portal URL

Open the Portal URL provided for your deployment. For example:

**https://your-scope.example.com**

Open the URL in any modern browser. The Portal is the entry point for
submitting requests, browsing results, and managing task prompts,
criteria, profiles, and prompt features.

## REST API access

The REST API is available at the same host under `/api/v1`. See
[Submitting requests (REST API)](/guides/submitting-requests-api/) for
endpoint examples.

## What you'll need

You don't need to install anything to use the Portal.

Your deployment may require credentials to run coding agents or pull
skills from GitHub repositories. Contact your deployment administrator
for the required setup.

## CLI access

For terminal-based workflows, install the `scope` CLI:

```bash
gh api repos/microsoft/scope/contents/website/install-cli.sh \
  -H "Accept: application/vnd.github.raw" | bash
```

See [Install the CLI](/getting-started/install-cli/) for details.

## Next steps

- Walk through [Your first run](/getting-started/first-run/) to submit
  a benchmark run end to end.
- [Install the CLI](/getting-started/install-cli/) for terminal-based
  workflows.
- Or skip ahead to [Submitting requests (Portal)](/guides/submitting-requests-portal/)
  for the full Portal workflow.
