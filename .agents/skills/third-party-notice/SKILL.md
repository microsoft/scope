---
name: third-party-notice
description: >
  Routes dependency changes to the repo's NOTICE tooling (`pnpm notice` /
  `pnpm notice:check`) and escalates proprietary/non-OSS redistributables to
  CELA before redistribution.
  Trigger: adding/removing/upgrading a dependency, or bundling a third-party binary.
  Not for: code changes that don't touch dependencies or bundled binaries.
metadata:
  version: "1.0.0"
---

# Third-Party NOTICE

Redistributing this repo requires an accurate `NOTICE` file attributing every
bundled third-party dependency. Changing the dependency graph can change what must
be attributed, so the NOTICE is regenerated from the lockfile — never edited by
hand.

**Do not hand-write attributions or the SPDX/license breakdown into this skill or
into `NOTICE`.** That content is derived from the installed dependencies and would
drift instantly. The generator is the single source of truth.

## When this applies

- Adding, removing, or upgrading any dependency (`package.json` /
  `pnpm-lock.yaml` changes).
- Bundling, vendoring, or shipping a third-party binary or redistributable.

## Source of truth

The NOTICE tooling is the only authority:

- **Regenerate:** `pnpm notice` — rebuilds `NOTICE` (and the review report).
- **Verify:** `pnpm notice:check` — fails if `NOTICE` is stale vs. the lockfile.
- The current implementation behind them (e.g. `scripts/generate-notice.sh`)
  should be confirmed via `package.json`. Produces `NOTICE` and `NOTICE-REVIEW.txt`.

**Discover the exact current invocation before running.** Confirm the script names
in `package.json` (`scripts`) and the enforcing job in
`.github/workflows/ci.yml` rather than trusting a command copied here. Note: this
tooling lands with the NOTICE PR — if `pnpm notice` is not yet present on your
branch, that PR has not merged yet; do not reimplement the generator.

## What to do

1. After any dependency change, run `pnpm notice` to regenerate.
2. Commit the updated `NOTICE`.
3. Run `pnpm notice:check` to confirm it matches (mirrors the CI gate).
4. Review `NOTICE-REVIEW.txt` for anything the generator flagged.

## On failure or flagged entries

- **Stale NOTICE:** run `pnpm notice` and re-check.
- **Escalate proprietary / non-OSS redistributables to CELA.** Packages that are
  not open source (for example the `@github/copilot` CLI packages) surface in
  `NOTICE-REVIEW.txt` and require **CELA legal sign-off** before they may be
  redistributed. Do NOT attempt to auto-resolve, relicense, or silence these —
  flag them and escalate to CELA / the release owner.
