{{- define "hikari.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hikari.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "hikari.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "hikari.labels" -}}
app.kubernetes.io/name: {{ include "hikari.name" . }}
app.kubernetes.io/component: log-explorer
app.kubernetes.io/part-of: hikari
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "hikari.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hikari.name" . }}
app.kubernetes.io/component: log-explorer
{{- end -}}
