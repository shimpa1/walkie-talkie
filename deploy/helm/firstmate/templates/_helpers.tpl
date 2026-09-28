{{/*
Expand the name of the chart.
*/}}
{{- define "firstmate.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "firstmate.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart label value.
*/}}
{{- define "firstmate.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "firstmate.labels" -}}
helm.sh/chart: {{ include "firstmate.chart" . }}
{{ include "firstmate.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels: stable across upgrades.
*/}}
{{- define "firstmate.selectorLabels" -}}
app.kubernetes.io/name: {{ include "firstmate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
ServiceAccount name.
*/}}
{{- define "firstmate.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "firstmate.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Name of the Secret holding the credentials, whether created or existing.
*/}}
{{- define "firstmate.secretName" -}}
{{- if .Values.credentials.existingSecret -}}
{{- .Values.credentials.existingSecret -}}
{{- else -}}
{{- printf "%s-credentials" (include "firstmate.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
firstmate image reference.
*/}}
{{- define "firstmate.image" -}}
{{- $tag := default .Chart.AppVersion .Values.firstmate.image.tag -}}
{{- printf "%s:%s" .Values.firstmate.image.repository $tag -}}
{{- end -}}

{{/*
walkie-talkie image reference.
*/}}
{{- define "firstmate.walkieTalkie.image" -}}
{{- $tag := default .Chart.AppVersion .Values.walkieTalkie.image.tag -}}
{{- printf "%s:%s" .Values.walkieTalkie.image.repository $tag -}}
{{- end -}}

{{/*
Name of the headless Service governing the StatefulSet.
*/}}
{{- define "firstmate.headlessServiceName" -}}
{{- printf "%s-headless" (include "firstmate.fullname" .) -}}
{{- end -}}
