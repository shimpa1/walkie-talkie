# firstmate Helm chart

Installs firstmate (on its herdr session backend) and the walkie-talkie phone
companion into Kubernetes: one StatefulSet with a persistent firstmate home, a
ClusterIP Service for the walkie-talkie port, and an HTTPRoute on a Gateway API
Gateway. TLS terminates at the Gateway; an optional cert-manager Certificate
covers in-namespace termination.

Full documentation, prerequisites, credentials, and the atus example live in
[`docs/deploy-kubernetes.md`](../../../docs/deploy-kubernetes.md).

```sh
helm upgrade --install firstmate deploy/helm/firstmate \
  --namespace firstmate --create-namespace \
  -f deploy/helm/firstmate/examples/values-atus.yaml \
  --set credentials.create.walkieTalkieToken="$(openssl rand -hex 32)"
```

The firstmate runtime image is built from
[`deploy/kubernetes/firstmate`](../../kubernetes/firstmate). The walkie-talkie
image is built from the repository-root `Dockerfile` provided by the sibling
Docker/Compose deploy slice, which is a prerequisite (merge it first).

See [`values.yaml`](values.yaml) for every setting: images, the firstmate home
path, `storageClass` (empty by default; the atus example sets `beta3`), storage
size, resources, `httpRoute` parentRefs and hostnames, TLS, and the credential
Secret.

Harness/model credentials (`credentials.create.harness` / `credentials.keys.harness`)
may not use the reserved names the chart manages for itself — the
`credentials.keys.walkieTalkieToken` and `credentials.keys.githubToken` key
names and the `GH_TOKEN`/`GITHUB_TOKEN` env names. A collision fails the render
rather than silently overwriting the built-in credential.
