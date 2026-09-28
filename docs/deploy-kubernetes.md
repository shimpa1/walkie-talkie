# Run firstmate + walkie-talkie on Kubernetes

This guide installs firstmate and its walkie-talkie phone companion into a
Kubernetes cluster with the Helm chart in
[`deploy/helm/firstmate`](../deploy/helm/firstmate).

The deployment **adds** a Kubernetes path; it does not replace firstmate's
normal host-based use. The firstmate container runs on its **herdr** session
backend, so firstmate behaves as it does on a workstation and its session stays
attachable:

```sh
kubectl -n <namespace> exec -it <statefulset-name>-0 -c firstmate -- \
  herdr session attach <herdr-session>
```

For a release named `firstmate` the StatefulSet and pod are `firstmate` and
`firstmate-0`.

Nothing is exposed publicly except the Gateway: walkie-talkie listens on a
ClusterIP Service, and an HTTPRoute on your existing Gateway routes the
configured host to it. TLS terminates at the Gateway.

The chart is generic. Images, storage class, storage size, resources, hostname,
the Gateway parentRef, TLS, credentials, and the firstmate home path are all
values; nothing about any particular cluster is hardcoded. The atus cluster
gets a worked example below.

The non-Kubernetes alternative (Dockerfile + Compose) is a sibling deploy path
and is not duplicated here; use this chart when you want Kubernetes, and that
path when you want a single VM.

## What the chart creates

| Resource | Purpose |
| --- | --- |
| `StatefulSet` (1 replica) | Stable identity, one supervisor, no autoscaling. Runs the two containers below. |
| `volumeClaimTemplate` `home` | The firstmate home, on the configured StorageClass. |
| `Service` (ClusterIP) + headless `Service` | The walkie-talkie port, and StatefulSet identity. |
| `HTTPRoute` (`gateway.networking.k8s.io/v1`) | Routes the configured host to the Service through your Gateway. |
| `Certificate` (optional) | cert-manager Certificate for clusters that terminate TLS in-namespace. |
| `Secret` (optional) | Credentials, when you do not point at an existing Secret. |
| `ConfigMap` | Non-secret configuration (paths, backend, session, bind, port). |
| `ServiceAccount` | Pod identity; no API permissions are granted. |

The two containers share the home volume:

- **firstmate** — the runtime, on the `herdr` backend, running the herdr
  headless server for a named session.
- **walkie-talkie** — the PWA + API on the configured port, invoking firstmate
  only through its own `bin/` scripts.

## Prerequisites

Provisioning these is **out of scope** for this chart; the cluster must already
have them:

- **Kubernetes** 1.27 or newer and **Helm** 3.
- **Gateway API** CRDs plus a **Gateway** you can attach to, with a listener for
  your host (an internet-facing NGINX Gateway, for example). The chart creates
  an HTTPRoute; it never installs the Gateway API, a Gateway controller, or a
  Gateway.
