#!/bin/sh
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

set -eu

usage() {
  echo "Usage: $0 <api-url> <agent-manifest.yaml> [--available true|false] [version-manifest.yaml ...]" >&2
}

if [ "$#" -lt 2 ]; then
  usage
  exit 2
fi

command -v wget >/dev/null 2>&1 || {
  echo "wget is required" >&2
  exit 2
}
command -v timeout >/dev/null 2>&1 || {
  echo "timeout is required" >&2
  exit 2
}
command -v yq >/dev/null 2>&1 || {
  echo "yq is required" >&2
  exit 2
}

API_URL=${1%/}
AGENT_MANIFEST=$2
shift 2

case "$API_URL" in
  http://* | https://*) ;;
  *)
    echo "API URL must use http or https: $API_URL" >&2
    exit 2
    ;;
esac

AVAILABLE_OVERRIDE=
if [ "${1:-}" = "--available" ]; then
  if [ "$#" -lt 2 ]; then
    usage
    exit 2
  fi
  AVAILABLE_OVERRIDE=$2
  case "$AVAILABLE_OVERRIDE" in
    true | false) ;;
    *)
      echo "--available must be true or false" >&2
      exit 2
      ;;
  esac
  shift 2
fi

MAX_ATTEMPTS=${SCOPE_REGISTRATION_MAX_ATTEMPTS:-10}
BASE_DELAY_SECONDS=${SCOPE_REGISTRATION_BASE_DELAY_SECONDS:-1}
MAX_DELAY_SECONDS=${SCOPE_REGISTRATION_MAX_DELAY_SECONDS:-5}
CONNECT_TIMEOUT_SECONDS=${SCOPE_REGISTRATION_CONNECT_TIMEOUT_SECONDS:-5}
REQUEST_TIMEOUT_SECONDS=${SCOPE_REGISTRATION_REQUEST_TIMEOUT_SECONDS:-30}

case "$MAX_ATTEMPTS:$BASE_DELAY_SECONDS:$MAX_DELAY_SECONDS:$CONNECT_TIMEOUT_SECONDS:$REQUEST_TIMEOUT_SECONDS" in
  *[!0-9:]* | 0:* | *:0:* | *:0:* | *:0:* | *:0)
    echo "Registration retry settings must be positive integers" >&2
    exit 2
    ;;
esac

if [ ! -f "$AGENT_MANIFEST" ]; then
  echo "Agent manifest not found: $AGENT_MANIFEST" >&2
  exit 2
fi

TMP_DIR=$(mktemp -d)
RESPONSE_FILE="$TMP_DIR/response"
DIAGNOSTICS_FILE="$TMP_DIR/wget-diagnostics"
PAYLOAD_FILE="$TMP_DIR/request.json"
trap 'rm -f "$RESPONSE_FILE" "$DIAGNOSTICS_FILE" "$PAYLOAD_FILE"; rmdir "$TMP_DIR"' EXIT HUP INT TERM

REQUEST_STATUS=000
REQUEST_EXIT=0

response_body() {
  if [ -f "$RESPONSE_FILE" ]; then
    cat "$RESPONSE_FILE"
  fi
}

request_diagnostics() {
  if [ -s "$DIAGNOSTICS_FILE" ]; then
    tail -n 3 "$DIAGNOSTICS_FILE" | tr '\n' ' '
  else
    printf 'no wget diagnostics'
  fi
}

failure_details() {
  if [ -s "$RESPONSE_FILE" ]; then
    response_body
  else
    request_diagnostics
  fi
}

is_transient_status() {
  case "$1" in
    000 | 408 | 425 | 429 | 5??)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

sleep_with_backoff() {
  attempt=$1
  delay=$BASE_DELAY_SECONDS
  step=1
  while [ "$step" -lt "$attempt" ] && [ "$delay" -lt "$MAX_DELAY_SECONDS" ]; do
    delay=$((delay * 2))
    if [ "$delay" -gt "$MAX_DELAY_SECONDS" ]; then
      delay=$MAX_DELAY_SECONDS
    fi
    step=$((step + 1))
  done
  sleep "$delay"
}

