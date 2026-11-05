---
name: github-actions
description: Use when creating, editing, reviewing, or troubleshooting GitHub Actions workflows in Scope.
metadata:
  version: "1.0.0"
---

# GitHub Actions

Every external action or reusable workflow under `.github/workflows/` must use
a full 40-character commit SHA followed by its release version comment. Local
actions (`./...`) and container actions (`docker://...`) are exempt.

Use `pinact run` to add or update pins instead of resolving SHAs manually.
Preserve the selected action version unless the task explicitly requests an
upgrade.

Before completion, run:

```bash
pinact run --check --verify-comment
pnpm exec vitest run scripts/ci-workflow.test.ts
```

Do not hand-edit generated `*.lock.yml` workflows. Update their owning gh-aw
Markdown source and run `gh aw compile`.
