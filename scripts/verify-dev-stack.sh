#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

set -euo pipefail

ATTEMPTS="${SCOPE_DEV_READY_ATTEMPTS:-300}"
DELAY_SECONDS="${SCOPE_DEV_READY_DELAY_SECONDS:-2}"
CURL_TIMEOUT_SECONDS="${SCOPE_DEV_READY_CURL_TIMEOUT_SECONDS:-2}"
REQUESTED_SERVICES="${SCOPE_DEV_VERIFY_SERVICES:-}"

COMPOSE=(docker compose "$@")
TARGET_SERVICES=(portal api gateway coder-acp-copilot)

declare -A SERVICE_PORTS=(
  [portal]=80
  [api]=80
  [gateway]=18000
)
declare -A SERVICE_PATHS=(
  [portal]=/
  [api]=/ready
  [gateway]=/health/ready
)
declare -A SERVICE_LABELS=(
  [portal]=Portal
  [api]=API
  [gateway]=Gateway
)
declare -A LAST_STATES=()
declare -A LAST_CURL_EXIT=()
declare -A LAST_HTTP_CODE=()
declare -A VERIFIED_URLS=()

WORKER_QUEUE_READY=0
WORKER_MONGO_READY=0

# Resolve the services selected by profiles unless the wrapper supplied an
# explicit service subset from `docker compose up SERVICE...`.
if [ -z "$REQUESTED_SERVICES" ]; then
  REQUESTED_SERVICES="$("${COMPOSE[@]}" config --services)"
fi

ACTIVE_SERVICES=()
for target in "${TARGET_SERVICES[@]}"; do
  if grep -qx "$target" <<<"$REQUESTED_SERVICES"; then
    ACTIVE_SERVICES+=("$target")
  fi
done

if [ "${#ACTIVE_SERVICES[@]}" -eq 0 ]; then
  exit 0
fi

# Return the current container state, preferring Docker health when configured.
service_state() {
  local service="$1"
  local container_id
  container_id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null | head -n 1)"

  if [ -z "$container_id" ]; then
    printf 'not-created'
    return
  fi

  docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$container_id" 2>/dev/null || printf 'unknown'
}

# Resolve the published host port without trusting a URL emitted by a service.
published_url() {
  local service="$1"
  local container_port="$2"
  local path="$3"
  local mapping
  local host_port

  mapping="$("${COMPOSE[@]}" port "$service" "$container_port" 2>/dev/null | head -n 1)"
  host_port="${mapping##*:}"
  if [[ ! "$host_port" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  printf 'http://127.0.0.1:%s%s' "$host_port" "$path"
}

# Probe once with strict per-attempt bounds. HTTP failures remain distinct from
# transport failures so final diagnostics identify the right failure class.
probe_endpoint() {
  local service="$1"
  local url="$2"
  local result
  local curl_exit

  set +e
  result="$(curl \
    --silent \
    --output /dev/null \
    --write-out '%{http_code}' \
    --connect-timeout "$CURL_TIMEOUT_SECONDS" \
    --max-time "$CURL_TIMEOUT_SECONDS" \
    "$url" 2>/dev/null)"
  curl_exit=$?
  set -e

  LAST_CURL_EXIT["$service"]="$curl_exit"
  LAST_HTTP_CODE["$service"]="${result:-000}"

  [ "$curl_exit" -eq 0 ] && [[ "$result" =~ ^2[0-9][0-9]$ ]]
}

# The worker has no HTTP readiness endpoint. Its strongest existing observable
# startup contract is a running container plus both queue and MongoDB startup
# milestones from the current Compose container logs.
probe_worker() {
  local state
  local logs

  state="$(service_state coder-acp-copilot)"
  LAST_STATES[coder-acp-copilot]="$state"
  case "$state" in
    running|healthy) ;;
    *) return 1 ;;
  esac

  logs="$("${COMPOSE[@]}" logs --no-color coder-acp-copilot 2>/dev/null || true)"
  if grep -Fq '[coder-acp-copilot] Ensured queue exists: queue-coder-acp-copilot' <<<"$logs"; then
    WORKER_QUEUE_READY=1
  fi
  if grep -Fq '[coder-acp-copilot] Connected to MongoDB' <<<"$logs"; then
    WORKER_MONGO_READY=1
  fi

  [ "$WORKER_QUEUE_READY" -eq 1 ] && [ "$WORKER_MONGO_READY" -eq 1 ]
}

