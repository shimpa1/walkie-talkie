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
Name of the ConfigMap carrying the declarative agent configuration that is
mounted into the firstmate home (harness provider catalog and dispatch rules).
*/}}
{{- define "firstmate.agentsConfigMapName" -}}
{{- printf "%s-agents" (include "firstmate.fullname" .) -}}
{{- end -}}

{{/*
Name of the headless Service governing the StatefulSet.
*/}}
{{- define "firstmate.headlessServiceName" -}}
{{- printf "%s-headless" (include "firstmate.fullname" . | trunc 54 | trimSuffix "-") | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Checksum source for the created-Secret pod-template annotation. Hashes only the
explicit credentials, never lookup-preserved or auto-generated values.
*/}}
{{- define "firstmate.secretChecksum" -}}
{{- $creds := dict -}}
{{- $_ := set $creds "walkieTalkieToken" .Values.credentials.create.walkieTalkieToken -}}
{{- $_ := set $creds "githubToken" .Values.credentials.create.githubToken -}}
{{- range $k, $v := .Values.credentials.create.harness -}}
{{- $_ := set $creds (printf "harness.%s" $k) $v -}}
{{- end -}}
{{- $creds | toJson -}}
{{- end -}}

{{/*
Namespace of the Gateway API Gateway that fronts the release: the explicit
networkPolicy.gatewayNamespace, else the first httpRoute parentRef namespace.
Empty when neither is set.
*/}}
{{- define "firstmate.gatewayApiNamespace" -}}
{{- $ns := .Values.networkPolicy.gatewayNamespace -}}
{{- if and (not $ns) .Values.httpRoute.parentRefs -}}
{{- $ns = (index .Values.httpRoute.parentRefs 0).namespace -}}
{{- end -}}
{{- $ns -}}
{{- end -}}

{{/*
Multi-user gateway resource name prefix.
*/}}
{{- define "firstmate.gateway.fullname" -}}
{{- printf "%s-gateway" (include "firstmate.fullname" . | trunc 46 | trimSuffix "-") -}}
{{- end -}}

