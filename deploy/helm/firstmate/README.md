# firstmate Helm chart

Installs firstmate (on its herdr session backend) and the walkie-talkie phone
companion into Kubernetes: one StatefulSet with a persistent firstmate home, a
ClusterIP Service for the walkie-talkie port, and an HTTPRoute on a Gateway API
Gateway. TLS terminates at the Gateway; an optional cert-manager Certificate
covers in-namespace termination.

Full documentation, prerequisites, credentials, and the atus example live in
[`docs/deploy-kubernetes.md`](../../../docs/deploy-kubernetes.md).
The [documentation index](../../../docs/README.md) includes user/admin guides
and [operations](../../../docs/operations.md) procedures. The atus values
enable the gateway; its OAuth App and dedicated gateway Secret must already
be configured. Routine upgrades preserve the static bearer. A fresh install
generates it when none is supplied.

```sh
helm upgrade --install firstmate deploy/helm/firstmate \
  --namespace firstmate --create-namespace \
  -f deploy/helm/firstmate/examples/values-atus.yaml
```

The firstmate runtime image is built from
[`deploy/kubernetes/firstmate`](../../kubernetes/firstmate). The walkie-talkie
image is built from the repository-root `Dockerfile`.

See [`values.yaml`](values.yaml) for every setting: images, the firstmate home
path, `storageClass` (empty by default; the atus example sets `beta3`), storage
size, resources, `httpRoute` parentRefs and hostnames, TLS, and the credential
Secret.

At container start the firstmate container seeds its home, runs the herdr
headless server, and starts the primary harness inside the session from
`firstmate.harnessCommand` (default the image's opencode harness, opened with
firstmate's session-start prompt so it starts firstmate rather than idling, with
firstmate's tracked session-start plugin removed so that prompt is its only
delivery); it restarts the harness in the same pane when it exits, so the pod
keeps a live firstmate draining queued instructions. The harness reads its
provider credentials from the container environment, which the chart fills from
`credentials.create.harness` or `credentials.keys.harness` (for opencode, e.g.
`DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY`; for Claude, `ANTHROPIC_API_KEY`).

`agents` is an optional, values-driven description of the harnesses,
provider/model catalog (including a local OpenAI-compatible endpoint), and
per-task dispatch defaults the deployment may use. When enabled, the chart
renders it into a ConfigMap mounted on the firstmate home, so adding or removing
an agent is a values change rather than an image rebuild. See
[`docs/deploy-kubernetes.md`](../../../docs/deploy-kubernetes.md).

Harness/model credentials (`credentials.create.harness` / `credentials.keys.harness`)
may not use the reserved names the chart manages for itself — the
`credentials.keys.walkieTalkieToken` and `credentials.keys.githubToken` key
names and the `GH_TOKEN`/`GITHUB_TOKEN` env names. A collision fails the render
rather than silently overwriting the built-in credential.

`gateway` (off by default) adds walkie-talkie's multi-user gateway as its own
Deployment in front of the firstmate pod: GitHub sign-in, invite-only access, and
per-user routing. The firstmate pod becomes a static tenant that only the gateway
may reach, and the HTTPRoute moves to the gateway. The StatefulSet itself is
unchanged. Gateway secret values are accepted only as Secret references, and
an inline gateway secret value fails the render. See "Multi-user gateway" in
[`docs/deploy-kubernetes.md`](../../../docs/deploy-kubernetes.md) for the GitHub
OAuth App, the Doppler keys, the cutover and rollback.
