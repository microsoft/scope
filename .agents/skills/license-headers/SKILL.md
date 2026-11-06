---
name: license-headers
description: >
  Routes new source files to the repo's MIT copyright-header tooling
  (`pnpm headers` / `pnpm headers:check`) — never hand-write the header.
  Trigger: creating/adding a first-party .ts/.tsx/.js/.mjs/.rs/.bicep/.css
  source file, or a failing `license-headers` CI check.
  Not for: editing existing files, or generated/vendored/config/doc files.
metadata:
  version: "1.0.0"
---

# License Headers

First-party source files must carry the Microsoft MIT copyright header. This is a
release-gating compliance requirement, enforced in CI on every PR.

**Do not hand-write, copy, or template the header text into files.** The exact
text, the per-language comment style, the placement rules (shebang / directive
prologue), and the set of in-scope file types all live in the tooling and would
drift if duplicated here.

## When this applies

Any time you create or add a first-party source file in an in-scope language
(TypeScript, JavaScript, Rust, Bicep, CSS, and similar). The script owns the
authoritative in-scope extension list and the generated/vendored exclusions — do
not maintain a parallel list.

## Source of truth

The header tooling is the only authority:

- **Fixer:** `pnpm headers` — inserts any missing headers in place (idempotent).
- **Verifier:** `pnpm headers:check` — fails if any in-scope file is missing it.
- Their implementation lives behind those `package.json` entries (discover it
  there — do not assume a specific script file). Enforced by the `license-headers`
  job in `.github/workflows/ci.yml`.

**Discover the exact current invocation before running.** Confirm the script
names in `package.json` (`scripts`) and the enforcing job in
`.github/workflows/ci.yml` rather than trusting a command copied into this skill —
the entry-point names are the stable contract, but verify them against the repo.

## What to do

1. After adding source files, run `pnpm headers` to insert headers.
2. Run `pnpm headers:check` to verify — this mirrors the CI gate exactly.
3. Commit the header changes alongside your new files.

## On failure

If `pnpm headers:check` (or the CI job) reports missing headers, run the fixer
`pnpm headers` and re-run the check. If a file legitimately must NOT carry the
header (e.g. generated or third-party vendored output), that belongs in the header
tooling's own configuration — discover it via the `headers` script in
`package.json` — and update that configuration; never bypass or silence the check
ad hoc.
