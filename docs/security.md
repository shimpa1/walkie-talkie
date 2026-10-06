# Security

This describes implemented boundaries and their limits. See
[operations](operations.md) for secret sources, rotations and the network-policy
enablement gate. Atus's managed provisioning is off because its egress
isolation check failed; the chart's intended policies are not evidence of
effective cluster isolation.

## Threat model and trust

The public gateway faces unauthenticated requests, cross-site requests,
guessed link codes, and authenticated users who might try to reach another
tenant. Managed coding agents must also be treated as capable of executing
arbitrary code in their own tenant: repository content or an instruction may
cause unintended commands or attempts to access network services.

The operator controls images, chart values, catalog validation hosts, secret
manager, TLS edge, storage and Kubernetes policies. The gateway process can
decrypt users' stored credentials and, with provisioning enabled, manage their
workloads. A compromise of the gateway, its vault keyring plus database, the
cluster/node, or the secret-manager account crosses these trust boundaries.
The Admin UI's lack of a key-read route does not protect against an operator
with those privileges.

GitHub supplies identity; provider APIs validate keys; browser push endpoints
deliver notifications. The browser supplies speech recognition. These external
services and the signed-in device are part of the operational trust model.
TLS ends at the reverse proxy/Gateway; default in-cluster upstream and
credential delivery URLs use HTTP, so privileged cluster/network access remains
trusted. This implementation does not add service-to-service mTLS.

## Authentication and request boundaries

- OAuth uses authorization code, state and PKCE S256. A login attempt expires
  in 10 minutes and is consumed once. No scopes are requested. The returned
  GitHub token is used only for the public `/user` profile read, then discarded;
  it is not a runtime PAT or repository authorization.
- Admitted accounts are pinned to immutable numeric GitHub ids. Invitations
  initially match a login, then pin the id on redemption. Declared ids,
  invitations or approved requests grant access; sign-in alone does not.
- The session cookie is `__Host-wt_session`, Secure, HttpOnly, SameSite=Lax,
  Path `/`, with no Domain. The short-lived login cookie uses the same posture.
  Only session hashes are stored. Sessions expire after 30 idle days or 90
  absolute days, and revocation is checked on later requests.
- Cookie-authenticated writes must present the configured exact Origin, or
  when Origin is absent, `Sec-Fetch-Site: same-origin`. Link redemption also
  checks same-origin to prevent signing a victim into an attacker's account.
- Link codes contain eight unambiguous characters (40 bits), are hashed in
  storage, expire after five minutes, work once, and are replaced on reissue.
  Sign-in and redemption have per-client/global rate limits. Correct trusted
  proxy-hop configuration matters for effective per-client limits.
- The optional legacy bearer maps only to the first configured admin's
  firstmate proxy identity, not to a full admin session. Account/admin/setup
  routes always require a real session. Retire the bridge after devices
  migrate: anyone holding that shared bearer can still use its allowed
  firstmate APIs while the bridge is on.
- Bearer comparisons use constant-time comparison over SHA-256 digests.
  Gateway upstream selection is derived only from the account. Browser
  headers, paths and queries cannot choose another tenant.

The gateway serves static assets, `/healthz` and `/auth/session` publicly.
Firstmate API routes need a session or enabled bridge, including health and
push config. In standalone mode, `/api/health` and `/api/push/config` are public;
other API routes use the bearer. Static assets are public in both modes.

The proxy allowlist limits paths, methods and request sizes. It strips Cookie,
Authorization, forwarding and hop-by-hop headers before adding the tenant
bearer. It copies only content type/length from upstream responses, preventing
an upstream from setting cookies on the gateway origin. It sends API responses
with `no-store`. `/api/push/notify` is not on the browser proxy allowlist.
Bodies pass through without being logged or persisted by the gateway, but
note text is stored by the destination firstmate's intake.

## Credential vault and delivery

Provider keys and optional user GitHub PATs are checked once at entry against
the catalog's HTTPS validation URL. Users cannot supply that URL. Redirects
are never followed; validation has a 10-second timeout and bounded response
reading. Raw provider responses are never returned or logged, since they can
echo keys. Checks are limited to 10/minute/user and 60/minute overall.

Each saved credential is AES-256-GCM encrypted with a fresh 96-bit nonce and
128-bit authentication tag. Authenticated data binds owner id, credential slot
name and key id, so copying a row across users/slots or relabeling its key id
fails to decrypt. The keyring holds 32-byte keys and lives only in the gateway
environment. The database holds the encrypted envelope and its key id.
The public credential API returns metadata only: no value, prefix, suffix or
hash, including to the owner and admins.

Decryption occurs for internal delivery and re-seal/rotation. Delivery uses
only the tenant id authenticated inside its `<tid>.<HMAC>` token and requires
an active owner and desired running tenant. It returns the selected provider
key and optional GitHub token (under each declared GitHub environment name),
not all saved provider keys. It refuses missing keys, is rate-limited to
10/minute/tenant, is `no-store`, and records tenant id/count only.

The master derives separate API and credential tokens with HMAC-SHA-256 and
distinct labels. A token for one id does not authorize another. Managed
Kubernetes Secrets contain those internal tokens; provider keys and PATs are
not placed in tenant Secrets/ConfigMaps. At startup the runtime sends its
credential token to curl on stdin rather than argv, follows no redirects,
exports only allowlisted variable names, and refuses a delivery without the
required provider key before becoming ready.

