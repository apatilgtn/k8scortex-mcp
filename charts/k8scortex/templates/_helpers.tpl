{{- define "k8scortex.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "k8scortex.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{ include "k8scortex.selectorLabels" . }}
{{- end -}}

{{- define "k8scortex.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "k8scortex.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "k8scortex.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "k8scortex.clustersConfigMap" -}}
{{- default (printf "%s-clusters" (include "k8scortex.fullname" .)) .Values.clusters.existingConfigMap -}}
{{- end -}}

{{- define "k8scortex.hasClusters" -}}
{{- if or .Values.clusters.existingConfigMap .Values.clusters.config }}true{{ end -}}
{{- end -}}

{{- define "k8scortex.validate" -}}
{{- $a := .Values.auth -}}
{{- if and (not $a.disabled) (not $a.oidc.issuer) (not $a.entra.tenantId) -}}
{{- fail "Set auth.oidc.issuer and auth.oidc.audience (or auth.entra.tenantId and auth.entra.clientId). Use auth.disabled=true only for local experiments." -}}
{{- end -}}
{{- if and $a.oidc.issuer (not $a.oidc.audience) -}}
{{- fail "auth.oidc.audience is required when auth.oidc.issuer is set" -}}
{{- end -}}
{{- if and $a.entra.tenantId (not $a.entra.clientId) -}}
{{- fail "auth.entra.clientId is required when auth.entra.tenantId is set" -}}
{{- end -}}
{{- end -}}
