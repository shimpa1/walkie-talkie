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
| `ConfigMap` | Non-secret configuration (paths, session, bind, port). |
| `ConfigMap` (optional) | Agent configuration (`agents.enabled`): the opencode provider/model catalog and firstmate's dispatch profiles. |
| `ServiceAccount` | Pod identity; no API permissions are granted. |
| Gateway objects (optional) | `gateway.enabled`: the multi-user gateway's Deployment, store PVC, two Services, ServiceAccount, network policies and the tenant-params ConfigMap with the provider catalog (see [Multi-user gateway](#multi-user-gateway)). |
| Tenant namespace objects (optional) | `tenants.enabled`: the per-user firstmates' namespace with its quota, limit range, network policies and the gateway's Role there (see [Per-user firstmates](#per-user-firstmates)). |

The two containers share the home volume:

- **firstmate** — the runtime, on the `herdr` backend, running the herdr
  headless server for a named session and starting firstmate's primary harness
  inside it, so the pod runs a live firstmate that drains queued instructions.
  A supervisor starts the harness again in the same pane when it exits.
- **walkie-talkie** — the PWA + API on the configured port, invoking firstmate
  only through its own `bin/` scripts.

The **Conversations** live-session list reads this pod's own herdr session
through the read-only `herdr pane list` / `herdr pane read` commands, so the
walkie-talkie container needs the `herdr` CLI and the session's socket
reachable. Since the repository-root `walkie-talkie` image does not bundle herdr,
set `walkieTalkie.herdrCLI.enabled: true`: the chart then runs an init container
from `firstmate.image` (which provides the pinned herdr build) that copies the
binary into a shared volume, mounts it into the walkie-talkie container, and
sets `FM_WT_HERDR_BIN` and `XDG_CONFIG_HOME` so the CLI finds the session socket
under the mounted home rather than the container's own HOME. (Alternatively,
point `walkieTalkie.image` at an image that already provides herdr, or add it to
the image, and set `FM_WT_HERDR_BIN` yourself.) The chart already exports
`HERDR_SESSION` to both containers, so the session is picked up automatically.

A session's **full conversation history** comes from the coding agent's own
session store (opencode's SQLite database), which lives under the firstmate home
the two containers share in this pod (`$FM_HOME/.local/share/opencode/opencode.db`,
read read-only with Node's built-in `node:sqlite`). The view maps the selected
pane to its session through the `agent_session` id herdr reports; the runtime
image bakes OpenCode's herdr integration so the primary pane reports it (see
[Build and push the images](#build-and-push-the-images)). No extra mount or
environment is needed; when the store or the session id is absent the view falls
back to the terminal output from `herdr pane read`. Status, instruction threads
(and the composer), and push notifications work without herdr; the live-session
list reports the missing dependency inline.

## Prerequisites

Provisioning these is **out of scope** for this chart; the cluster must already
have them:

- **Kubernetes** 1.27 or newer and **Helm** 3.
- **Gateway API** CRDs plus a **Gateway** you can attach to, with a listener for
  your host (an internet-facing NGINX Gateway, for example). The chart creates
  an HTTPRoute; it never installs the Gateway API, a Gateway controller, or a
  Gateway.
- A **StorageClass** for the firstmate home. Leave `persistence.storageClass`
  empty to use the cluster's default StorageClass; `beta3` (Rook-Ceph) is set
  only by the atus example.
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
- **Credentials**: a walkie-talkie bearer token, a GitHub token, and the
  provider credentials your primary harness reads from the environment — for
  the default opencode harness `DEEPSEEK_API_KEY` or `OPENROUTER_API_KEY`, for
  a Claude harness `ANTHROPIC_API_KEY`. The chart passes these to the firstmate
  container as environment variables. The GitHub token may instead come from an
  external secret-manager Secret (for example a Doppler-synced key named
  `GH_TOKEN`); see
  [GitHub token from a Doppler-synced Secret](#github-token-from-a-doppler-synced-secret).

## Build and push the images

firstmate runtime (this repo):

```sh
docker build -t registry.example.com/firstmate-runtime:0.1.0 deploy/kubernetes/firstmate
docker push registry.example.com/firstmate-runtime:0.1.0
```

The build installs firstmate from `FIRSTMATE_REPO`/`FIRSTMATE_REF` (defaults to
the public firstmate repo at a pinned commit, not a branch), then uses
firstmate's own pinned installers for herdr and treehouse. It then applies this
repo's patches under `deploy/kubernetes/firstmate/patches/` to that pinned
checkout, so every runtime image carries the repo's deliberate deltas and a
later ref bump that moves the patched context fails the build instead of
shipping silently. The primary harness is installed from `HARNESS_PACKAGES`
(default `opencode-ai`), and the chart's `firstmate.harnessCommand` default
starts that same opencode harness; when you build a different harness, set
`firstmate.harnessCommand` to match.

The runtime image also bakes OpenCode's herdr integration plugin (installed from
the herdr build itself) into the seed's `.opencode/plugins/`, so the primary pane
reports its agent session id (`agent_session`) to herdr and the walkie-talkie
Conversations view can read that session's real history from the agent store
rather than the terminal. The entrypoint refreshes the plugin into a retained
home. (It is placed project-level, not in `~/.config/opencode/plugins`, because
that path is a Kubernetes mount point for the agents ConfigMap and is not
writable by the unprivileged runtime user.)

The image also bakes the command-line tools a firstmate home expects on `PATH`,
so the deployed home boots without bootstrap's `MISSING:`-tool diagnostics:
`no-mistakes` (a pinned, checksum-verified release binary) and the AXI-family
tools `gh-axi`, `chrome-devtools-axi`, `tasks-axi`, `quota-axi`, and
`lavish-axi` (pinned npm versions). Their defaults track the floors in the
pinned firstmate ref's `bin/fm-bootstrap.sh`, so bump `FIRSTMATE_REF` and the
`*_VERSION` build args together; a tool the floors no longer accept fails
firstmate's own compatibility probes.

**Staying current is a rebuild-and-roll, not manual drift.** To pick up a newer
firstmate or tool version: bump `FIRSTMATE_REF` and the `*_VERSION` build args in
[`deploy/kubernetes/firstmate/Dockerfile`](../deploy/kubernetes/firstmate/Dockerfile),
verify the patch set still applies, build under a new immutable tag, push it,
update `firstmate.image.tag` in your values to that tag, and roll the release
with `helm upgrade`. The image tag must be immutable and build-specific; the
atus example uses the git commit the image was built from.

The committed patch set has two entries. `0001-opencode-arm-without-task.patch`
fixes upstream's OpenCode watch-arm plugin, which only armed supervision when a
`state/*.meta` task existed or x-mode was set, so a freshly booted home whose
only pending work was a queued inbox note never got a watcher and the note sat
undrained; the patch arms on any lock-owned primary, matching Pi and omp.
`0002-handling-successor-resurface-downtime.patch` fixes the watcher: after the
first cycle it re-arms as a handling successor, and upstream skipped the durable
recovery resurface for a handling successor, which was the only wake path for a
queued inbox note. In a deployed home whose only work is captain notes, every
note after the first cycle then sat in the wake queue forever; the patch makes a
handling successor surface new durable work while the once-per-generation arm
check still prevents the re-announce loop. The entrypoint refreshes both patched
files into an existing home on every start, so a retained volume picks the fixes
up too.

Override build args for a different harness or to bump the pinned firstmate ref
(reconcile the patches against the new tree):

```sh
docker build \
  --build-arg FIRSTMATE_REF=<40-char-commit> \
  --build-arg HARNESS_PACKAGES="@openai/codex" \
  --build-arg NO_MISTAKES_VERSION=1.84.0 \
  --build-arg GH_AXI_VERSION=0.1.35 \
  --build-arg CHROME_DEVTOOLS_AXI_VERSION=0.1.35 \
  --build-arg TASKS_AXI_VERSION=0.2.6 \
  --build-arg QUOTA_AXI_VERSION=0.1.55 \
  --build-arg LAVISH_AXI_VERSION=0.1.80 \
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
  --from-literal=DEEPSEEK_API_KEY="sk-xxx"
```

```yaml
credentials:
  existingSecret: firstmate-credentials
  keys:
    walkieTalkieToken: walkie-talkie-token
    githubToken: github-token
    harness:
      DEEPSEEK_API_KEY: DEEPSEEK_API_KEY
```

Each `keys.harness` entry maps an environment-variable name in the firstmate
container to a key in the Secret. The examples use `DEEPSEEK_API_KEY` for the
default opencode harness; use `OPENROUTER_API_KEY` instead, or
`ANTHROPIC_API_KEY` for a Claude harness.

With `credentials.existingSecret` set the chart creates no Secret. If your
Secret has no GitHub key, set `credentials.githubTokenEnabled: false`.

**Chart-created Secret.** Leave `existingSecret` empty and pass the values:

```sh
helm upgrade --install firstmate deploy/helm/firstmate -n <namespace> \
  --set credentials.create.walkieTalkieToken="$(openssl rand -hex 32)" \
  --set credentials.create.githubToken="github_pat_xxx" \
  --set credentials.create.harness.DEEPSEEK_API_KEY="sk-xxx"
```

If you omit the walkie-talkie token, the chart generates one and prints it in
the release notes. Set it explicitly for a token you control. Do not commit
real tokens to a values file.

**GitHub token from a Doppler-synced Secret.** To keep the GitHub PAT in a
secret manager rather than the chart's credential Secret, carry it as a key
named `GH_TOKEN` in a Secret you already sync into the namespace (the atus
deployment uses the Doppler operator's `firstmate-doppler-secrets`), inject
that Secret with `firstmate.extraEnvFrom`, map the same key to `GITHUB_TOKEN`
for tools that read that name, and disable the chart's own GitHub wiring so it
never sources a token from its credential Secret:

```yaml
firstmate:
  extraEnvFrom:
    - secretRef:
        name: firstmate-doppler-secrets
  # optional: true keeps the pod schedulable before the key exists; a missing
  # token then surfaces as `gh auth status` reporting logged-out, not a
  # crash-looping pod.
  extraEnv:
    - name: GITHUB_TOKEN
      valueFrom:
        secretKeyRef:
          name: firstmate-doppler-secrets
          key: GH_TOKEN
          optional: true
credentials:
  githubTokenEnabled: false
```

The exact key to add to the Doppler project is **`GH_TOKEN`**; its value is the
GitHub PAT, which the operator owns and never commits here. `extraEnvFrom`
injects it as the environment variable `GH_TOKEN`, which `gh` and `gh-axi`
read. Verify inside the pod:

```sh
kubectl -n <namespace> exec <pod> -c firstmate -- gh auth status
kubectl -n <namespace> exec <pod> -c firstmate -- gh api user --jq .login
```

The firstmate container starts its primary harness inside the herdr session at
container start, from `firstmate.harnessCommand` (default
`OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow"}}' opencode --prompt "$FM_PRIMARY_SESSION_START_PROMPT"`),
and keeps it running: the entrypoint supervises the harness and starts it again
in the same pane whenever it exits (a bad or missing credential, a crash, a
quit, an auto-update restart), so the pod keeps a live firstmate draining queued
instructions instead of only the herdr server. The harness runs in the firstmate
home with the container's environment, so the harness credentials above are
exactly the provider credentials it reads. The default auto-approves opencode's
tool calls because the primary runs unattended.

The default command also opens the harness with firstmate's session-start
prompt, exported by the entrypoint as `FM_PRIMARY_SESSION_START_PROMPT` (the
output of firstmate's own `bin/fm-sessionstart-nudge.sh`, or a plain fallback
when that adapter is absent). A bare opencode TUI does not create a session
until it receives a first prompt, so the initial prompt both creates the session
and starts firstmate. The entrypoint also removes firstmate's tracked
session-start nudge plugin
(`.opencode/plugins/fm-primary-sessionstart-nudge.js`) from the home, so the
opening prompt is the only delivery and the model never runs firstmate's
mutating session-start sweeps twice; firstmate's watcher and turn-end plugins
are left in place for supervision. When you set `firstmate.harnessCommand` for
another harness or posture, keep an initial prompt, or set it to `""` to run the
herdr server only and start the harness yourself after attaching (the supervisor
is not started when the command is empty).

On every start the entrypoint reconciles a retained home instead of trusting it
blindly. A herdr server restart rehydrates the persisted session layout as a
pane with no terminal: `herdr pane list` and `herdr agent get` still report the
primary pane and its last agent as idle, but `herdr pane run`, `herdr pane
send-text`, and `herdr pane read` all return `pane_not_found`. The entrypoint
therefore proves the pane has a live terminal before treating its agent record
as a running harness, closes a terminal-less restored husk and starts the
harness in a fresh live pane, and removes a watcher lock a previous container
left naming a dead pid (`state/.watcher-down` and `state/.wake-queue` are
firstmate's durable recovery state and are left for the patched watcher to
resurface). Without this, a pod restart or rollout with a retained volume left
the deployed firstmate idle, with no `bin/fm-watch.sh` running and captain notes
undrained; only a fresh-volume boot supervised.

Once created, the walkie-talkie token, GitHub token, and harness credentials are
preserved across upgrades: you do not need to re-pass them on `helm upgrade`.
Rotate one by passing a new value with `--set` (which replaces it and restarts
the pod).

The pod restarts only when an explicitly-passed credential changes: the chart
hashes just the `credentials.create.*` values you pass, never the
auto-generated token or values preserved from the live Secret. Two
consequences: stopping re-passing a credential you passed before triggers one
extra roll (it settles afterward), and changing the live Secret out-of-band
does not roll the pod — run
`kubectl -n <namespace> rollout restart statefulset/<name>` to pick it up.

## Agent configuration

`agents` is a declarative description of the harnesses, provider/model catalog,
and per-task dispatch defaults the deployed firstmate may use. The chart renders
it into a ConfigMap mounted on the firstmate home, so adding or removing an
agent is a values change and a `helm upgrade`, never an image rebuild. It is off
by default; set `agents.enabled: true` and declare the parts below.

```yaml
agents:
  enabled: true
  harnesses:
    - name: opencode
      env:
        - DEEPSEEK_API_KEY
        - OPENROUTER_API_KEY
  providers:
    - id: deepseek
      apiKeyEnv: DEEPSEEK_API_KEY
    - id: openrouter
      apiKeyEnv: OPENROUTER_API_KEY
  dispatch:
    rules:
      - when: "Mechanical or routine implementation with a settled plan."
        use:
          - harness: opencode
            model: openrouter/qwen/qwen3.8-27b
      - when: "Complex, ambiguous, or high-blast-radius work."
        use:
          - harness: opencode
            model: deepseek/deepseek-flash
    default:
      - harness: opencode
        model: deepseek/deepseek-flash
```

| Value | What it declares | Where it lands |
| --- | --- | --- |
| `agents.harnesses` | The harness adapters firstmate may launch and the environment variables that authorize each. The executable must already be in the runtime image (the `HARNESS_PACKAGES` build arg). | Declarative; validated against the dispatch profiles. |
| `agents.providers` | The provider/model catalog the opencode harness can call, provider-agnostically: any models.dev provider id or OpenAI-compatible endpoint. | `<home>/.config/opencode/opencode.json` (opencode's global config). |
| `agents.dispatch` | firstmate's per-task dispatch profiles, in its `crew-dispatch.json` schema, that choose a harness and model. A profile needs only `harness` unless typed dispatch is enabled, which also requires `provider` for harnesses without a built-in mapping such as `opencode`. | `<home>/config/crew-dispatch.json`. |

A provider sets `apiKeyEnv` (an environment-variable name, rendered as
opencode's `{env:NAME}`), or neither for a built-in models.dev provider or a
local server that needs no key. `models` is a map of model id to its config,
and `options` is passed through for provider-specific fields except `apiKey`,
which the chart rejects; declare the key with `apiKeyEnv` instead.
`agents.providers` renders only to the opencode harness config, so declaring a
catalog requires `opencode` in `agents.harnesses`; firstmate can dispatch
opencode crewmates from any primary harness, so the catalog is useful either
way.

The harness *executables* are an image concern: install every harness you may
want at build time with `HARNESS_PACKAGES` (for example
`opencode-ai @openai/codex`), then select, authorize, and route them per
deployment with `agents`. Adding a model or provider to an installed harness is
a values-only change.

### Authorization and adding an agent

Provider credentials still reach the container through the credential Secret
([Credentials](#credentials)); `agents.harnesses[].env` names the variables that
authorize each harness, and the chart fails the render if a provider references
a variable no harness declares. `apiKeyEnv` is only the name - the value comes
from the Secret.

To **add an agent**:

1. add the provider under `agents.providers` (with its `models`), or reference
   an already-declared provider from a dispatch profile;
2. add its API-key env var to the relevant `agents.harnesses[].env` and set the
   value through `credentials.create.harness.<NAME>` (or the existing Secret);
3. add or adjust a profile in `agents.dispatch` to route work to it;
4. `helm upgrade` - the agent ConfigMap's checksum rolls the pod.

To **remove an agent**, delete its provider, dispatch profile, and env
declaration; no image rebuild is involved. A self-hosted or local
OpenAI-compatible server is just another provider: an OpenAI-compatible
`baseURL` and models listed by id, with no API key because the server needs
none. The network path to it (a firewall change) is out of scope here, and so
is any app UI for choosing an agent per instruction; this chart only makes the
agents available and sets dispatch defaults.

The chart validates `agents` at render time and fails with a specific message
instead of writing a config firstmate or opencode cannot read: a missing harness
name or provider id, a duplicate, a provider field the schema does not allow, an
`apiKeyEnv` no harness declares, a dispatch profile naming an undeclared
harness, an explicitly empty `dispatch.default`, a provider catalog without the
`opencode` harness, or an enabled block that declares neither a provider nor a
dispatch.
`dispatch.default` (and a rule's `use`) accepts either a non-empty array or a
single profile object, matching firstmate's own schema.

A profile needs only `harness` for the default, non-typed deployment; the
example above omits `provider` for that reason. When firstmate runs with typed
dispatch enabled (`TYPESAFE_API_KEY`), its resolver also requires `provider` on
every profile whose harness has no built-in single-provider mapping:
`claude`, `codex`, `grok`, `kimi`, `cursor`, `agy`, and `muse` have one, while
`opencode` (and `pi`, `pi-signed`, `omp`) do not, so every such profile must
name the quota-axi provider family to use (for example `provider: deepseek`).
If you enable typed dispatch without adding `provider` to the example's
`opencode` profiles, firstmate rejects the rendered `crew-dispatch.json` as a
malformed rules file and dispatch stops. Either add `provider` to each profile
or leave typed dispatch off.

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
session and starts firstmate's primary harness inside it, restarting it in the
same pane if it exits. Attach to it:

```sh
kubectl -n firstmate exec -it firstmate-0 -c firstmate -- \
  herdr session attach firstmate
```

This is the same herdr workflow as on a workstation; firstmate's supervisor runs
in that session. The pod stays up on the herdr server, so attaching never races
a short-lived process. The harness is already running in the session's primary
workspace, so an attach lands on a live firstmate rather than an empty server.

## Values

| Value | Default | What it does |
| --- | --- | --- |
| `firstmate.image.repository` / `.tag` | `firstmate-runtime` / chart version | Runtime image. |
| `firstmate.home` | `/home/firstmate` | Absolute container path of the firstmate home; also the volume mount and `FM_HOME`. |
| `firstmate.herdrSession` | `firstmate` | Named herdr session (`HERDR_SESSION`). |
| `firstmate.harnessCommand` | `OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow"}}' opencode --prompt "$FM_PRIMARY_SESSION_START_PROMPT"` | Command that starts the primary harness in the herdr session at container start; the entrypoint restarts it when it exits and removes firstmate's session-start nudge plugin so this prompt is the only delivery; `""` runs the server only. |
| `walkieTalkie.image.repository` / `.tag` | `walkie-talkie` / chart version | Companion image. |
| `walkieTalkie.port` | `8787` | Walkie-talkie port inside the container. |
| `persistence.storageClass` | `""` (cluster default) | StorageClass for the home claim; `beta3` in the atus example. |
| `persistence.size` | `20Gi` | Home claim size. |
| `persistence.existingClaim` | `""` | Use a pre-created PVC instead of a claim template. |
| `service.port` | `8787` | Service port routed by the HTTPRoute. |
| `httpRoute.parentRefs` | `gateway` in `nginx-gateway` | Gateway parentRef(s): name, namespace, optional `sectionName` listener. |
| `httpRoute.hostnames` | `firstmate.example.com` | Host(s) routed to walkie-talkie. |
| `httpRoute.redirect.enabled` | `false` | Add an HTTP → HTTPS redirect route. |
| `certificate.enabled` | `false` | Create a cert-manager Certificate in-namespace. |
| `credentials.*` | — | Secret reference or values (see above). |
| `agents.*` | `enabled: false` | Declarative harnesses, provider/model catalog, and dispatch profiles (see [Agent configuration](#agent-configuration)). |
| `firstmate.resources` / `walkieTalkie.resources` | small requests | Per-container resources. |
| `networkPolicy.enabled` | `false` | Restrict ingress to the Gateway namespace. |
| `gateway.*` | `enabled: false` | The multi-user gateway in front of the firstmate pod (see [Multi-user gateway](#multi-user-gateway)). |
| `nodeSelector` / `tolerations` / `affinity` / `priorityClassName` | empty | Scheduling. |
| `firstmate.podSecurityContext` / `firstmate.securityContext` / `walkieTalkie.securityContext` | non-root, uid/gid 1000, fsGroup 1000 | Change to match your Pod Security Admission and volume ownership. |

Set `walkieTalkie.herdrCLI.enabled: true` to have the chart install the herdr
CLI for the Conversations view (see above). Use `FM_WT_HERDR_BIN` /
`FM_WT_HERDR_SESSION` through `walkieTalkie.extraEnv` only when you supply the
binary and session yourself. Add harness/model configuration through `agents` (see
[Agent configuration](#agent-configuration)), ambient environment through
`firstmate.extraEnv` or `firstmate.extraEnvFrom`, and more credentials through
`credentials.create.harness` / `credentials.keys.harness`. Harness entries may
not reuse the reserved names the chart manages — the
`credentials.keys.walkieTalkieToken`/`credentials.keys.githubToken` key names and
the `GH_TOKEN`/`GITHUB_TOKEN` env names — a collision fails the render instead of
silently overwriting the built-in credential.

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
the volume binds; with the atus example's immediate-binding `beta3` class the
volume binds at claim time. To bring an existing firstmate home with you, create
its PVC and set
`persistence.enabled: false` with `persistence.existingClaim`.

## Example: the atus cluster

The atus cluster is internet-facing behind an NGINX Gateway API. The worked
example is
[`deploy/helm/firstmate/examples/values-atus.yaml`](../deploy/helm/firstmate/examples/values-atus.yaml):

- Gateway `gateway` in namespace `nginx-gateway`, HTTPS listener
  `https-atus-wildcard` (hostname `*.atus.hr`), HTTP listener `http`.
- Host `walkie-talkie.atus.hr`, with an HTTP → HTTPS redirect.
- StorageClass `beta3` (Rook-Ceph), 20Gi.
- TLS terminates at the Gateway using the existing wildcard certificate, so no
  in-namespace Certificate.
- `agents.enabled: true` with opencode as the harness and DeepSeek and
  OpenRouter as API-key providers; the routine tier routes to Qwen3.8-27B on
  OpenRouter (`openrouter/qwen/qwen3.8-27b`), the same model the retired 3090
  box self-hosted (see [Agent configuration](#agent-configuration)).
- Harness credentials and the GitHub token come from the Doppler-synced Secret
  `firstmate-doppler-secrets` (`firstmate.extraEnvFrom`), not from `--set`. Add
  the GitHub PAT as the Doppler key `GH_TOKEN` (see
  [GitHub token from a Doppler-synced Secret](#github-token-from-a-doppler-synced-secret)).

```sh
helm upgrade --install firstmate deploy/helm/firstmate \
  --namespace firstmate --create-namespace \
  -f deploy/helm/firstmate/examples/values-atus.yaml \
  --set credentials.create.walkieTalkieToken="$(openssl rand -hex 32)"
```

That example is a starting point; adjust the host, the listener `sectionName`,
the images, and the provider credentials (opencode's `DEEPSEEK_API_KEY` /
`OPENROUTER_API_KEY`, or `ANTHROPIC_API_KEY` for a Claude harness) for your
cluster.

### atus deploy record

| Date | walkie-talkie | firstmate runtime | Source |
| --- | --- | --- | --- |
| 2026-10-03 | `62279d5d2415` (rebuilt) | `6eb5b4543933` (unchanged) | main at `62279d5` (merge of PR #24). The runtime build context `deploy/kubernetes/firstmate` is identical between `6eb5b45` and `62279d5`, so the running runtime image already matches main and was not rebuilt. |
| 2026-10-03 | `e4dc8b5e7db3` (rebuilt) | `6eb5b4543933` (unchanged) | main at `e4dc8b5` (merge of PR #26). The runtime build context `deploy/kubernetes/firstmate` is identical between `6eb5b45` and `e4dc8b5`, so the running runtime image already matches main and was not rebuilt. |
| 2026-10-04 | `d9702fcbf9d9` (rebuilt) | `6eb5b4543933` (unchanged) | main at `d9702fc` (merge of PR #28). The runtime build context `deploy/kubernetes/firstmate` is identical between `6eb5b45` and `d9702fc`, so the running runtime image already matches main and was not rebuilt. |
| 2026-10-04 | `36ac8b81ad5b` (rebuilt) | `6eb5b4543933` (unchanged) | main at `36ac8b8` (merge of PR #30). The runtime build context `deploy/kubernetes/firstmate` is identical between `6eb5b45` and `36ac8b8`, so the running runtime image already matches main and was not rebuilt. |

## Multi-user gateway

*Written 2026-10-05. The chart support is merged with the atus values at
`gateway.enabled: false`, so nothing below has been deployed. Enabling it is a
separate deploy decision.*

`gateway.enabled: true` adds walkie-talkie's multi-user gateway
(`FM_WT_MODE=gateway`, see the README's "Multi-user gateway") as its own
workload in front of the firstmate pod. People sign in with GitHub, and the
gateway forwards each signed-in user's API calls only to that user's own
firstmate. The existing firstmate pod becomes a **static tenant**: an upstream
the gateway routes to but does not manage. The StatefulSet, its PVC, images,
model and agents config do not change. The gateway values only add objects and
move the HTTPRoute backend.

| Resource (release `firstmate`) | Purpose |
| --- | --- |
| `Deployment` `firstmate-gateway` (1 replica, `Recreate`) | The walkie-talkie image in gateway mode. It mounts no ServiceAccount token, runs as uid 1000 with a read-only root filesystem, and is probed on `/healthz`. |
| `ConfigMap` `firstmate-tenant-params` | `catalog.json`: the provider and model catalog from `tenants.catalog`, mounted read-only at `/etc/walkie-talkie/tenant-params` (`FM_WT_CATALOG`). A catalog change restarts the gateway. |
| `PersistentVolumeClaim` `firstmate-gateway-data` (1Gi) | The gateway's SQLite store: users, sessions, invites, the audit log, users' encrypted keys and their model choices. It is annotated `helm.sh/resource-policy: keep`, so turning the gateway off, or uninstalling, keeps the users. |
| `Service` `firstmate-gateway` (:8787) | The public port, and the HTTPRoute's backend while the gateway is on. |
| `Service` `firstmate-gateway-internal` (:8788) | Credential delivery to per-user firstmates (see [Per-user firstmates](#per-user-firstmates)). With `tenants.enabled: false` nothing listens there. It is never on the HTTPRoute. |
| `ServiceAccount` `firstmate-gateway` | The gateway's own identity. Its pod mounts no token and has no API permissions, unless `tenants.enabled`: then it mounts one, bound to a Role in the tenant namespace only. |
| `NetworkPolicy` `firstmate-gateway` | The gateway's public port accepts traffic only from the Gateway's namespace, and its internal port only from `gateway.tenantNamespace`. |
| `NetworkPolicy` `firstmate` | The firstmate pod's walkie-talkie port accepts traffic only from gateway pods, so nothing can bypass the gateway. While the gateway's policies render, this replaces the plain `networkPolicy`. |

Gateway pods are labelled `app.kubernetes.io/name: firstmate-gateway` and
`app.kubernetes.io/component: gateway`. Because the name label differs from the
firstmate pod's, the firstmate Service and StatefulSet never select a gateway
pod.

### Gateway values

| Value | Default | What it does |
| --- | --- | --- |
| `gateway.enabled` | `false` | Render the gateway, switch the HTTPRoute to it, and add the policies. When `false`, nothing renders and the output is the same as before. |
| `gateway.image.repository` / `.tag` | `""` (falls back to `walkieTalkie.image`) | The gateway image. It must be a build that includes gateway mode. |
| `gateway.publicOrigin` | `https://` + first `httpRoute.hostnames` | The origin users open. The OAuth callback and the CSRF check use it. |
| `gateway.githubClientId` | `""` (required when enabled) | The OAuth App's client id. It is public. |
| `gateway.admins` | `[]` (at least one required when enabled) | GitHub numeric ids that hold the admin role. |
| `gateway.accessRequests.enabled` | `true` | Uninvited sign-ins become access requests. `false` is strict invite-only. |
| `gateway.legacyBearer.enabled` | `false` | Migration bridge: accept the old shared token from a browser as the first admin. |
| `gateway.legacyBearer.tokenSecretRef` | the chart's credential Secret, key `credentials.keys.walkieTalkieToken` | Where the old token is read from. |
| `gateway.staticTenants` | `[]` | A list of `{githubId, upstream, tokenSecretRef: {name, key}}` entries. The token always comes from a Secret. |
| `gateway.secrets.existingSecret` | `""` (required when enabled) | The Secret holding the three gateway secrets. |
| `gateway.secrets.keys.*` | `WT_GITHUB_CLIENT_SECRET`, `WT_VAULT_KEYS`, `WT_TENANT_TOKEN_SECRET` | Key names in that Secret. |
| `gateway.vault.activeKey` | `k1` | The keyring id that new credentials are encrypted under. It is not a secret. |
| `gateway.trustedProxyHops` | `1` | `X-Forwarded-For` hops trusted for per-client rate limits. |
| `gateway.tenantNamespace` | `firstmate-tenants` | The only namespace allowed to reach the internal port. |
| `gateway.persistence.*` | 1Gi `ReadWriteOnce`, cluster default class | The store claim. |
| `gateway.networkPolicy.enabled` | `true` | The two policies above. This needs a CNI that enforces NetworkPolicy and lets kubelet probes through. |
| `tenants.catalog` | Anthropic, OpenAI, OpenRouter, Google, DeepSeek; opencode; optional GitHub token | What users choose from in **Setup** (see [Provider catalog](#provider-catalog)). |
| `tenants.enabled` and the rest of `tenants.*` | `false` | Per-user firstmates (see [Per-user firstmates](#per-user-firstmates)). |

The chart has **no field for a secret value**. The OAuth client secret, the
vault keyring, the tenant-token master, the static tenants' tokens and the
legacy token reach the gateway only as `secretKeyRef`. A value given inline
(for example `gateway.githubClientSecret`, `gateway.secrets.vaultKeys` or
`staticTenants[].token`) fails the render. The values schema rejects it, and the
templates reject it again when schema validation is skipped. That happens even
while the gateway is disabled.

The gateway also mounts the tenant-token master, which only per-user
firstmates (`tenants.enabled`) use. The vault keyring encrypts users' keys from
the start. The keys must therefore exist in the
Secret before the gateway is enabled; otherwise the pod stays in
`CreateContainerConfigError`.

### Provider catalog

`tenants.catalog` is the menu users pick from when they set up their own
firstmate. It renders only with the gateway enabled. Each provider declares its
`id`, display `name`, the `keyEnv` its key is delivered under, the `validate`
endpoint, and the `models` on offer:

```yaml
tenants:
  catalog:
    harnesses:
      - name: opencode
    providers:
      - id: deepseek
        name: DeepSeek
        keyEnv: DEEPSEEK_API_KEY
        validate:
          url: https://api.deepseek.com/models
          auth: bearer            # or x-api-key / x-goog-api-key
        models: [deepseek-flash, deepseek-chat]
      - id: google
        name: Google
        keyEnv: GOOGLE_GENERATIVE_AI_API_KEY
        validate:
          url: https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000
          auth: x-goog-api-key
          invalidReason: API_KEY_INVALID   # a 400 with this reason is a bad key
        models: [gemini-2.5-pro, gemini-2.5-flash]
    github:                       # optional per-user GitHub token
      keyEnv: [GH_TOKEN, GITHUB_TOKEN]
      validate: { url: https://api.github.com/user, auth: bearer }
```

- The `validate.url` hosts are the **only** hosts the gateway sends a user's
  key to. They must be `https`, and redirects are never followed.
- A `2xx` answer stores the key and `401`/`403` rejects it; anything else
  leaves it unverified and stores nothing. A provider that signals a bad key
  with a `400` instead (Google) sets `validate.invalidReason` to the reason code
  its error carries in `error.details[].reason`; only a `400` with that reason
  rejects the key, and any other `400` stays unverified.
- Ask for the whole model list in the URL where the provider pages it
  (Anthropic `?limit=1000`, Google `?pageSize=1000`). A listing that says more
  pages follow restricts nothing.
- The catalog never holds a key. Users bring their own; it is checked with the
  provider, encrypted with the vault keyring and stored in the gateway's store.
- The render fails on a duplicate provider id or key name, a non-https
  validation URL, an unknown `auth`, a reserved header (`Authorization`,
  `Host`, …), a provider without models, or a key written into the catalog. The
  gateway checks the same rules again when it starts.
- Model ids are pinned here. Check them against each provider's own model list
  when you change them.
- The captain's own firstmate (the static tenant) does not use the catalog; its
  model stays in `agents.*`.

### Vault key rotation

A rotation is a Doppler change and a values change. No command is run.

1. In the gateway's Doppler config, append a new key to `WT_VAULT_KEYS`:
   `k1:<old>,k2:<openssl rand -base64 32>`.
2. In a values PR, set `gateway.vault.activeKey: k2` and deploy. The gateway
   restarts. At start-up it re-encrypts every stored credential still under
   `k1` with `k2`, in one transaction, and logs
   `vault: re-sealed <n> credential(s) under k2 at start-up` (counts and key ids
   only). New keys are encrypted under `k2` from then on.
3. Remove `k1` from `WT_VAULT_KEYS` in Doppler. To restart the gateway onto the
   shorter keyring, bump `gateway.secrets.rotation` in a values PR (see below).

If a credential cannot be decrypted at start-up (for example `k1` was removed
before the gateway restarted with `k2` active), the re-seal changes nothing,
logs the owner and slot that failed, and the gateway keeps running. Put `k1`
back and restart. `node dist/src/index.js vault rotate` in the gateway's
container does the same re-seal by hand, for audit or recovery.

### Restarting the gateway onto changed secrets

A Doppler change to `WT_GITHUB_CLIENT_SECRET`, `WT_VAULT_KEYS` or
`WT_TENANT_TOKEN_SECRET` updates the Secret but not the running gateway. Set
`gateway.secrets.rotation` to any new string (a date works) in a values PR. It
renders as the pod annotation `walkie-talkie.atus.hr/secrets-rotation`, so the
deploy restarts the gateway onto the new values. Left empty, it adds nothing.

**Rotating the tenant-token master** is exactly that: put a new
`openssl rand -base64 32` in `WT_TENANT_TOKEN_SECRET`, then bump
`gateway.secrets.rotation`. Every per-user firstmate's derived tokens change, and
so does the master's fingerprint in each tenant pod template
(`walkie-talkie.atus.hr/token-epoch`). The reconciler re-applies every tenant's
Secret, and each tenant restarts once onto its new tokens. Until a tenant has
restarted, the gateway cannot reach it (502), and it fetches its keys again as
it starts.

### Per-user firstmates

*Written 2026-10-05. Merged with `tenants.enabled: false`; enabling it is a
separate deploy decision, after the gateway is on and the CNI check below has
passed.*

`tenants.enabled: true` (with `gateway.enabled` and
`gateway.networkPolicy.enabled`, or the render fails) lets the gateway run a
firstmate for every user who sets one up. The chart adds the namespace and its
isolation; the gateway's reconciler creates each user's objects in it when they
start their firstmate with `POST /api/me/firstmate/start` (the **Start** button
under **Setup** in the app), and scales them to zero on
`POST /api/me/firstmate/stop` (see the README's "Per-user firstmates").

Lifecycle, all in the app:

- **Start / Stop**: the user, under Setup. Stopping keeps the home, Secret and
  agents config.
- **Key or model change**: the firstmate restarts onto it. A key change bumps
  its config version, and a model change changes its agents config. The app
  warns that work in flight restarts with it.
- **Suspend / Resume**: an admin. A suspended user's firstmate is scaled to zero
  and gets no credentials. Resuming restores what the user had.
- **Remove**: an admin. The workload is deleted at once. The home volume is kept
  for `tenants.purgeAfterDays` (30 by default), then deleted. It shows under
  Admin → **Removed users' homes**, where **Purge now** (tapped twice, sent with
  the volume's id as confirmation) deletes it sooner. Until it is deleted it
  still holds a firstmate slot.

| Resource | Purpose |
| --- | --- |
| `Namespace` `firstmate-tenants` (`gateway.tenantNamespace`) | Pod Security labels `enforce`, `audit` and `warn` set to `restricted`. Annotated `helm.sh/resource-policy: keep`: deleting it would delete every user's home. |
| `ServiceAccount` `fm-tenant` | The identity every tenant pod runs as. No token, no RBAC. |
| `ResourceQuota` `firstmate-tenants` | `maxTenants` × one tenant pod: `pods`, `requests.cpu`, `requests.memory`, `limits.memory`, `requests.storage`, `persistentvolumeclaims`. With the defaults: 5 pods, 1500m, 2880Mi, 11520Mi, 50Gi, 5 claims. |
| `LimitRange` `firstmate-tenants` | Defaults for a container that names none (the sidecar's resources), a per-container memory ceiling (the firstmate container's limit), and a per-claim storage ceiling. |
| `Role` / `RoleBinding` `firstmate-gateway` (tenant namespace) | The gateway's ServiceAccount may get, list, watch, create, patch, update and delete StatefulSets, Services, ConfigMaps and Secrets; get, list, watch and delete PVCs; and get, list and watch pods. No exec, attach, port-forward or logs, no RBAC, nothing cluster-scoped, nothing in the release namespace. |
| `NetworkPolicy` `firstmate-tenants-default-deny` | Denies all ingress and egress in the namespace. |
| `NetworkPolicy` `firstmate-tenants-from-gateway` | A tenant's walkie-talkie port (8787) only from gateway pods. |
| `NetworkPolicy` `firstmate-tenants-egress` | DNS to `kube-dns`; the gateway's internal port (8788); TCP 443, 80 and 22 to `0.0.0.0/0` and `::/0` except private, CGNAT, link-local and loopback ranges, so never the Kubernetes API, another tenant, another workload or the metadata endpoint. |
| `tenants.json` in `firstmate-tenant-params` | How each tenant runs: images, resources, storage, uid/gid, scheduling, harness command, the gateway's internal URL. The gateway reads it at start-up (`FM_WT_TENANT_PARAMS`) and restarts when it changes. |

Each tenant the reconciler creates is a `StatefulSet`, `Service`, `ConfigMap`
and token `Secret` named after an opaque id (`fm-<tid>…`), plus its PVC
`home-fm-<tid>-0`. Its pods run as uid 1000 with no privilege escalation, no
capabilities, `RuntimeDefault` seccomp, no ServiceAccount token and no service
links. No provider key or GitHub token is ever in a Secret: the runtime pulls
them from the gateway's internal port at start (D4), so the runtime image must be
a build whose entrypoint does that (`deploy/kubernetes/firstmate/entrypoint.sh`,
step 2c). The atus runtime image `6eb5b4543933` predates it; pin a newer build
in `tenants.image.firstmate.tag`.

| Value | Default | What it does |
| --- | --- | --- |
| `tenants.enabled` | `false` | Render the above and give the gateway its token and parameters. |
| `tenants.maxTenants` | `5` | Cap on users with a managed firstmate (approving, inviting or starting past it is refused; removed users' retained home volumes count) and the quota multiplier. |
| `tenants.purgeAfterDays` | `30` | Days a removed user's home volume is kept for recovery before the gateway deletes it. `0` deletes it at the next sweep. |
| `tenants.image.firstmate` / `.walkieTalkie` | `firstmate.image` / the gateway image | Tenant images, pinned to immutable tags (`latest` fails the render). |
| `tenants.imagePullSecrets` | `[]` | Pull Secrets that exist in the tenant namespace. |
| `tenants.harnessCommand` | `firstmate.harnessCommand` | Starts each tenant's primary harness. The model comes from the generated `opencode.json`. |
| `tenants.resources.{firstmate,walkieTalkie,init}` | 250m/512Mi requests, 2Gi and 4Gi ephemeral limits; 50m/64Mi, 256Mi; 10m/16Mi, 64Mi | Per-tenant resources. CPU in `m` or cores and memory in `Mi`/`Gi`/`Ti`, because the quota is computed from them. |
| `tenants.persistence.storageClass` / `.size` | cluster default / `10Gi` | Each tenant's home claim. A size or class change applies to tenants created afterwards; existing ones keep their claim template. |
| `tenants.securityContext.{runAsUser,runAsGroup,fsGroup}` | `1000` | The ids tenant pods run as; the rest of the restricted posture is fixed. |
| `tenants.nodeSelector`, `.tolerations`, `.affinity`, `.priorityClassName` | none | Tenant pod scheduling. |
| `tenants.networkPolicy.dns` | `kube-system`, `k8s-app: kube-dns` | Where tenants resolve names. |
| `tenants.networkPolicy.dns.extraCidrs` | `[]` (atus: `169.254.25.10/32`) | Other addresses that answer DNS for pods on port 53, such as a node-local DNS cache. The cache's link-local address is otherwise excluded from tenant egress. |
| `tenants.networkPolicy.egressPorts` | `443, 80, 22` | Internet ports tenants may use. |
| `tenants.networkPolicy.excludeCidrs` / `excludeCidrsV6` / `extraExcludeCidrs` | RFC 1918, `100.64.0.0/10`, link-local, loopback; `fc00::/7`, `fe80::/10`; none | Ranges tenants may never reach. Add the cluster's pod and service CIDRs to `extraExcludeCidrs` if they fall outside the defaults. |

To see exactly what the gateway applies for each user, run in its container:

```sh
node dist/src/index.js tenants render [--user <login>]
```

It prints the objects as JSON documents (valid YAML) and changes nothing. The
two tokens in each Secret are printed as `<redacted>`.

### One-time setup (outside the repo)

Two steps cannot be expressed in the repo. Both happen once, before the enable
PR is deployed.

**1. Register the GitHub OAuth App.** Register it on the captain's account
(`shimpa1`): GitHub → Settings → Developer settings → OAuth Apps → **New OAuth
App**. GitHub has no API for creating one.

| Field | Value |
| --- | --- |
| Application name | `walkie-talkie (atus)` |
| Homepage URL | `https://walkie-talkie.atus.hr` |
| Authorization callback URL | `https://walkie-talkie.atus.hr/auth/github/callback` (exactly; this is `<gateway.publicOrigin>/auth/github/callback`) |
| Enable Device Flow | off |

After registering:

- **Generate a new client secret.** Store it only in Doppler, as
  `WT_GITHUB_CLIENT_SECRET` (step 2).
- **Copy the Client ID** into `gateway.githubClientId` in the enable PR. It is
  public.

The gateway requests no scopes. Sign-in reads only the public profile, and the
GitHub access token is dropped after that one call.

**2. Add the Doppler keys.** Put them in a Doppler config dedicated to the
gateway. Sync it with its own DopplerSecret into the Secret
`firstmate-gateway-secrets` in namespace `firstmate`, alongside the existing
`doppler-firstmate` → `firstmate-doppler-secrets`.

Do **not** add these keys to the config behind `firstmate-doppler-secrets`. The
firstmate container takes that whole Secret through `envFrom`, so the agent
would see the gateway's client secret and vault keys.

| Doppler key | Value | Generator |
| --- | --- | --- |
| `WT_GITHUB_CLIENT_SECRET` | the OAuth App client secret from step 1 | GitHub |
| `WT_VAULT_KEYS` | `k1:<base64 of 32 random bytes>` | `printf 'k1:%s\n' "$(openssl rand -base64 32)"` |
| `WT_TENANT_TOKEN_SECRET` | base64 of 32 random bytes | `openssl rand -base64 32` |

The `k1` prefix must match `gateway.vault.activeKey`. A later key rotation adds
`,k2:<…>` and moves `activeKey` to `k2`.

**3. Check that the CNI enforces NetworkPolicy** (read-only). Identify the
cluster's CNI:

```sh
kubectl -n kube-system get daemonsets
```

- **Calico or Cilium:** both enforce NetworkPolicy, and both admit node-local
  kubelet probes by default.
- **Flannel alone:** it enforces nothing. The policies would be inert, though
  harmless. Per-user firstmates (`tenants.enabled`) must not be enabled on such
  a cluster: their isolation is network policy.

The policies also have to admit kubelet probes. If they did not, the firstmate
pod would go un-Ready behind its new policy. If the CNI blocks probes, set
`gateway.networkPolicy.enabled: false` in the enable PR and fix the CNI first.

An enforcing CNI is not enough on its own: a **cluster-wide policy can
override** a namespace's NetworkPolicies. With Calico, a GlobalNetworkPolicy
that selects every workload and ends in an unconditional `Allow` decides
before (or tied with, at order 1000) the Kubernetes policies. That Allow lets
tenants' egress past their default-deny. Check before enabling tenants:

```sh
kubectl get globalnetworkpolicies.crd.projectcalico.org
```

**atus, 2026-10-06:** the check above ran in throwaway namespaces with the
chart's own tenant policies. It found Calico v3.30 **enforcing ingress**: other
tenants and non-gateway pods are refused, only tenants reach the gateway's
internal port, and probes pass. **Egress is not enforced:** the
GlobalNetworkPolicy `akash-guard-threatintel-egress-deny` ends in an
unconditional `Allow`, and a test tenant reached the Kubernetes API and other
pods. Per-user firstmates must stay off on atus until that policy no longer
allows tenant egress, for example by moving it to a tier ahead of `default`
that ends in `Pass`, and this check passes. atus pods also resolve names
through node-local DNS at `169.254.25.10`, which the atus values admit through
`tenants.networkPolicy.dns.extraCidrs`.

### Cutover (the enable PR)

The atus values already declare everything except three fields. The enable PR
sets them:

```yaml
gateway:
  enabled: true
  githubClientId: <Client ID from step 1>
  image:
    tag: <a walkie-talkie build of main at or after the merge of PR #33>
```

The atus values already carry:

- `admins: [20532068]`;
- `legacyBearer.enabled: true`;
- the static tenant `{githubId: 20532068, upstream:
  http://firstmate.firstmate.svc.cluster.local:8787, tokenSecretRef:
  {name: firstmate-credentials, key: walkie-talkie-token}}`;
- `secrets.existingSecret: firstmate-gateway-secrets`;
- the `beta3` store class.

The firstmate pod's sidecar image stays on its current build. Only the gateway
runs the new image.

Deploying it with `helm upgrade` creates the gateway objects and moves the
HTTPRoute backend from `firstmate:8787` to `firstmate-gateway:8787`. The
StatefulSet is not modified, so `firstmate-0` does not restart.

Expected behaviour afterwards:

- `https://walkie-talkie.atus.hr/healthz` answers `{"ok":true}`.
- `/auth/session` reports `"mode":"gateway"` and `"legacy_bearer":true`.
- **The installed phone keeps working.** It still sends its old bearer token,
  and the bridge maps that token to the admin. Responses carry
  `x-wt-legacy-auth: deprecated`, and the app offers **Sign in with GitHub**.
- **Sign in with GitHub on each device.** Status and Conversations are the same,
  now proxied from `firstmate-0`. On the installed iOS app, if the GitHub
  redirect lands in Safari instead, use Settings → **Link a device** in Safari
  and enter the code on the app's sign-in screen.

### Retire the bridge

Once every device has signed in with GitHub, a follow-up values PR sets
`gateway.legacyBearer.enabled: false`. After that, the walkie-talkie token is
only the gateway → firstmate-pod credential. To rotate it, pass a new
`credentials.create.walkieTalkieToken` on the next upgrade. The firstmate pod
and the gateway both restart onto it, and no phone needs to change.

### Rollback

Rollback works at any step. Set `gateway.enabled: false` and upgrade. That:

- puts the HTTPRoute back on `firstmate:8787`;
- removes the gateway Deployment, Services, ServiceAccount and policies.

The firstmate pod was never modified, so there is nothing to restore. The
gateway's store claim is kept, so re-enabling later brings back the same users,
invites and sessions.

After a rollback, a phone talks to the firstmate pod directly again and needs
the walkie-talkie token:

- **The phone never signed in with GitHub:** it still holds the token and works
  at once.
- **The phone signed in:** the app has forgotten the token. Re-enter it under
  Settings. If the token was rotated after the bridge was retired, use the new
  value.

## Upgrade

```sh
helm upgrade firstmate deploy/helm/firstmate -n firstmate -f my-values.yaml
```

Changing the image tag rolls the StatefulSet. The home PVC is retained across
upgrades. Credentials the chart created are preserved across upgrades: the
walkie-talkie token, GitHub token, and harness credentials keep their existing
values unless you pass new ones, in which case the Secret is updated and the
pod restarts.

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
(the seeding path was exercised in the image), and the image now carries
firstmate's expected CLI tools (no-mistakes and the AXI family). The
harness-start and harness-supervision paths are exercised without a cluster and
without driving any real Herdr lifecycle, using a fake `herdr` on `PATH`:

```sh
bash deploy/kubernetes/firstmate/entrypoint.test.sh
```

It asserts that the entrypoint creates the primary workspace, starts
`firstmate.harnessCommand` in that workspace's pane, exports firstmate's
session-start prompt to the pane and removes its tracked session-start plugin
(so the prompt is the only delivery) while leaving the other plugins, leaves a
live harness alone, starts it again when the fake reports it exited, and that
harness credentials reach both the herdr server environment and the pane call.
It also replays the restart stall: a retained session whose pane is listed with
an idle agent but whose terminal read returns `pane_not_found` must be closed and
replaced by a fresh live pane rather than accepted as a running harness, and a
watcher lock left by a previous container naming a dead pid must be removed
while the durable downtime marker is preserved. Starting a real herdr server,
session, or harness is a cluster/runtime concern and is not driven here.

**What is not verified here.** Steps that require a real cluster — actual PVC
binding, Gateway attachment and certificate issuance, image pulls, secret
contents (including the Doppler-synced `GH_TOKEN`), `gh auth status` inside the
pod, the tools being on `PATH` in a running pod, the harness actually launching
and draining queued instructions, and firstmate's own data/logins — cannot be
exercised outside the cluster and are stated as expectations, not asserted
facts. GitHub authentication reaches the container as `GH_TOKEN`/`GITHUB_TOKEN`
through the Doppler secret once the captain adds the `GH_TOKEN` key; the rest of
firstmate's data and logins (harness login, projects) is out of scope: after
install, attach and complete it as you would on any firstmate host.

## Troubleshooting

- **Pod not ready.** Readiness asks firstmate whether it is ready. Until the
  home is seeded and firstmate's toolchain is satisfied, readiness stays false;
  check `kubectl -n <ns> logs <statefulset-name>-0 -c walkie-talkie` and
  `... -c firstmate`.
- **Attach shows no session.** Confirm the firstmate container is running and
  logs include `starting herdr server for session '<name>'`; the session name
  is `firstmate.herdrSession`.
- **Attach shows an empty server (no harness).** Confirm the logs include
  `starting primary harness in`. The entrypoint supervises the harness and
  restarts it when it exits, logging `primary harness is not running` when it
  finds none (or `could not confirm the primary harness state` when a herdr read
  fails and it retries the start path), so an empty pane that stays empty means
  `firstmate.harnessCommand` names a harness the image did not install or it
  exits immediately on every attempt; check the repeated restart lines and start
  a working harness by hand after attaching.
- **Route not serving.** Check the HTTPRoute status and that its `parentRefs`
  name and namespace match your Gateway and `sectionName` matches a listener
  whose hostname covers `httpRoute.hostnames`.
- **Volume permission errors.** Align `firstmate.podSecurityContext.fsGroup`
  and the container `runAsUser`/`runAsGroup` with the volume; uid/gid 1000
  matches both images' defaults.