Credentials still exist in process memory and runtime environment. JavaScript
buffer wiping is best effort; strings/temporary copies cannot be reliably
erased. Same-uid processes in a tenant may inspect the initial credential-token
environment (`/proc/1/environ`) and obtain that tenant's own keys. Coding agents
can read/use their own provider keys and PATs and may write sensitive files to
their own home. Vault encryption is not a promise that runtime credentials or
all home contents are encrypted. Use tokens with the repository access you
intend to give that runtime.

## Tenant and Kubernetes isolation

Static tenants are operator-run standalone upstreams. The gateway has no home
mount and only routes to them. Under enabled chart gateway policies, the static
sidecar's port accepts only release-namespace gateway pods. Keep it off any
other public route to avoid bypassing gateway account controls.

Managed tenants use individual StatefulSets, token Secrets, agents ConfigMaps,
Services and home PVCs in a separate namespace. They have opaque ids rather
than login-derived names. Pods run non-root (default uid/gid/fsGroup 1000),
with no privilege escalation, dropped capabilities and RuntimeDefault seccomp
on every container including init. They mount no ServiceAccount token and
disable service-link variables. The namespace enforces/audits/warns at Pod
Security `restricted`; quota and limit range bound tenant resources.

The gateway defaults to a non-root container with read-only root filesystem
and one persistent data mount. It has no API token/Role when provisioning is
off. When on, its Role is restricted to the tenant namespace: StatefulSet,
Service, Secret and ConfigMap CRUD; pod reads; PVC reads/deletes. No exec,
attach, port-forward, pod logs, RBAC or cluster-scoped permissions are granted.
This limits direct API authority but a compromised gateway with workload
write permissions can still alter tenant workloads and reach their data.

The intended network boundary is default-deny ingress/egress in the tenant
namespace, then explicit permits for gateway → sidecar, tenant → gateway
internal credentials, DNS, and internet TCP 443/80/22 excluding configured
private, CGNAT, link-local and loopback ranges (plus IPv6 exclusions). Add
cluster ranges not covered by those exclusions. DNS extra CIDRs permit only
UDP/TCP 53. The gateway policy itself restricts ingress; it does not restrict
gateway egress, which is needed for GitHub, validation, upstreams and the API.

Enforcement depends on the CNI, policy tiers/global rules, other additive
policies and network addressing. Atus's unconditional Calico global Allow
defeats tenant egress deny; tenants must remain disabled until remediation and
measured tests pass. Pods share cluster infrastructure and usually nodes;
this is Kubernetes process/network isolation, not VM isolation or a separate
kernel for each user. Same-pod/shared-home components are one trust domain.

## Reads, browser data and notifications

Standalone firstmate invocations use `execFile` with argument arrays and
`shell: false`. Notes go on stdin with validated request ids/context. The
sidecar's herdr client rejects all commands outside its read-only allowlist.
OpenCode history uses read-only SQLite plus `query_only` and parameterized,
bounded queries. The runtime's supervisor has its own lifecycle duties; the
sidecar's read-only boundary does not describe the runtime's capabilities.

The browser renders conversation text as text rather than trusted HTML.
Standalone/legacy bearers are in localStorage, so device/browser compromise
or same-origin script compromise can expose them. HttpOnly sessions reduce
direct script token access but do not stop compromised same-origin code from
acting through the user's session. Keep assets, dependencies and TLS origin
under operator control.

The service worker caches shell assets and excludes API/auth paths. An offline
shell is not an encrypted offline conversation store. Unsent composer text
exists only in the page; automatic update reloads are suppressed while it
could be lost.

Each firstmate's VAPID private key and subscriptions live in its owner-only
push JSON file, not the gateway store. The public VAPID key is not a secret.
Web Push sends encrypted payloads through the browser vendor's push service;
there is no extra hosted walkie-talkie push account. Fleet notices use fixed
event text/deep links, not note bodies. Admin access-request notices include
the requesting GitHub login. Authenticated `/api/push/notify` supports bounded
custom notice text, so the fixed fleet-notice rule is not a restriction on
all possible notices. Lock-screen display can reveal notice text. Revoking
a remote session does not automatically erase its stored push subscription.

## What never goes where

| Material | Keep it out of |
| --- | --- |
| OAuth client secret, vault keyring, tenant-token master | `walkie-talkie/prd`, `firstmate-doppler-secrets`, firstmate/tenant environment, images, values files, ConfigMaps, commits and logs |
| User provider keys/PATs | Tenant Kubernetes Secrets/ConfigMaps, public credential responses, catalogs, notification payloads, request/provider-response logs |
| Browser session ids, OAuth codes/tokens, link codes | Logs, audit details, URLs copied into reports; raw link code appears only when intentionally issued to the device |
| Internal tokens / VAPID private keys | Public pages, tickets, documentation, image layers, repository files |
| Database/home backups | Public storage, repository checkout, unprotected shared directories |

Put gateway secrets only in Doppler `walkie-talkie/gateway` and its dedicated
Secret, then inject only into the gateway. Keep static provider/PAT secrets
in their separate configuration; keep each user's keys in the vault and own
runtime. New key ids, variable names, client ids and Secret names are suitable
for reviewed values. Secret values are not.

Deletion and `secure_delete` do not erase backups, SQLite WAL history,
storage snapshots or files a runtime wrote. Claim purge depends on storage
reclaim policy; retained audit metadata survives account removal. Backups and
vault key retention must follow the operator's recovery and disposal policy.
