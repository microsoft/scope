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

command -v curl >/dev/null 2>&1 || {
  echo "curl is required" >&2
  exit 2
}
command -v yq >/dev/null 2>&1 || {
  echo "yq is required" >&2
  exit 2
}

API_URL=${1%/}
AGENT_MANIFEST=$2
shift 2

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
trap 'rm -f "$RESPONSE_FILE"; rmdir "$TMP_DIR"' EXIT HUP INT TERM

response_body() {
  if [ -f "$RESPONSE_FILE" ]; then
    cat "$RESPONSE_FILE"
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

is_transient_curl_exit() {
  case "$1" in
    5 | 6 | 7 | 18 | 28 | 35 | 52 | 55 | 56)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

handle_curl_failure() {
  curl_exit=$1
  description=$2
  if is_transient_curl_exit "$curl_exit"; then
    return 0
  fi
  echo "Permanent $description failure (curl exit $curl_exit)" >&2
  return 1
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

wait_for_api() {
  attempt=1
  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    status=000
    if status=$(curl -sS --connect-timeout "$CONNECT_TIMEOUT_SECONDS" \
      --max-time "$REQUEST_TIMEOUT_SECONDS" \
      -o "$RESPONSE_FILE" -w "%{http_code}" "$API_URL/health"); then
      :
    else
      curl_exit=$?
      handle_curl_failure "$curl_exit" "API readiness" || return 1
      status=000
    fi

    case "$status" in
      2??)
        return 0
        ;;
    esac

    if ! is_transient_status "$status"; then
      echo "Permanent API readiness failure (HTTP $status): $(response_body)" >&2
      return 1
    fi
    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "API readiness failed after $MAX_ATTEMPTS attempts (last HTTP $status)" >&2
      return 1
    fi

    echo "API not ready (HTTP $status), retrying..." >&2
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
    status=000
    if status=$(curl -sS --connect-timeout "$CONNECT_TIMEOUT_SECONDS" \
      --max-time "$REQUEST_TIMEOUT_SECONDS" \
      -o "$RESPONSE_FILE" -w "%{http_code}" \
      -X POST "$API_URL$path" \
      -H "Content-Type: application/json" \
      --data-binary "$payload"); then
      :
    else
      curl_exit=$?
      handle_curl_failure "$curl_exit" "$description registration" || return 1
      status=000
    fi

    case "$status" in
      2??)
        echo "Registered $description"
        return 0
        ;;
    esac

    if ! is_transient_status "$status"; then
      echo "Permanent $description registration failure (HTTP $status): $(response_body)" >&2
      return 1
    fi
    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "$description registration failed after $MAX_ATTEMPTS attempts (last HTTP $status): $(response_body)" >&2
      return 1
    fi

    echo "Transient $description registration failure (HTTP $status), retrying..." >&2
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
