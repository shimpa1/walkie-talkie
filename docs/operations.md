# Operations

This guide covers operating the current service. Use the
[Kubernetes installation guide](deploy-kubernetes.md) for the full initial
chart install, runtime build arguments, Gateway API/TLS prerequisites, and
static firstmate agent configuration. The [repository README](../README.md)
owns local, Docker Compose, systemd, Caddy and Tailscale installation.
Read [security](security.md) before changing isolation or credential wiring.

Examples below assume release/namespace `firstmate` and the committed atus
values. For another cluster, use its own reviewed values file and names.
Commands here are procedures for an authorized operator; reading this guide
does not require changing a live cluster.

## Deployment and upgrade procedure

The chart deploys a static firstmate StatefulSet and its sidecar. Enabling
`gateway.enabled` adds a separate gateway Deployment and changes the HTTPRoute
backend to its Service. Enabling `tenants.enabled` is a further, separate
decision that adds a tenant namespace and gives the reconciler permissions.

1. Confirm which image/component needs changing. The static runtime,
   static sidecar, gateway, and managed runtime can use different tags. Atus
   deliberately keeps its static workload on older images. Do not infer a
   deployed capability from repository main alone.
2. Run repository checks in a development checkout:

   ```sh
   npm ci
   npm test
   npm run typecheck
   ```

