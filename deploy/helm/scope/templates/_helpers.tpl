{{/*
Chart base name.
*/}}
{{- define "scope.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{/*
Fully qualified app name, used as a prefix for resource names.
*/}}
{{- define "scope.fullname" -}}
{{- .Release.Name -}}
{{- end -}}

{{/*
Common labels applied to every resource.
*/}}
{{- define "scope.labels" -}}
app.kubernetes.io/name: {{ include "scope.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{/*
Selector labels for a given service (pass `component` in the calling scope's
dict, e.g. (dict "component" "api" "context" $)).
*/}}
{{- define "scope.selectorLabels" -}}
app.kubernetes.io/name: {{ include "scope.name" .context }}
app.kubernetes.io/instance: {{ .context.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Resource name for a given service component, e.g. "scope-api".
*/}}
{{- define "scope.componentName" -}}
{{- printf "%s-%s" (include "scope.fullname" .context) .component -}}
{{- end -}}

{{/*
Fully qualified image reference, combining a registry with a service's
image.repository/tag. Per-image `.image.registry` (used by the workers and
the db-migrate job, which live on the Bicep-provisioned ACR rather than
GHCR) wins; otherwise falls back to `global.imageRegistry` (the default
distribution point for the core app services, conventionally
ghcr.io/<owner>/scope). Falls back to `global.imageTag` when `.image.tag`
is unset, and to a bare (unregistered) name when no registry applies at all.
*/}}
{{- define "scope.image" -}}
{{- $tag := .image.tag | default .context.Values.global.imageTag -}}
{{- $registry := .image.registry | default .context.Values.global.imageRegistry -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry .image.repository $tag -}}
{{- else -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end -}}
{{- end -}}

{{/*
Name of the shared workload-identity ServiceAccount. Must match the Bicep
template's federated subject.
*/}}
{{- define "scope.serviceAccountName" -}}
{{- .Values.azure.serviceAccountName -}}
{{- end -}}
