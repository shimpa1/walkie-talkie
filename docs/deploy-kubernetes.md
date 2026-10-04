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
