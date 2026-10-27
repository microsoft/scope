#!/usr/bin/env bash
#
# Acceptance scenario (issue #1110): codebases as first-class entities.
#
# Drives the canonical end-to-end proof as a Ralph loop — it re-runs the same
# import → resolve → submit → wait → judge cycle until the "uses Astro"
# criterion passes against the seeded real codebase (or a max-iteration cap is
# hit). The loop is the executable definition of done for the e2e layer:
#
#   1. Ensure a *git* codebase for pamelafox/pamelafox-site exists.
#   2. Resolve its latest revision (each resolve creates a new immutable
#      revision with the real resolvedCommitSha + commitTimestamp, snapshot
#      stored in blob storage) and capture its {slug}@r{N} ref.
#   3. Submit a "migrate this site to Astro" run that selects that codebase
#      revision and includes a criterion validating the result uses Astro.
#   4. The worker seeds the fresh workspace with the snapshot BEFORE the agent
#      starts; the agent migrates the real files; the Judge evaluates the
#      "uses Astro" criterion against the post-run workspace.
#   5. Pass → exit 0. Fail → print diagnosis hints and iterate.
#
# PREREQUISITES (this script does NOT start them — it needs a live stack):
#   pnpm docker:up:infra            # MongoDB, Redis, Azurite, Lowkey Vault
#   pnpm docker:dev:copilot         # API + Copilot worker (real agent)
#   A valid Copilot token must be provisioned for the worker.
#   jq and curl must be on PATH.
#
# REQUIRED ENV:
#   SCOPE_PROJECT       project UUID for the scoped API calls
#   ASTRO_CRITERION_ID   id of a criterion asserting the project uses Astro
#                        (e.g. "The project is built with the Astro framework"
#                        — checks for an `astro` dependency in package.json,
#                        an astro.config.*, and .astro components). Create it
#                        first via the Portal criteria editor or:
#                          pnpm cli criteria create ...
#
# OPTIONAL ENV (defaults shown):
#   SCOPE_API_URL=http://localhost:5108
#   CODEBASE_NAME="pamelafox-site"
#   CODEBASE_SOURCE="pamelafox/pamelafox-site"
#   DEFAULT_BRANCH="main"
#   WORKER="coder-acp-copilot"
#   TASK="Migrate this site to the Astro framework."
#   MODEL=""                       # optional model override
#   MAX_LOOP=10                    # Ralph-loop iteration cap
#   POLL_TIMEOUT=2400              # seconds to wait for a run to finish
#   POLL_INTERVAL=15               # seconds between status polls
#   RUN_GATES=0                    # 1 = run `pnpm -r build` before the loop
#
set -euo pipefail

API="${SCOPE_API_URL:-http://localhost:5108}"
CODEBASE_NAME="${CODEBASE_NAME:-pamelafox-site}"
CODEBASE_SOURCE="${CODEBASE_SOURCE:-pamelafox/pamelafox-site}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
WORKER="${WORKER:-coder-acp-copilot}"
TASK="${TASK:-Migrate this site to the Astro framework.}"
MODEL="${MODEL:-}"
MAX_LOOP="${MAX_LOOP:-10}"
POLL_TIMEOUT="${POLL_TIMEOUT:-2400}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
RUN_GATES="${RUN_GATES:-0}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v jq >/dev/null   || fail "jq is required"
command -v curl >/dev/null || fail "curl is required"
[ -n "${ASTRO_CRITERION_ID:-}" ] || fail "ASTRO_CRITERION_ID must be set (the 'uses Astro' criterion id)"
[ -n "${SCOPE_PROJECT:-}" ] || fail "SCOPE_PROJECT must be set to the target project UUID (see 'scope project list')"
PROJECT_QUERY="$(jq -rn --arg id "$SCOPE_PROJECT" '$id|@uri')"

api() { # api METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  local separator='?'
  [[ "$path" == *\?* ]] && separator='&'
  local url="$API$path${separator}projectId=$PROJECT_QUERY"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$url" -H 'Content-Type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$url"
  fi
}

bold "Acceptance: pamelafox-site → Astro  (API: $API)"

# ---- Optional pre-loop gate -------------------------------------------------
if [ "$RUN_GATES" = "1" ]; then
  bold "Gate: pnpm -r build"
  pnpm -r build
fi

# ---- Step 1: ensure the git codebase exists ---------------------------------
bold "Step 1: ensure git codebase '$CODEBASE_NAME' ($CODEBASE_SOURCE)"
CODEBASE_ID="$(api GET /api/v1/codebases | jq -r --arg s "$CODEBASE_SOURCE" \
  '.[] | select(.sourceType=="git" and .source==$s and (.deletedAt|not)) | .id // ._id' | head -n1)"

