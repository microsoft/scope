#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
#
# Reads the outputs of an already-provisioned `deploy/azure/` Bicep
# deployment and generates a Helm values file from them. Closes the gap
# between Bicep's outputs and a hand-authored values.yaml, which is where
# transcription mistakes (wrong Redis port, stale Key Vault name, etc.) have
# historically crept in. Does not touch Helm at all — once this writes your
# values file, install the chart yourself (see deploy/helm/scope/README.md).
#
# Usage:
#   scripts/generate-values-from-bicep.sh --resource-group <name> [options]
#
# Options:
#   --resource-group <name>  Resource group the Bicep template deployed into
#                            (required).
#   --deployment-name <name> Deployment within that resource group to read
#                            outputs from. Optional: if omitted, the most
#                            recent deployment whose outputs match this
#                            template (keyVaultName, redisHostName,
#                            workloadIdentityClientId all present) is used.
#                            This combination excludes nested module
#                            deployments (e.g. a `keyvault` module), which
#                            can re-expose a subset of the same output names.
#                            Pass this explicitly to pick a different one.
#   --values-file <path>     Where to write the generated values file
#                            (default: my-values.yaml). If this file already
#                            exists, the script refuses to overwrite it
#                            unless --force is also given.
#   --image-registry <reg>   Baked into the generated file as
#                            global.imageRegistry (e.g. your own fork's GHCR
#                            namespace, or the Bicep-provisioned ACR). Omit
#                            to use the chart's ghcr.io/microsoft default.
#   --force                  Overwrite --values-file if it already exists.
#   -h, --help                Show this help.
#
# If the deployment also has worker-identity outputs
# (workerWorkloadIdentityClientId/workerWorkloadIdentityServiceAccountName —
# only present if you provisioned the ACP worker identity), those are
# written too. Missing is not an error: older deployments, or ones that
# never provisioned worker identity, just won't get the worker.* keys, and
# the chart falls back to its defaults (empty client ID, required only once
# you enable a worker — see WORKERS.md).
#
# Requires: az (logged in, correct subscription active), jq.
set -euo pipefail

RESOURCE_GROUP=""
DEPLOYMENT_NAME=""
VALUES_FILE="my-values.yaml"
IMAGE_REGISTRY=""
FORCE=false

usage() {
  sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group) RESOURCE_GROUP="$2"; shift 2 ;;
    --deployment-name) DEPLOYMENT_NAME="$2"; shift 2 ;;
    --values-file) VALUES_FILE="$2"; shift 2 ;;
    --image-registry) IMAGE_REGISTRY="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

for bin in az jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin not found on PATH" >&2; exit 1; }
done

[[ -n "$RESOURCE_GROUP" ]] || { echo "ERROR: --resource-group is required" >&2; usage; exit 1; }

if [[ -f "$VALUES_FILE" && "$FORCE" != true ]]; then
  echo "ERROR: $VALUES_FILE already exists. Pass --force to overwrite it or --values-file <other path> to write elsewhere." >&2
  exit 1
fi

if [[ -z "$DEPLOYMENT_NAME" ]]; then
  echo "==> --deployment-name not given; finding the most recent matching deployment in $RESOURCE_GROUP"
  DEPLOYMENT_NAME="$(
    az deployment group list --resource-group "$RESOURCE_GROUP" -o json \
      | jq -r '
          [.[] | select(
              .properties.outputs.keyVaultName != null
              and .properties.outputs.redisHostName != null
              and .properties.outputs.workloadIdentityClientId != null
            )]
          | sort_by(.properties.timestamp)
          | reverse
          | .[0].name // empty
        '
  )"
  [[ -n "$DEPLOYMENT_NAME" ]] || {
    echo "ERROR: no deployment in '$RESOURCE_GROUP' has this template's outputs. Pass --deployment-name explicitly." >&2
    exit 1
  }
  echo "    Using deployment: $DEPLOYMENT_NAME"
fi