perform_request() {
  method=$1
  url=$2
  payload=${3:-}

  : > "$RESPONSE_FILE"
  : > "$DIAGNOSTICS_FILE"
  REQUEST_STATUS=000
  REQUEST_EXIT=0

  if [ "$method" = "POST" ]; then
    printf '%s' "$payload" > "$PAYLOAD_FILE"
    if timeout "$REQUEST_TIMEOUT_SECONDS" \
      wget -S -O "$RESPONSE_FILE" \
        -T "$CONNECT_TIMEOUT_SECONDS" \
        --header "Content-Type: application/json" \
        --post-file "$PAYLOAD_FILE" \
        "$url" 2> "$DIAGNOSTICS_FILE"; then
      :
    else
      REQUEST_EXIT=$?
    fi
  else
    if timeout "$REQUEST_TIMEOUT_SECONDS" \
      wget -S -O "$RESPONSE_FILE" \
        -T "$CONNECT_TIMEOUT_SECONDS" \
        "$url" 2> "$DIAGNOSTICS_FILE"; then
      :
    else
      REQUEST_EXIT=$?
    fi
  fi

  # wget -S writes every redirect response to stderr; the final HTTP line wins.
  REQUEST_STATUS=$(
    awk '/^  HTTP\/[0-9.]+ [0-9][0-9][0-9]/ { status=$2 } END { print status }' \
      "$DIAGNOSTICS_FILE"
  )
  REQUEST_STATUS=${REQUEST_STATUS:-000}

  # A received success or redirect header is not success if the transfer failed.
  case "$REQUEST_STATUS:$REQUEST_EXIT" in
    2??:0 | 3??:0) ;;
    2??:* | 3??:*) REQUEST_STATUS=000 ;;
  esac
}

wait_for_api() {
  attempt=1
  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    perform_request GET "$API_URL/health"

    case "$REQUEST_STATUS" in
      2??)
        return 0
        ;;
    esac

    if ! is_transient_status "$REQUEST_STATUS"; then
      echo "Permanent API readiness failure (HTTP $REQUEST_STATUS): $(failure_details)" >&2
      return 1
    fi
    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "API readiness failed after $MAX_ATTEMPTS attempts (last HTTP $REQUEST_STATUS, wget exit $REQUEST_EXIT): $(request_diagnostics)" >&2
      return 1
    fi

    if [ "$REQUEST_STATUS" = "000" ]; then
      echo "API not ready (no HTTP response, wget exit $REQUEST_EXIT): $(request_diagnostics); retrying..." >&2
    else
      echo "API not ready (HTTP $REQUEST_STATUS), retrying..." >&2
    fi
    sleep_with_backoff "$attempt"
    attempt=$((attempt + 1))
  done
}

post_idempotent() {
  path=$1
  payload=$2
  description=$3
  attempt=1

  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    perform_request POST "$API_URL$path" "$payload"

    case "$REQUEST_STATUS" in
      2??)
        echo "Registered $description"
        return 0
        ;;
    esac

    if ! is_transient_status "$REQUEST_STATUS"; then
      echo "Permanent $description registration failure (HTTP $REQUEST_STATUS): $(failure_details)" >&2
      return 1
    fi
    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "$description registration failed after $MAX_ATTEMPTS attempts (last HTTP $REQUEST_STATUS, wget exit $REQUEST_EXIT): $(failure_details)" >&2
      return 1
    fi

    if [ "$REQUEST_STATUS" = "000" ]; then
      echo "Transient $description registration transport failure (wget exit $REQUEST_EXIT): $(request_diagnostics); retrying..." >&2
    else
      echo "Transient $description registration failure (HTTP $REQUEST_STATUS), retrying..." >&2
    fi
    sleep_with_backoff "$attempt"
    attempt=$((attempt + 1))
  done
}

wait_for_api

AGENT_ID=$(yq -r '._id // ""' "$AGENT_MANIFEST")
case "$AGENT_ID" in
  "" | *[!A-Za-z0-9._-]*)
    echo "Agent manifest _id must be non-empty and URL-safe: $AGENT_MANIFEST" >&2
    exit 2
    ;;
esac

if [ -n "$AVAILABLE_OVERRIDE" ]; then
  AGENT_JSON=$(
    SCOPE_AGENT_AVAILABLE="$AVAILABLE_OVERRIDE" \
      yq -o=json -I=0 \
        '.available = (strenv(SCOPE_AGENT_AVAILABLE) == "true")' \
        "$AGENT_MANIFEST"
  )
else
  AGENT_JSON=$(yq -o=json -I=0 "$AGENT_MANIFEST")
fi
post_idempotent "/api/v1/agents" "$AGENT_JSON" "agent $AGENT_ID"

for VERSION_MANIFEST in "$@"; do
  if [ ! -f "$VERSION_MANIFEST" ]; then
    echo "Version manifest not found: $VERSION_MANIFEST" >&2
    exit 2
  fi
  VERSION_JSON=$(yq -o=json -I=0 "$VERSION_MANIFEST")
  VERSION_ID=$(yq -r '.agentVersion // ""' "$VERSION_MANIFEST")
  if [ -z "$VERSION_ID" ]; then
    echo "Version manifest agentVersion must be non-empty: $VERSION_MANIFEST" >&2
    exit 2
  fi
  post_idempotent \
    "/api/v1/agents/$AGENT_ID/versions" \
    "$VERSION_JSON" \
    "version $AGENT_ID@$VERSION_ID"
done