echo "Verifying published development endpoints and worker readiness..."

all_ready=0
for ((attempt = 1; attempt <= ATTEMPTS; attempt += 1)); do
  all_ready=1

  for service in "${ACTIVE_SERVICES[@]}"; do
    if [ "$service" = "coder-acp-copilot" ]; then
      if ! probe_worker; then
        all_ready=0
      fi
      continue
    fi

    state="$(service_state "$service")"
    LAST_STATES["$service"]="$state"
    case "$state" in
      running|healthy)
        if url="$(published_url "$service" "${SERVICE_PORTS[$service]}" "${SERVICE_PATHS[$service]}")"; then
          if probe_endpoint "$service" "$url"; then
            VERIFIED_URLS["$service"]="$url"
          else
            all_ready=0
          fi
        else
          LAST_CURL_EXIT["$service"]=1
          LAST_HTTP_CODE["$service"]=000
          all_ready=0
        fi
        ;;
      *)
        all_ready=0
        ;;
    esac
  done

  if [ "$all_ready" -eq 1 ]; then
    break
  fi

  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$DELAY_SECONDS"
  fi
done

if [ "$all_ready" -eq 1 ]; then
  for service in portal api gateway; do
    if [ -n "${VERIFIED_URLS[$service]:-}" ]; then
      safe_url="${VERIFIED_URLS[$service]/127.0.0.1/localhost}"
      echo "${SERVICE_LABELS[$service]} verified: $safe_url"
    fi
  done
  if grep -qx 'coder-acp-copilot' <<<"$REQUESTED_SERVICES"; then
    echo "Copilot worker verified: container running, queue ensured, and MongoDB connected."
  fi
  exit 0
fi

echo "Development stack readiness verification failed." >&2
for service in "${ACTIVE_SERVICES[@]}"; do
  state="${LAST_STATES[$service]:-not-created}"

  if [ "$service" = "coder-acp-copilot" ]; then
    case "$state" in
      running|healthy)
        missing=()
        [ "$WORKER_QUEUE_READY" -eq 0 ] && missing+=("queue creation")
        [ "$WORKER_MONGO_READY" -eq 0 ] && missing+=("MongoDB connection")
        missing_text="${missing[0]}"
        if [ "${#missing[@]}" -gt 1 ]; then
          missing_text+=", ${missing[1]}"
        fi
        printf 'Copilot worker is running but not ready; missing startup signal(s): %s.\n' \
          "$missing_text" >&2
        echo "Inspect with: docker compose logs coder-acp-copilot" >&2
        ;;
      *)
        echo "Copilot worker is not running and ready (container state: $state)." >&2
        echo "Inspect with: docker compose ps coder-acp-copilot && docker compose logs coder-acp-copilot" >&2
        ;;
    esac
    continue
  fi

  label="${SERVICE_LABELS[$service]}"
  if [ -n "${VERIFIED_URLS[$service]:-}" ]; then
    continue
  fi
  case "$state" in
    running|healthy)
      if [ "${LAST_CURL_EXIT[$service]:-1}" -ne 0 ] || [ "${LAST_HTTP_CODE[$service]:-000}" = "000" ]; then
        echo "$label container is $state, but its published host endpoint is unreachable." >&2
        echo "This usually indicates runtime VM networking or host port-forwarding failure." >&2
        echo "Inspect without changing runtimes: docker compose ps $service && docker compose port $service ${SERVICE_PORTS[$service]}" >&2
      else
        echo "$label host endpoint is reachable but not ready (HTTP ${LAST_HTTP_CODE[$service]})." >&2
        echo "Inspect with: docker compose logs $service" >&2
      fi
      ;;
    *)
      echo "$label service is unhealthy or not running (container state: $state)." >&2
      echo "Inspect with: docker compose ps $service && docker compose logs $service" >&2
      ;;
  esac
done

exit 1