echo "==> Reading Bicep outputs from $RESOURCE_GROUP/$DEPLOYMENT_NAME"
OUTPUTS_JSON="$(az deployment group show -g "$RESOURCE_GROUP" -n "$DEPLOYMENT_NAME" --query properties.outputs -o json)"

get_output() {
  jq -r --arg k "$1" '.[$k].value // empty' <<<"$OUTPUTS_JSON"
}

TENANT_ID="$(az account show --query tenantId -o tsv)"
KEY_VAULT_NAME="$(get_output keyVaultName)"
KEY_VAULT_URI="$(get_output keyVaultUri)"
WORKLOAD_IDENTITY_CLIENT_ID="$(get_output workloadIdentityClientId)"
SERVICE_ACCOUNT_NAME="$(get_output workloadIdentityServiceAccountName)"
STORAGE_ACCOUNT_NAME="$(get_output storageAccountName)"
REDIS_HOST_NAME="$(get_output redisHostName)"
REDIS_PORT="$(get_output redisPort)"
# Optional: only present if the Bicep deployment provisioned the ACP worker
# identity. Not required below — see WORKERS.md.
WORKER_WORKLOAD_IDENTITY_CLIENT_ID="$(get_output workerWorkloadIdentityClientId)"
WORKER_SERVICE_ACCOUNT_NAME="$(get_output workerWorkloadIdentityServiceAccountName)"

for pair in \
  "tenantId:$TENANT_ID" \
  "keyVaultName:$KEY_VAULT_NAME" \
  "keyVaultUri:$KEY_VAULT_URI" \
  "workloadIdentityClientId:$WORKLOAD_IDENTITY_CLIENT_ID" \
  "workloadIdentityServiceAccountName:$SERVICE_ACCOUNT_NAME" \
  "storageAccountName:$STORAGE_ACCOUNT_NAME" \
  "redisHostName:$REDIS_HOST_NAME" \
  "redisPort:$REDIS_PORT"
do
  key="${pair%%:*}"
  val="${pair#*:}"
  if [[ -z "$val" ]]; then
    echo "ERROR: value for '$key' was empty. Check --resource-group/--deployment-name point at the right Bicep deployment." >&2
    exit 1
  fi
done

if [[ -z "$WORKER_WORKLOAD_IDENTITY_CLIENT_ID" || -z "$WORKER_SERVICE_ACCOUNT_NAME" ]]; then
  echo "    Note: worker-identity outputs not found on this deployment — skipping worker.* values. Bring the ACP workers online only after re-provisioning with that identity (see WORKERS.md)."
fi

echo "==> Writing $VALUES_FILE"
{
  if [[ -n "$IMAGE_REGISTRY" ]]; then
    cat <<EOF
global:
  imageRegistry: $IMAGE_REGISTRY

EOF
  fi
  cat <<EOF
azure:
  tenantId: $TENANT_ID
  keyVaultName: $KEY_VAULT_NAME
  keyVaultUri: $KEY_VAULT_URI
  workloadIdentityClientId: $WORKLOAD_IDENTITY_CLIENT_ID
  serviceAccountName: $SERVICE_ACCOUNT_NAME
  storageAccountName: $STORAGE_ACCOUNT_NAME
  redisHostName: $REDIS_HOST_NAME
  redisPort: $REDIS_PORT
EOF
  if [[ -n "$WORKER_WORKLOAD_IDENTITY_CLIENT_ID" && -n "$WORKER_SERVICE_ACCOUNT_NAME" ]]; then
    cat <<EOF
  workerWorkloadIdentityClientId: $WORKER_WORKLOAD_IDENTITY_CLIENT_ID
  workerServiceAccountName: $WORKER_SERVICE_ACCOUNT_NAME
EOF
  fi
} > "$VALUES_FILE"

echo "    Done. Review/edit $VALUES_FILE (e.g. to add ingress hosts), then install"
echo "    the chart — see deploy/helm/scope/README.md."
