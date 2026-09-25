---
description: |
  This workflow creates daily repo status reports. It gathers recent repository
  activity (issues, PRs, discussions, releases, code changes) and generates
  engaging GitHub issues with productivity insights, community highlights,
  and project recommendations.

on:
  schedule:
    - cron: "47 23 * * *"
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read

network: defaults

tools:
  github:
    mode: remote
    toolsets: [repos, issues, pull_requests]
    lockdown: false
    github-app:
      app-id: ${{ secrets.GH_AG_APP_ID }}
      private-key: ${{ secrets.GH_AG_APP_PRIVATE_KEY }}
      owner: "growth-ecosystems"
      repositories: ["scope-core", "scope-core-infra"]

safe-outputs:
  mentions: false
  allowed-github-references: []
  create-issue:
    title-prefix: "[repo-status] "
    labels: [agentic-workflows]
    close-older-issues: true
source: githubnext/agentics/workflows/daily-repo-status.md@346204513ecfa08b81566450d7d599556807389f
---

# Daily Repo Status

Create an upbeat daily status report for the repo as a GitHub issue.

## What to include

- Recent repository activity (issues, PRs, discussions, releases, code changes) from both `growth-ecosystems/scope-core` and `growth-ecosystems/scope-core-infra`
- Infrastructure changes and deployment status from the infra repo
- Progress tracking, goal reminders and highlights
- Project status and recommendations
- Actionable next steps for maintainers

## Style

- Be positive, encouraging, and helpful 🌟
- Use emojis moderately for engagement
- Keep it concise - adjust length based on actual activity

## Process

1. Gather recent activity from the repository
2. Study the repository, its issues and its pull requests
3. Create a new GitHub issue with your findings and insights