3. Build changed images with immutable tags and publish them to your registry.
   For example, from the commit to be deployed:

   ```sh
   WT_BUILD_TAG=$(git rev-parse --short=12 HEAD)
   docker buildx build --platform linux/amd64 \
     -t "registry.example.com/walkie-talkie:$WT_BUILD_TAG" --push .
   docker buildx build --platform linux/amd64 \
     -t "registry.example.com/firstmate-runtime:$WT_BUILD_TAG" --push \
     deploy/kubernetes/firstmate
   ```

   Build the runtime only when it needs changing. Review its pinned upstream
   versions/build arguments in the [installation guide](deploy-kubernetes.md#build-and-push-the-images).
   Managed runtime images must include credential fetch and readiness support.
4. Update the relevant image tags and non-secret values through review. For
   a new gateway, complete OAuth registration and secret sync before enabling
   it. For provisioning, complete the prerequisites below first.
5. Validate the chart. Rendering can contain the static credential Secret;
   discard output or protect it as secret material rather than committing it:

   ```sh
   helm lint deploy/helm/firstmate \
     -f deploy/helm/firstmate/examples/values-atus.yaml
   helm template firstmate deploy/helm/firstmate -n firstmate \
     -f deploy/helm/firstmate/examples/values-atus.yaml > /dev/null
   ```

   Offline rendering does not prove existing secrets or volumes are available.
   Helm's live Secret lookup preserves chart-created credentials during an
   upgrade; offline template output is not a backup of those credentials.
6. Record current image tags, Helm revision, and backup/snapshot references:

   ```sh
   helm history firstmate -n firstmate
   kubectl -n firstmate get deployment,statefulset,pod,pvc
   ```

7. Deploy the reviewed values, without re-supplying credentials on a routine
   atus upgrade:

   ```sh
   helm upgrade --install firstmate deploy/helm/firstmate \
     -n firstmate --create-namespace \
     -f deploy/helm/firstmate/examples/values-atus.yaml --wait --timeout 10m
   ```

8. Check the rollout and public service, then sign in from a browser:

   ```sh
   kubectl -n firstmate rollout status deployment/firstmate-gateway
   kubectl -n firstmate rollout status statefulset/firstmate
   kubectl -n firstmate get httproute
   curl --fail --silent --show-error https://walkie-talkie.atus.hr/healthz
   curl --fail --silent --show-error https://walkie-talkie.atus.hr/auth/session
   ```

   `/healthz` should return `{"ok":true}`. `/auth/session` should report
   gateway mode; an unauthenticated curl has no signed-in user. Neither proves
   the upstream firstmate works. Check Status, Conversations, a test note and
   its receipt, and notification subscription from an authenticated device.
   Use the [verification procedure](deploy-kubernetes.md#verification) for
   firstmate details. Only send a test note when authorized to add it to intake.

The gateway uses `Recreate`: upgrades briefly stop the public front door before
starting its replacement on the same store. A gateway image/catalog change
does not by itself roll the static firstmate. Static image/agents changes
roll the StatefulSet; tenant parameter changes restart the gateway and its
reconciler updates managed tenants. Work in flight can be interrupted by
runtime rolls. Plan key, model, image and token changes accordingly.

## Configuration reference

Defaults live in [values.yaml](../deploy/helm/firstmate/values.yaml), constraints
in [values.schema.json](../deploy/helm/firstmate/values.schema.json), and rendering
in [templates](../deploy/helm/firstmate/templates). The
[installation values table](deploy-kubernetes.md#values) covers the static
workload. These are the settings most relevant to operating all three modes:

| Values | Operational effect |
| --- | --- |
| `firstmate.image`, `walkieTalkie.image` | Static runtime and sidecar; pin usable tags |
| `firstmate.home`, `.herdrSession`, `.harnessCommand` | Static home's paths, session name and primary launch command |
| `walkieTalkie.herdrCLI.enabled` | Copies the runtime's CLI for live sessions; atus sets true |
| `walkieTalkie.extraEnv` | Static sidecar overrides, including a writable/persistent `FM_WT_PUSH_STORE` path |
| `agents.enabled`, `.harnesses`, `.providers`, `.dispatch` | Static tenant's harness/model configuration; independent of managed catalog |
| `persistence.enabled`, `.storageClass`, `.size` | Static home claim; atus uses `beta3`, 20Gi |
| `httpRoute.parentRefs`, `.hostnames`, `.redirect`, `certificate.*` | Public routing/TLS; atus uses the existing wildcard listener and no chart Certificate |
| `credentials.existingSecret`, `.keys.*`, `.githubTokenEnabled` | Static bearer/harness/GitHub sources; atus obtains provider keys and PAT from Doppler separately |
| `firstmate.extraEnvFrom`, `.extraEnv` | Extra static environment; never point these at gateway secrets |
| `gateway.enabled` | Default false; atus true. Public HTTPRoute backend becomes gateway |
| `gateway.image.repository`, `.tag` | Empty fields fall back to static sidecar image; atus explicitly pins a newer gateway image |
| `gateway.publicOrigin` | HTTPS origin for OAuth/CSRF; empty derives from first HTTPRoute hostname |
| `gateway.githubClientId`, `.admins` | Public client id and required list of immutable numeric admin ids |
| `gateway.accessRequests.enabled` | Default true; false refuses uninvited identities without creating requests |
| `gateway.staticTenants` | Numeric owner id, upstream origin, Secret reference; no inline bearer |
| `gateway.legacyBearer.enabled`, `.tokenSecretRef` | Default false; atus true during migration. Empty reference falls back to the static chart credential |
| `gateway.secrets.existingSecret`, `.keys.*` | Required references for OAuth client secret, vault keyring and tenant-token master |
| `gateway.secrets.rotation` | New string rolls gateway onto changed secret environment |
| `gateway.vault.activeKey` | Default `k1`; key id used for new writes and startup re-seal |
| `gateway.trustedProxyHops` | Chart default 1; environment-only default 0. Must match the actual trusted forwarding chain |
| `gateway.port`, `.internalPort`, `.service.*` | Default public 8787 and internal 8788; keep listener/Service ports aligned and internal off HTTPRoute |
| `gateway.persistence.*` | Enabled by default, 1Gi RWO; atus `beta3`. Disabling uses ephemeral `emptyDir` and loses state on pod replacement |
| `gateway.networkPolicy.enabled`, `networkPolicy.gatewayNamespace` | Gateway/static ingress restrictions; namespace defaults from HTTPRoute parentRef |
| `gateway.resources`, `.podSecurityContext`, `.securityContext`, scheduling fields | Gateway resources and pod posture; default non-root, read-only root filesystem |
| `gateway.tenantNamespace` | Default `firstmate-tenants`; tenant namespace and internal ingress selector |
| `tenants.enabled` | Default false; requires gateway and gateway policy enabled |
| `tenants.maxTenants`, `.purgeAfterDays` | Default 5 slots, 30-day removed-home grace; 0 means eligible at next sweep |
| `tenants.image.firstmate`, `.walkieTalkie` | Fall back to static runtime and gateway images respectively; managed tags cannot be `latest` |
| `tenants.imagePullSecrets` | Names of pull secrets that must already exist in tenant namespace |
| `tenants.harnessCommand` | Falls back to static harness command; runtime must contain that harness |
| `tenants.resources.{firstmate,walkieTalkie,init}` | Per-tenant resources and namespace quota arithmetic; CPU in cores or `m`, memory in `Mi`/`Gi`/`Ti` |
| `tenants.persistence.storageClass`, `.size` | Default class, 10Gi. Existing StatefulSets keep immutable claim templates; changes apply to new tenants |
| `tenants.securityContext.{runAsUser,runAsGroup,fsGroup}` | Default 1000; other tenant restrictions are fixed by builder |
| `tenants.nodeSelector`, `.tolerations`, `.affinity`, `.priorityClassName` | Tenant scheduling |
| `tenants.networkPolicy.*` | Allowed egress ports, private/cluster range exclusions, DNS selectors and extra DNS CIDRs |
| `tenants.catalog` | Allowed harnesses, providers, model ids, key variable names, validation URLs and optional GitHub token |

Outside Helm, environment overrides the gitignored JSON config. See the full
[standalone table](../README.md#configuration) and
[gateway table](../README.md#multi-user-gateway). Important chart mappings are:

| Runtime setting | Chart source |
| --- | --- |
| `FM_WT_MODE` | Gateway Deployment sets `gateway`; sidecars default to standalone |
| `FM_WT_PUBLIC_ORIGIN`, `FM_WT_GITHUB_CLIENT_ID`, `FM_WT_ADMINS` | Origin, client id and admins values |
| `FM_WT_GATEWAY_DB` | `/data/walkie-talkie.gateway.db` |
| `FM_WT_CATALOG` | `/etc/walkie-talkie/tenant-params/catalog.json` |
| `FM_WT_TENANT_PARAMS` | `/etc/walkie-talkie/tenant-params/tenants.json`, only with provisioning |
| `FM_WT_INTERNAL_PORT` | `gateway.internalPort`, only with provisioning |
| `FM_WT_VAULT_ACTIVE_KEY` | `gateway.vault.activeKey` |
| `FM_WT_STATIC_TENANTS` | Entries whose `tokenEnv` names generated Secret-backed environment variables |
| `FM_WT_TOKEN` | Static/managed sidecar bearer; on gateway only for enabled bridge |
| `FM_WT_PUSH_STORE` | Managed sidecar sets `$FM_HOME/.walkie-talkie/push.json`; static chart leaves default unless `walkieTalkie.extraEnv` overrides it |

The ConfigMap is named `firstmate-tenant-params`: it always has `catalog.json`
with the gateway, and adds `tenants.json` only with provisioning. A checksum
annotation rolls the gateway when those settings change. Catalog URLs must
be HTTPS; keys cannot be embedded in the catalog. Key checks follow no
redirects and send a key only to its configured validation origin. Pin model
ids to the actual provider menu you intend to offer; the committed catalog is
not an automatic live model discovery feed.

## OAuth registration and secrets

In GitHub's OAuth App form use the **Redirect URI** field (older instructions
call it Authorization callback URL). For atus set exactly:

```text
https://walkie-talkie.atus.hr/auth/github/callback
```

Use homepage `https://walkie-talkie.atus.hr`, wildcard matching **off**, device
flow **off**, and expiring user tokens **on**. These are OAuth App registration
settings, not Helm values. The gateway derives the redirect from
`gateway.publicOrigin` and requests no scopes. It consumes the access token
for one public-profile read and stores no OAuth token or refresh token.
Copy the public client id into values; put the client secret only in the
gateway secret manager configuration.

| Source on atus | Kubernetes destination | Consumer / mapping |
| --- | --- | --- |
| Doppler `walkie-talkie/prd` via `doppler-firstmate` | `firstmate-doppler-secrets` | Static firstmate `envFrom`: provider keys and `GH_TOKEN`; extra mapping exposes that PAT as `GITHUB_TOKEN` |
| Doppler `walkie-talkie/gateway` via `doppler-firstmate-gateway` | `firstmate-gateway-secrets` | Gateway only, individual `secretKeyRef` entries below |
| Gateway Doppler `WT_GITHUB_CLIENT_SECRET` | Same key in gateway Secret | `FM_WT_GITHUB_CLIENT_SECRET` |
| Gateway Doppler `WT_VAULT_KEYS` | Same key in gateway Secret | `FM_WT_VAULT_KEYS` |
| Gateway Doppler `WT_TENANT_TOKEN_SECRET` | Same key in gateway Secret | `FM_WT_TENANT_TOKEN_SECRET` |
| Out-of-band gateway config sync token | `doppler-token-gateway` | Doppler operator; scoped to gateway config |
| Chart-created static bearer | `firstmate-credentials`, key `walkie-talkie-token` | Static sidecar, configured static upstream reference, enabled legacy bridge |
| User-entered provider/PAT | Encrypted rows in gateway DB | Only selected provider key and optional GitHub token delivered to that user's runtime |
| Derived managed internal tokens | `fm-<tid>-tokens`, keys `api`, `credentials` | Tenant sidecar and runtime; not provider keys |

The gateway Doppler config is a separate root `gateway` environment/config,
not a `prd_gateway` branch inheriting `prd`. Its DopplerSecret declaration
lives in the atus deployment repository, not this chart. All three gateway
Secret keys are required when the chart gateway is on, including the master
while managed provisioning is off. Missing keys leave the pod in
`CreateContainerConfigError`.

Never put gateway secrets into `walkie-talkie/prd`,
`firstmate-doppler-secrets`, firstmate `extraEnvFrom`, or tenant environment
configuration. The static agent would receive them. Gateway values accept
references only and reject inline secret fields even when disabled.
The static `credentials.create.*` interface does accept values; those are
stored in Helm release data as well as the created Secret. Prefer an external
secret manager, and never commit real credentials.

## Rotation procedures

Environment-backed secrets do not change inside a running process when the
operator updates the Kubernetes Secret. Sync the secret first, then deploy
a values change that rolls every affected consumer.

**Gateway OAuth client secret.** Generate the replacement in GitHub, save it
as `WT_GITHUB_CLIENT_SECRET` in the gateway config, wait for sync, and bump
`gateway.secrets.rotation` to a new non-secret string. Verify a fresh sign-in
before revoking the old secret where overlap is available. Existing app
sessions are independent of the OAuth client secret.

**Vault encryption key.** Generate a fresh 32-byte key in a secure operator
session (`openssl rand -base64 32`). Keep its output out of tickets and commits.

1. Add it to `WT_VAULT_KEYS`, retaining old entries: the format is
   `k1:<existing base64>,k2:<new base64>`.
2. After secret sync, deploy `gateway.vault.activeKey: k2`. This changes the
   gateway pod environment and restarts it.
3. Check gateway logs for a successful startup re-seal and the
   `vault.resealed` audit record when older rows existed. It is all-or-nothing:
   an unopenable row leaves all rows unchanged and logs a failure, while the
   gateway continues running. A Ready pod alone does not prove re-seal success.
4. Only after confirming success, remove the old entry from Doppler and bump
   `gateway.secrets.rotation` to load the shorter keyring. Retain old key
   material securely if older encrypted database backups still need recovery.

If re-seal fails, restore the missing old key and roll the gateway, then verify
again. The recovery CLI `node dist/src/index.js vault rotate` uses the same
database/keyring and prints counts/ids only. It re-seals transactionally but
does not emit the startup `vault.resealed` audit action. Do not remove a key
merely because a deployment succeeded.

**Tenant-token master.** Generate a new random master
(`openssl rand -base64 32`), change `WT_TENANT_TOKEN_SECRET`, wait for sync,
and bump `gateway.secrets.rotation`. The new master derives new API and
credential tokens for every managed tenant. Reconciliation updates Secrets
and the `walkie-talkie.atus.hr/token-epoch` pod annotation, rolling each tenant
once. Expect temporary `502` responses until sidecars accept the new token
and runtimes fetch credentials. There is no old-master overlap keyring.
Static tenants are unaffected by this master. With provisioning off, no
managed pods are rolled.

**Static upstream bearer / legacy token.** Keep the static sidecar and every
gateway reference to it synchronized. In chart-created mode a deliberately
supplied new `credentials.create.walkieTalkieToken` on upgrade changes the
Secret and checksum annotations for both workloads. In existing/external
Secret mode, updating the value does not itself roll either workload: deploy
a changed static `podAnnotations` value and `gateway.secrets.rotation` to
restart both. While the bridge is enabled, old phones need the replacement
bearer unless they sign in. After migration, phones use their sessions and
need no internal bearer update. See the
[credential preservation details](deploy-kubernetes.md#credentials).

**User provider key or PAT.** Replace it in Setup. Only a credential currently
delivered to a tenant changes its config version and rolls its pod. Removing
the selected provider key stops the tenant. Removing the optional GitHub token
rolls it without that token. The OAuth sign-in credential is separate.

**VAPID keys.** Keep the per-firstmate push store across upgrades. Rotating
the VAPID pair changes the subscription's application server key; devices need
to unsubscribe/resubscribe. Supply both environment keys together when
overriding generation; never expose the private key. Signed-in devices check
their subscription against the current firstmate key on load/linking. Use
Settings Disable/Enable and Send test to verify delivery after a planned change.

## Enabling managed firstmates

Atus must keep `tenants.enabled: false` until its egress policy failure is
remedied and retested. The recorded check found Calico v3.30 ingress working,
but `akash-guard-threatintel-egress-deny` ends in unconditional `Allow`, letting
test tenants reach the Kubernetes API and other pods despite default-deny.
Installing Calico alone is not proof that namespace isolation works.

Before enabling:

1. Keep the gateway enabled with persistent store, correct OAuth, catalog,
   vault and master Secret keys. Review existing admitted users/invites:
   capacity enforcement starts applying once provisioning is enabled.
2. Pin a runtime with the credential fetch contract. Atus's static runtime
   `6eb5b4543933` predates that support. The committed managed-runtime override
   is `b9c3cf045ff9`; confirm image availability for the cluster architecture.
   The managed sidecar defaults to the gateway image, not the old static one.
3. Choose storage, resources, quota, limit range and scheduling; create any
   pull secrets in the tenant namespace. Review `maxTenants` and purge grace.
4. Keep `gateway.networkPolicy.enabled: true`. Verify actual ingress and
   egress behavior in approved disposable test namespaces using the chart's
   policies. Do not use real tenant credentials for connectivity tests.
5. Include pod/service CIDRs outside the default excluded ranges in
   `tenants.networkPolicy.extraExcludeCidrs`. Review IPv6 ranges too. Add
   node-local DNS only via `dns.extraCidrs` (atus `169.254.25.10/32`, port 53).
6. Inspect global CNI policies and any other allow policies that can broaden
   the namespace rules. These inspection commands change nothing:

   ```sh
   kubectl -n kube-system get daemonsets
   kubectl get globalnetworkpolicies.crd.projectcalico.org
   kubectl get networkpolicies -A
   ```

   The Calico command applies to Calico clusters. On another CNI inspect its
   equivalent global/tiered policy resources. Flannel alone does not enforce
   these NetworkPolicies and is insufficient.
7. Require measured results for all of these paths:

   | Test path | Required result |
   | --- | --- |
   | Gateway → tenant sidecar | Allowed on sidecar port |
   | Tenant → own allowed DNS | UDP/TCP 53 allowed |
   | Tenant → gateway internal credential port | Allowed |
   | Non-tenant pod → gateway internal port | Denied |
   | Tenant → another tenant or static firstmate | Denied |
   | Non-gateway workload → tenant sidecar | Denied |
   | Tenant → Kubernetes API, other private workloads, metadata endpoint | Denied |
   | Tenant → permitted public provider/GitHub/registry endpoints | Allowed on configured internet ports |
   | Kubelet probes → workloads | Workloads become Ready |
   | Privileged pod in tenant namespace | Refused by restricted Pod Security admission |

8. Only after the check passes, deploy a reviewed `tenants.enabled: true`
   change. The chart refuses it unless gateway and gateway policy are on.
   With a test account, save setup, Start, confirm Ready/credential delivery,
   send a note, Stop and Start again to prove the home persists. Confirm
   suspension denies sessions and delivery before admitting more users.

The chart supplies a restricted namespace, tokenless tenant ServiceAccount,
quota/LimitRange and policies. The gateway gets a ServiceAccount token and a
Role only in that namespace: workload CRUD, read pods, and read/delete PVCs,
with no exec, logs, RBAC or cluster-scoped access. Tenants render non-root with
fixed capability/seccomp restrictions and no API token/service links.
These settings cannot compensate for a CNI/global-policy bypass.

To review generated tenant objects without printing internal tokens, with
provisioning configured run:

```sh
kubectl -n firstmate exec deployment/firstmate-gateway -- \
  node dist/src/index.js tenants render --user example-user
```

It reads the store, emits JSON documents separated as YAML, and redacts both
token Secret values and token epoch. It does not apply anything. The output
still includes account ids/logins and non-secret configuration; handle it as
operational metadata.

## Persistence, backups and rollback

The static chart mounts the firstmate home but does not override the push
store path. The repository image works in `/app`, so the default resolves to
`/app/walkie-talkie.push.json`, outside that mount. Its unprivileged user
normally cannot write that root-owned directory, causing startup to log
`push notifications disabled` and push routes to return `503`. Even with a
writable image directory, container replacement would lose that file. The
committed atus values also omit this override; do not assume the static home
PVC currently preserves push subscriptions.

For persistent static push, deploy this non-secret override, using your
actual `firstmate.home` path:

```yaml
walkieTalkie:
  extraEnv:
    - name: FM_WT_PUSH_STORE
      value: /home/firstmate/.walkie-talkie/push.json
```

Merge it with any existing extra environment entries. After the sidecar rolls,
verify write permissions and enable/test device subscriptions. Managed
sidecars already set this home-based path themselves. Compose also defaults
to `/app`; set `FM_WT_PUSH_STORE` to a writable path under its `/fm/home` mount
in a deployment override if using that mode.

Back up the static home, gateway data volume, and each managed home separately.
The gateway store is not a conversation/home backup. Homes are not an account
database backup. Include VAPID stores if notification continuity matters.
Protect copies as private data, and keep vault keys separately under the same
recovery controls. Encryption does not cover the entire database or arbitrary
files a coding agent writes in its home.

Use the storage provider's consistent snapshot procedure or SQLite's backup
interface; do not copy only the live gateway `.db` while WAL is active.
For an operator with `sqlite3` and access to the mounted store, an example
SQLite backup is:

```sh
sqlite3 /data/walkie-talkie.gateway.db \
  ".backup '/secure-backups/walkie-talkie.gateway.db'"
```

The container does not promise that operator tool or destination directory;
run it in your approved backup environment. Restore/test copies in isolation.
The code automatically migrates older schemas and refuses newer schemas.
There is no automatic database downgrade, retained-home reassignment, or
in-app restore procedure. An image rollback across a schema migration may
require a compatible backup and a coordinated data recovery plan.

**Retiring the legacy bridge:** confirm every required installed app/browser
has its own session, then deploy `gateway.legacyBearer.enabled: false`.
Keep the static upstream bearer: the gateway still needs it. Existing sessions
continue, but devices that only had the shared bearer must sign in/link.

**Returning from gateway to standalone:** set `gateway.enabled: false` and
upgrade. The route returns to `firstmate:8787`, gateway workloads/policies are
removed, and the gateway PVC is kept. A phone that signed in with GitHub has
forgotten its bearer and needs the current static token re-entered in Settings.
A phone that still holds an unchanged legacy bearer can continue.

If managed firstmates have been enabled, stop them before disabling
provisioning/gateway and review remaining resources. Set `tenants.enabled:
false` as well when turning the gateway off; the chart refuses tenants without
a gateway. Disabling the switch
does not itself ask the reconciler to scale all managed StatefulSets to zero;
they are dynamic objects, not Helm-managed tenant workloads. The kept tenant
namespace/homes require explicit operational care. Do not treat this rollback
as an automated tenant shutdown or purge.

For an image/values rollback, review `helm history` and deploy the previous
compatible tags/values, or use `helm rollback firstmate <revision> -n firstmate`
after checking schema/secret compatibility. A Helm rollback does not restore
Doppler values, an already re-encrypted database, or deleted claims. Keep
vault keys needed by the restored data. See
[uninstall](deploy-kubernetes.md#uninstall) for static-home retention; the
gateway PVC and tenant namespace have `helm.sh/resource-policy: keep`.

## Service troubleshooting

| Symptom | Check / response |
| --- | --- |
| GitHub says `The redirect_uri is not associated with this application` | In the OAuth App **Redirect URI**, enter exactly `https://walkie-talkie.atus.hr/auth/github/callback`; compare to configured public origin, client id/app, scheme, host, path and trailing slash. Keep wildcard matching off. Retry a fresh sign-in |
| Sign-in expired/failed | Restart sign-in in the same browser context. Login attempts expire in 10 minutes; inspect gateway logs for fixed GitHub exchange/profile errors and outbound HTTPS/DNS availability |
| Gateway `CreateContainerConfigError` | Check the referenced Secret exists and has all required key names, including vault/master even with provisioning off. Inspect metadata/events without dumping values |
| Gateway Ready but no firstmate | `/healthz` checks the gateway only. Check authenticated `/api/health`, static upstream/port and its bearer reference, or managed lifecycle state |
| `502` authentication/reachability | Static token mismatch, missing Service/endpoints, policy problem, tenant rollout or token-master rotation. Gateway masks upstream `401` as deployment `502` |
| `504` | Upstream exceeded the 70-second default proxy timeout; inspect firstmate readiness/script dependencies |
| `409 firstmate_not_provisioned` | User has no static tenant and no started managed firstmate; setup alone provisions nothing |
| `409 firstmate_not_running` | Response state identifies starting/stopped/crashloop. Check Setup and tenant pod events |
| `409 not_available` on Start | Provisioning is disabled; this is expected on atus |
| `409 capacity_reached` | Review users, open invites, retained homes and `maxTenants`; stopped homes still consume slots |
| Tenant pending/crashloop | Inspect scheduling, quota, PVC, pull-secret/image errors, runtime logs and credential delivery. The app's crashloop category includes image/config failures |
| Tenant waits for credentials | Check chosen key, active owner, desired running, DNS/policy to internal listener and token epoch. Runtime refuses a delivery missing its required provider key and retries before readiness |
| `key_rejected` / `provider_unreachable` | Provider rejected the key versus an unverified check (timeout, redirect, outage, other response). No replacement is stored on failed verification |
| `model_unavailable` | Catalog choice absent from key's saved complete listing. Verify catalog and refresh the key check after provider access changes |
| No Admin / Setup | Need a real session. Admin requires configured numeric id; Setup requires catalog and no static tenant |
| No admin request notification | Check admin subscriptions/running firstmate and notice-route support; old static atus sidecar returns `404`. Admin request list remains available |
| Push routes return `503` | Inspect startup for push-store write failures; configure a writable path on the home mount and roll the static sidecar |
| Live sessions missing / terminal-only history | Check shared home/session socket, CLI copy, session id mapping and OpenCode DB path; threads remain available |
| Queue waits; firstmate card says unknown | Failed live/readiness read is unknown. Check watcher beacon and herdr access; a cross-container pid alone cannot prove the agent is down |
| Health says `can_receive: true` but raw lock is `stale` with `live_harness: false` and consumer `unknown` | Expected when `diagnostic_scope` is `walkie-talkie-process-namespace`: the lock PID is not observable from this container, so the raw fields do not mean firstmate is dead. Use `can_receive`/`can_receive_basis` or `/api/firstmate`; see the [`/api/health` correction](../README.md#endpoints) for the contract |
| Purge stays pending | StatefulSet must disappear before claim deletion; check claim finalizers/CSI and gateway reconcile errors. Retained row remains until claim absence is confirmed |
| Secret changed but behavior unchanged | Secret environment is loaded at process start. Deploy the appropriate rotation/annotation change |
| Vault re-seal failure | Restore required key ids, restart and confirm successful transactional re-seal before removing old keys |

Useful read-only cluster diagnostics:

```sh
kubectl -n firstmate logs deployment/firstmate-gateway --tail=100
kubectl -n firstmate get endpointslice,pod,pvc,httproute
kubectl -n firstmate describe pod firstmate-0
kubectl -n firstmate-tenants get statefulset,pod,pvc,resourcequota,limitrange
kubectl -n firstmate-tenants get events --sort-by=.metadata.creationTimestamp
```

The tenant commands apply only where that namespace exists. Avoid pasting
logs or metadata containing private account information into public reports.
Do not dump Secret data, process environments, or credential delivery bodies
to troubleshoot authentication.

## Browser and iOS troubleshooting

**Installed app remains signed out after GitHub:** OAuth may have returned
to Safari's separate storage. Keep Safari signed in, make a code under
Settings → Link a device, and redeem it in the installed app. This is the
app's device-link flow, not GitHub device flow; keep GitHub device flow off.

**A link code fails:** it expires in five minutes, works once and is replaced
by the next generated code. Generate a new one from an active session and
redeem on the same site origin. Rate-limited attempts need a pause.

**Stale shell after a deploy:** the worker is network-first and revalidates
past the HTTP cache. Installation downloads shell assets with `cache: reload`,
activates with `skipWaiting`, deletes older caches and claims clients. API and
auth paths bypass it. On foreground return the app checks for a new worker.
A controller change reloads an already controlled page only when no unsent
text, active dictation or send would be lost. Save/copy the draft and manually
reload if the change was deferred. Close and reopen the Home Screen app if
needed. Inspect service-worker registration/network responses if repeated
reloads still show old assets; an offline shell cannot fetch a new deployment.
Shell cache version is currently `walkie-talkie-shell-v10`; deployments that
change shell assets should keep the worker/cache version coordinated.

**Status looks old after returning:** Status/Conversations stop polling while
hidden and refresh immediately when visible; persisted `pageshow` also resumes
them. Check connectivity and use Refresh. Offline shell availability does not
provide cached conversation or fleet data.

**Push unavailable on iPhone:** use the installed Home Screen app on the
documented iOS/iPadOS 16.4+ path, accept notification permission from a user
action, and check OS notification settings. Use Disable/Enable after a
VAPID/account change. Safari sign-in alone does not create a session in every
installed app.

**Microphone hidden or blocked:** recognition availability is detected at
runtime. Check the browser API and microphone permission; use keyboard
dictation or typing when unavailable. walkie-talkie receives text, not audio.