- A **StorageClass** for the firstmate home. The chart default is `beta3`.
- A **DNS host** whose A/AAAA record points at your Gateway, and a TLS
  certificate on the Gateway for that host (or cert-manager in-namespace, see
  [TLS](#tls)).
- A **container registry** the cluster can pull from, and two images:
  - the **firstmate runtime** — build it from
    [`deploy/kubernetes/firstmate/Dockerfile`](../deploy/kubernetes/firstmate/Dockerfile)
    (or supply your own image meeting the same contract);
  - the **walkie-talkie service** — built from the repository-root `Dockerfile`
    provided by the sibling Docker/Compose deploy slice (a prerequisite: merge
    that slice first).
- **Credentials**: a walkie-talkie bearer token, a GitHub token, and any
  harness/model credentials your primary agent needs.

## Build and push the images

firstmate runtime (this repo):

```sh
docker build -t registry.example.com/firstmate-runtime:0.1.0 deploy/kubernetes/firstmate
docker push registry.example.com/firstmate-runtime:0.1.0
```

The build installs firstmate from `FIRSTMATE_REPO`/`FIRSTMATE_REF` (defaults to
the public firstmate repo at `main`), then uses firstmate's own pinned
installers for herdr and treehouse. The primary harness is installed from
`HARNESS_PACKAGES` (default `@anthropic-ai/claude-code`). Override build args
for a different harness or a pinned firstmate ref:

```sh
docker build \
  --build-arg FIRSTMATE_REF=v1.2.3 \
  --build-arg HARNESS_PACKAGES="@openai/codex" \
  -t registry.example.com/firstmate-runtime:0.1.0 deploy/kubernetes/firstmate
```

walkie-talkie: build it from the repository-root `Dockerfile` provided by the
sibling Docker/Compose deploy slice (a prerequisite) and push it to your
registry as well.

Then set `firstmate.image.repository`/`tag` and
`walkieTalkie.image.repository`/`tag` to your pushed images.

## Credentials

Every credential reaches a container through a Secret with `secretKeyRef`; none
is inlined into the pod spec. There are two modes.

**Existing Secret (recommended for GitOps).** Create the Secret yourself and
point the chart at it:

```sh
kubectl -n <namespace> create secret generic firstmate-credentials \
  --from-literal=walkie-talkie-token="$(openssl rand -hex 32)" \
  --from-literal=github-token="github_pat_xxx" \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-xxx"
```

```yaml
credentials:
  existingSecret: firstmate-credentials
  keys:
    walkieTalkieToken: walkie-talkie-token
    githubToken: github-token
    harness:
      ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
```

With `credentials.existingSecret` set the chart creates no Secret. If your
Secret has no GitHub key, set `credentials.githubTokenEnabled: false`.

**Chart-created Secret.** Leave `existingSecret` empty and pass the values:

```sh
helm upgrade --install firstmate deploy/helm/firstmate -n <namespace> \
  --set credentials.create.walkieTalkieToken="$(openssl rand -hex 32)" \
  --set credentials.create.githubToken="github_pat_xxx" \
  --set credentials.create.harness.ANTHROPIC_API_KEY="sk-ant-xxx"
```

If you omit the walkie-talkie token, the chart generates one and prints it in
the release notes (and preserves it across upgrades). Set it explicitly for a
token you control. Do not commit real tokens to a values file.

## Install

```sh
helm upgrade --install firstmate deploy/helm/firstmate \
  --namespace firstmate --create-namespace \
  -f deploy/helm/firstmate/examples/values-atus.yaml \
  --set credentials.create.walkieTalkieToken="$(openssl rand -hex 32)"
```

Watch it come up and confirm readiness:

```sh
kubectl -n firstmate get statefulset,pod -w
kubectl -n firstmate get httproute firstmate
```

The walkie-talkie pod is ready once `/api/health` reports firstmate ready.

## Attach to firstmate

The firstmate container runs a headless herdr server for the configured named
session. Attach to it:

```sh
kubectl -n firstmate exec -it firstmate-0 -c firstmate -- \
  herdr session attach firstmate
```

This is the same herdr workflow as on a workstation; firstmate's supervisor runs
in that session. The pod stays up on the herdr server, so attaching never races
a short-lived process.

## Values

| Value | Default | What it does |
| --- | --- | --- |
| `firstmate.image.repository` / `.tag` | `firstmate-runtime` / chart version | Runtime image. |
| `firstmate.home` | `/home/firstmate` | Absolute container path of the firstmate home; also the volume mount and `FM_HOME`. |
| `firstmate.backend` | `herdr` | Runtime backend (`FM_BACKEND`). |
| `firstmate.herdrSession` | `firstmate` | Named herdr session (`HERDR_SESSION`). |
| `walkieTalkie.image.repository` / `.tag` | `walkie-talkie` / chart version | Companion image. |
| `walkieTalkie.port` | `8787` | Walkie-talkie port inside the container. |
| `persistence.storageClass` | `beta3` | StorageClass for the home claim. |
| `persistence.size` | `20Gi` | Home claim size. |
| `persistence.existingClaim` | `""` | Use a pre-created PVC instead of a claim template. |
| `service.port` | `8787` | Service port routed by the HTTPRoute. |
| `httpRoute.parentRefs` | `gateway` in `nginx-gateway` | Gateway parentRef(s): name, namespace, optional `sectionName` listener. |
| `httpRoute.hostnames` | `firstmate.example.com` | Host(s) routed to walkie-talkie. |
| `httpRoute.redirect.enabled` | `false` | Add an HTTP → HTTPS redirect route. |
| `certificate.enabled` | `false` | Create a cert-manager Certificate in-namespace. |
| `credentials.*` | — | Secret reference or values (see above). |
| `firstmate.resources` / `walkieTalkie.resources` | small requests | Per-container resources. |
| `networkPolicy.enabled` | `false` | Restrict ingress to the Gateway namespace. |
| `nodeSelector` / `tolerations` / `affinity` / `priorityClassName` | empty | Scheduling. |
| `firstmate.podSecurityContext` / `firstmate.securityContext` / `walkieTalkie.securityContext` | non-root, uid/gid 1000, fsGroup 1000 | Change to match your Pod Security Admission and volume ownership. |

Add harness/model configuration through `firstmate.extraEnv` or
`firstmate.extraEnvFrom`, and more credentials through
`credentials.create.harness` / `credentials.keys.harness`.

### TLS

TLS terminates at the Gateway for the normal case: pin `httpRoute.parentRefs[].sectionName`
to the HTTPS listener that already carries a certificate for your host, and
leave `certificate.enabled: false`. The chart never creates a Gateway or its
TLS secret.

For clusters that terminate TLS in this namespace instead, enable the optional
cert-manager Certificate:

```yaml
certificate:
  enabled: true
  secretName: firstmate-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - firstmate.example.com
```

This requires cert-manager and an issuer to exist; installing either is out of
scope.

### Storage notes

The home defaults to a `ReadWriteOnce` claim from `volumeClaimTemplates`, so it
survives pod restarts and rescheduling within one replica. With a
`volumeBindingMode: WaitForFirstConsumer` StorageClass, the pod schedules before
the volume binds; with the immediate-binding `beta3` class the volume binds at
claim time. To bring an existing firstmate home with you, create its PVC and set
`persistence.enabled: false` with `persistence.existingClaim`.

## Example: the atus cluster

The atus cluster is internet-facing behind an NGINX Gateway API. The worked
example is
[`deploy/helm/firstmate/examples/values-atus.yaml`](../deploy/helm/firstmate/examples/values-atus.yaml):

- Gateway `gateway` in namespace `nginx-gateway`, HTTPS listener
  `https-atus-wildcard` (hostname `*.atus.hr`), HTTP listener `http`.
- Host `reach.atus.hr`, with an HTTP → HTTPS redirect.
- StorageClass `beta3` (Rook-Ceph), 20Gi.
- TLS terminates at the Gateway using the existing wildcard certificate, so no
  in-namespace Certificate.

```sh
helm upgrade --install firstmate deploy/helm/firstmate \
  --namespace firstmate --create-namespace \
  -f deploy/helm/firstmate/examples/values-atus.yaml \
  --set credentials.create.walkieTalkieToken="$(openssl rand -hex 32)" \
  --set credentials.create.githubToken=github_pat_xxx \
  --set credentials.create.harness.ANTHROPIC_API_KEY=sk-ant-xxx
```

That example is a starting point; adjust the host, the listener `sectionName`,
the images, and the credentials for your cluster.

## Upgrade

```sh
helm upgrade firstmate deploy/helm/firstmate -n firstmate -f my-values.yaml
```

Changing the image tag rolls the StatefulSet. The home PVC is retained across
upgrades. Changing an explicitly-set chart-created credential updates the
Secret and restarts the pod; a chart-generated walkie-talkie token is preserved
across upgrades.

## Uninstall

```sh
helm uninstall firstmate -n firstmate
```

`helm uninstall` does **not** delete the `home` PVC created from the claim
template, so firstmate's state survives. Delete it explicitly when you are done:

```sh
kubectl -n firstmate delete pvc home-firstmate-0
```

## Verification

What can be checked without a cluster was checked while building this chart:

```sh
helm lint deploy/helm/firstmate
helm template firstmate deploy/helm/firstmate --namespace firstmate
helm template firstmate deploy/helm/firstmate -n firstmate \
  -f deploy/helm/firstmate/examples/values-atus.yaml
```

Rendered output is then validated with
[kubeconform](https://github.com/yannh/kubeconform). The core resources validate
against the upstream schemas, and the Gateway API and cert-manager resources
validate against the [datree CRDs catalog](https://github.com/datreeio/CRDs-catalog):

```sh
helm template firstmate deploy/helm/firstmate -n firstmate | \
  kubeconform -strict -ignore-missing-schemas \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
```

`kubectl apply --dry-run=client` is a useful additional check, but client-side
validation downloads OpenAPI from a live API server, so it only works from a
kube context that can reach the cluster with the Gateway API and cert-manager
CRDs installed.

The firstmate runtime image builds and its entrypoint seeds the home correctly
(the seeding path and tool set were exercised in the image). Starting the herdr
server itself is a cluster/runtime concern and is not driven here.

**What is not verified here.** Steps that require a real cluster — actual PVC
binding, Gateway attachment and certificate issuance, image pulls, secret
contents, and firstmate's own data/logins — cannot be exercised outside the
cluster and are stated as expectations, not asserted facts. Bootstrapping
firstmate's data and logins (GitHub auth, harness login, projects) is out of
scope: after install, attach and complete it as you would on any firstmate
host.

## Troubleshooting

- **Pod not ready.** Readiness asks firstmate whether it is ready. Until the
  home is seeded and firstmate's toolchain is satisfied, readiness stays false;
  check `kubectl -n <ns> logs <statefulset-name>-0 -c walkie-talkie` and
  `... -c firstmate`.
- **Attach shows no session.** Confirm the firstmate container is running and
  logs include `starting herdr server for session '<name>'`; the session name
  is `firstmate.herdrSession`.
- **Route not serving.** Check the HTTPRoute status and that its `parentRefs`
  name and namespace match your Gateway and `sectionName` matches a listener
  whose hostname covers `httpRoute.hostnames`.
- **Volume permission errors.** Align `firstmate.podSecurityContext.fsGroup`
  and the container `runAsUser`/`runAsGroup` with the volume; uid/gid 1000
  matches both images' defaults.