{{/*
Gateway selector labels. The name label differs from the firstmate pod's, so
the firstmate Service, StatefulSet and network policy never select a gateway
pod. The component label is what the firstmate pod's policy admits.
*/}}
{{- define "firstmate.gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-gateway" (include "firstmate.name" . | trunc 55 | trimSuffix "-") }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: gateway
{{- end -}}

{{/*
Gateway common labels.
*/}}
{{- define "firstmate.gateway.labels" -}}
helm.sh/chart: {{ include "firstmate.chart" . }}
{{ include "firstmate.gateway.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Gateway image reference: gateway.image, falling back field by field to the
walkie-talkie image.
*/}}
{{- define "firstmate.gateway.image" -}}
{{- $repo := default .Values.walkieTalkie.image.repository .Values.gateway.image.repository -}}
{{- $tag := default (default .Chart.AppVersion .Values.walkieTalkie.image.tag) .Values.gateway.image.tag -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}

{{/*
The public origin the gateway serves: gateway.publicOrigin, else https:// plus
the first httpRoute hostname.
*/}}
{{- define "firstmate.gateway.publicOrigin" -}}
{{- if .Values.gateway.publicOrigin -}}
{{- .Values.gateway.publicOrigin | trimSuffix "/" -}}
{{- else if .Values.httpRoute.hostnames -}}
{{- printf "https://%s" (index .Values.httpRoute.hostnames 0) -}}
{{- end -}}
{{- end -}}

{{/*
Refuse an inline secret anywhere under gateway, whether or not the gateway is
enabled: the schema already rejects unknown keys, and this keeps the refusal
when schema validation is skipped. Secret values reach the gateway only as
secretKeyRef references.
*/}}
{{- define "firstmate.gateway.refuseInlineSecrets" -}}
{{- $gw := .Values.gateway -}}
{{- range $k := list "githubClientSecret" "clientSecret" "vaultKeys" "tenantTokenSecret" "token" "legacyToken" -}}
{{- if hasKey $gw $k -}}
{{- fail (printf "gateway.%s: inline secret values are refused; reference an existing Secret under gateway.secrets (or a tokenSecretRef) instead" $k) -}}
{{- end -}}
{{- end -}}
{{- if not (kindIs "map" $gw.secrets) -}}
{{- fail "gateway.secrets must be a map with existingSecret and keys; inline secret values are refused" -}}
{{- end -}}
{{- range $k := list "githubClientSecret" "clientSecret" "vaultKeys" "tenantTokenSecret" "value" -}}
{{- if hasKey $gw.secrets $k -}}
{{- fail (printf "gateway.secrets.%s: inline secret values are refused; name the Secret in gateway.secrets.existingSecret and its key in gateway.secrets.keys" $k) -}}
{{- end -}}
{{- end -}}
{{- if hasKey $gw.legacyBearer "token" -}}
{{- fail "gateway.legacyBearer.token: inline secret values are refused; use gateway.legacyBearer.tokenSecretRef" -}}
{{- end -}}
{{- range $t := (default (list) $gw.staticTenants) -}}
{{- if and (kindIs "map" $t) (hasKey $t "token") -}}
{{- fail "gateway.staticTenants[].token: inline secret values are refused; use tokenSecretRef {name, key}" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The tenant-params ConfigMap the gateway mounts: <release>-tenant-params.
*/}}
{{- define "firstmate.tenantParamsName" -}}
{{- printf "%s-tenant-params" (include "firstmate.fullname" . | trunc 49 | trimSuffix "-") -}}
{{- end -}}

{{/*
Per-user firstmates (tenants.*): whether they render, failing the render on
a combination that would provision them without their isolation.
*/}}
{{- define "firstmate.tenants.enabled" -}}
{{- if .Values.tenants.enabled -}}
{{- if not .Values.gateway.enabled -}}
{{- fail "tenants.enabled requires gateway.enabled: the gateway provisions and fronts every per-user firstmate" -}}
{{- end -}}
{{- if not .Values.gateway.networkPolicy.enabled -}}
{{- fail "tenants.enabled requires gateway.networkPolicy.enabled: the gateway's internal credential port must admit only the tenant namespace" -}}
{{- end -}}
true
{{- end -}}
{{- end -}}

{{/*
A tenant image reference: the tenants.image.<which> fields, falling back field
by field to `fallbackRepo`/`fallbackTag`. `latest` and an empty tag are
refused: a tenant runs an immutable image.
*/}}
{{- define "firstmate.tenants.image" -}}
{{- $repo := default .fallbackRepo .image.repository -}}
{{- $tag := default .fallbackTag .image.tag -}}
{{- if or (not $repo) (not $tag) (eq (toString $tag) "latest") -}}
{{- fail (printf "tenants.image.%s needs a repository and an immutable tag (not latest)" .which) -}}
{{- end -}}
{{- printf "%s:%s" $repo (toString $tag) -}}
{{- end -}}

{{/*
A CPU quantity in millicores ("250m", "1", "0.5"), for the namespace quota.
*/}}
{{- define "firstmate.tenants.milliCPU" -}}
{{- $q := toString .q -}}
{{- if regexMatch "^[0-9]+m$" $q -}}
{{- trimSuffix "m" $q | atoi -}}
{{- else if regexMatch "^[0-9]+$" $q -}}
{{- mul (atoi $q) 1000 -}}
{{- else if regexMatch "^[0-9]+\\.[0-9]{1,3}$" $q -}}
{{- $parts := splitList "." $q -}}
{{- add (mul (atoi (index $parts 0)) 1000) (atoi (printf "%-3s" (index $parts 1) | replace " " "0")) -}}
{{- else -}}
{{- fail (printf "%s: CPU %q must be millicores (250m) or cores (1, 0.5)" .what $q) -}}
{{- end -}}
{{- end -}}

{{/*
A memory or storage quantity in MiB ("512Mi", "2Gi"), for the namespace quota.
*/}}
{{- define "firstmate.tenants.mebibytes" -}}
{{- $q := toString .q -}}
{{- if regexMatch "^[0-9]+Mi$" $q -}}
{{- trimSuffix "Mi" $q | atoi -}}
{{- else if regexMatch "^[0-9]+Gi$" $q -}}
{{- mul (trimSuffix "Gi" $q | atoi) 1024 -}}
{{- else if regexMatch "^[0-9]+Ti$" $q -}}
{{- mul (trimSuffix "Ti" $q | atoi) 1048576 -}}
{{- else -}}
{{- fail (printf "%s: %q must be in Mi, Gi or Ti" .what $q) -}}
{{- end -}}
{{- end -}}

{{/*
One tenant pod's quota footprint as a dict of integers: cpu (millicores) and
requests/limits memory (MiB). A pod counts the larger of its app containers'
sum and its init container.
*/}}
{{- define "firstmate.tenants.podFootprint" -}}
{{- $r := .Values.tenants.resources -}}
{{- $out := dict -}}
{{- range $field := list "requests.cpu" "requests.memory" "limits.memory" -}}
{{- $parts := splitList "." $field -}}
{{- $section := index $parts 0 -}}
{{- $res := index $parts 1 -}}
{{- $sum := 0 -}}
{{- $init := 0 -}}
{{- range $c := list "firstmate" "walkieTalkie" "init" -}}
{{- $what := printf "tenants.resources.%s.%s.%s" $c $section $res -}}
{{- $q := index (default (dict) (index (index $r $c) $section)) $res -}}
{{- if not $q -}}
{{- fail (printf "%s is required: the tenant namespace quota is computed from it" $what) -}}
{{- end -}}
{{- $n := 0 -}}
{{- if eq $res "cpu" -}}
{{- $n = include "firstmate.tenants.milliCPU" (dict "q" $q "what" $what) | atoi -}}
{{- else -}}
{{- $n = include "firstmate.tenants.mebibytes" (dict "q" $q "what" $what) | atoi -}}
{{- end -}}
{{- if eq $c "init" -}}
{{- $init = $n -}}
{{- else -}}
{{- $sum = add $sum $n -}}
{{- end -}}
{{- end -}}
{{- $_ := set $out $field (max $sum $init) -}}
{{- end -}}
{{- $out | toJson -}}
{{- end -}}