if [ -z "$CODEBASE_ID" ] || [ "$CODEBASE_ID" = "null" ]; then
  info "creating codebase…"
  # CLI parity: pnpm cli codebase create --name "$CODEBASE_NAME" \
  #   --source-type git --source "$CODEBASE_SOURCE" --default-branch "$DEFAULT_BRANCH"
  CREATE_BODY="$(jq -n --arg n "$CODEBASE_NAME" --arg s "$CODEBASE_SOURCE" --arg b "$DEFAULT_BRANCH" \
    '{name:$n, sourceType:"git", source:$s, defaultBranch:$b}')"
  CODEBASE_ID="$(api POST /api/v1/codebases "$CREATE_BODY" | jq -r '.id // ._id')"
  info "created codebase id=$CODEBASE_ID"
else
  info "found existing codebase id=$CODEBASE_ID"
fi

# ---- Step 2: resolve the latest revision ------------------------------------
bold "Step 2: resolve latest revision"
# CLI parity: pnpm cli codebase resolve "$CODEBASE_NAME" --ref latest
REVISION_JSON="$(api POST "/api/v1/codebases/$CODEBASE_ID/revisions" '{"requestedRef":"latest"}')"
CODEBASE_REF="$(echo "$REVISION_JSON" | jq -r '.ref')"
RESOLVED_SHA="$(echo "$REVISION_JSON" | jq -r '.resolvedCommitSha // "unknown"')"
info "resolved ref=$CODEBASE_REF  commit=$RESOLVED_SHA"
[ -n "$CODEBASE_REF" ] && [ "$CODEBASE_REF" != "null" ] || fail "revision resolution returned no ref"

# ---- Ralph loop -------------------------------------------------------------
bold "Ralph loop: submit migrate-to-Astro until the 'uses Astro' criterion is green (max $MAX_LOOP)"

iteration=0
while [ "$iteration" -lt "$MAX_LOOP" ]; do
  iteration=$((iteration + 1))
  bold "── iteration $iteration/$MAX_LOOP ──"

  # Step 3: submit the acceptance run selecting the seeded codebase revision.
  # CLI parity:
  #   pnpm cli run submit -m "$TASK" -c "$ASTRO_CRITERION_ID" \
  #     --codebase "$CODEBASE_REF" --worker "$WORKER"
  SUBMIT_BODY="$(jq -n --arg task "$TASK" --arg crit "$ASTRO_CRITERION_ID" \
    --arg cb "$CODEBASE_REF" --arg model "$MODEL" '
    {scenario:{task:$task, criteria:[$crit]}, codebase:$cb}
    + (if $model == "" then {} else {model:$model} end)')"
  REQ="$(api POST "/api/v1/requests?worker=$WORKER" "$SUBMIT_BODY")"
  REQ_ID="$(echo "$REQ" | jq -r '.id // ._id')"
  [ -n "$REQ_ID" ] && [ "$REQ_ID" != "null" ] || fail "submit returned no request id: $REQ"
  info "submitted request id=$REQ_ID (codebase=$CODEBASE_REF)"

  # Step 4+5: poll until terminal, then read the Judge's per-criterion result.
  elapsed=0
  status="pending"
  while [ "$elapsed" -lt "$POLL_TIMEOUT" ]; do
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
    DOC="$(api GET "/api/v1/requests/$REQ_ID" || true)"
    status="$(echo "$DOC" | jq -r '.run.status // "pending"')"
    case "$status" in
      done|paused|failed|error|cancelled|canceled)
        break ;;
    esac
    printf '\r  waiting… status=%s (%ss)        ' "$status" "$elapsed"
  done
  printf '\n'
  info "run terminal status=$status after ${elapsed}s"

  # Extract the Astro criterion outcome from the latest turn's criteriaResults.
  ASTRO_PASSED="$(echo "$DOC" | jq -r --arg c "$ASTRO_CRITERION_ID" '
    [ .run.turns[]?.criteriaResults[]? | select(.criterionId==$c) ] | last | .passed // false')"
  RUN_PASSED="$(echo "$DOC" | jq -r '.run.passed // false')"

  if [ "$ASTRO_PASSED" = "true" ]; then
    bold "✅ PASS — '$CODEBASE_REF' migrated to Astro; criterion green (run.passed=$RUN_PASSED, request=$REQ_ID)"
    exit 0
  fi

  bold "❌ iteration $iteration did not pass the Astro criterion"
  info "Judge feedback (latest turn):"
  echo "$DOC" | jq -r --arg c "$ASTRO_CRITERION_ID" '
    [ .run.turns[]?.criteriaResults[]? | select(.criterionId==$c) ] | last | .feedback // "(no feedback)"' | sed 's/^/    /'
  info "Diagnosis checklist (most likely in new code paths):"
  info "  • worker seeding ran before the agent (queue-processor codebase hook)"
  info "  • archive extracted to workspace ROOT (codebase-archive normalization)"
  info "  • revision resolution captured the real repo (resolvedCommitSha=$RESOLVED_SHA)"
  info "  • codebaseRevisionId persisted on the RequestDocument (submit wiring)"
  info "Inspect: pnpm cli run get -i $REQ_ID  &&  pnpm cli run logs -i $REQ_ID"
done

fail "Ralph loop exhausted $MAX_LOOP iterations without passing the Astro criterion — see diagnosis above"
