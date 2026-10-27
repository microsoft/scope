#!/bin/sh
# Regenerate the portal's runtime config from environment variables before
# nginx starts. This lets a single built image be promoted across environments
# while still pointing at the correct docs site / auth toggle per environment.
#
# Dropped into /docker-entrypoint.d/ so the stock nginx entrypoint runs it
# (and then starts nginx itself) — this script must NOT exec nginx.
set -eu

DOCS_BASE_URL="${SCOPE_DOCS_BASE_URL:-https://urban-disco-1qzzq7z.pages.github.io}"
CONFIG_PATH="${SCOPE_CONFIG_PATH:-/usr/share/nginx/html/config.js}"

# Auth feature toggle for this environment (integration/production). Auth is ON
# by default (secure by default); set SCOPE_AUTH_ENABLED=false on the overlay to
# disable sign-in until that environment's API verifies tokens. Coerced to a
# real JS boolean literal for window.__SCOPE_CONFIG__.authEnabled.
case "$(printf '%s' "${SCOPE_AUTH_ENABLED:-true}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
  false|0|no|off) AUTH_ENABLED=false ;;
  *) AUTH_ENABLED=true ;;
esac

# Serialize UTF-8 strings as JS literals, including embedded quotes and newlines.
js_string() {
  printf '"'
  printf '%s' "$1" | od -An -v -tu1 | awk '
    { for (i = 1; i <= NF; i++) {
        byte = $i + 0
        if (byte == 34 || byte == 92) printf "\\%c", byte
        else if (byte < 32 || byte == 127) printf "\\x%02X", byte
        else printf "%c", byte
      }
    }'
  printf '"'
}

DOCS_JS=$(js_string "$DOCS_BASE_URL")
AUTH_CONFIG=""
if [ "${SCOPE_AUTH_CLIENT_ID+x}" ]; then
  AUTH_CONFIG="${AUTH_CONFIG}, authClientId: $(js_string "$SCOPE_AUTH_CLIENT_ID")"
fi
if [ "${SCOPE_AUTH_AUTHORITY+x}" ]; then
  AUTH_CONFIG="${AUTH_CONFIG}, authAuthority: $(js_string "$SCOPE_AUTH_AUTHORITY")"
fi
if [ "${SCOPE_AUTH_SCOPES+x}" ]; then
  AUTH_CONFIG="${AUTH_CONFIG}, authScopes: $(js_string "$SCOPE_AUTH_SCOPES")"
fi

cat > "$CONFIG_PATH" <<EOF
window.__SCOPE_CONFIG__ = Object.assign(
  { docsBaseUrl: ${DOCS_JS}, authEnabled: ${AUTH_ENABLED}${AUTH_CONFIG} },
  window.__SCOPE_CONFIG__
);
EOF

echo "portal: wrote ${CONFIG_PATH} (docsBaseUrl=${DOCS_BASE_URL}, authEnabled=${AUTH_ENABLED})"
