# Admin guide

Admins manage access in the **Admin** tab after signing in with GitHub.
Admin authority comes only from numeric ids in `gateway.admins` (or
`FM_WT_ADMINS` outside Helm). The interface cannot grant admin status.
The legacy bearer bridge cannot access admin routes.

The page shows requests, open invites, users and, when provisioning is enabled,
removed users' retained homes. It shows account and lifecycle metadata, never
another user's conversations, provider keys, GitHub token, or home contents.
Current atus enables access administration but keeps managed provisioning off.
See [operations](operations.md) before changing deployment-level controls.

## Invite and approve

Enter a GitHub login under **Invite a GitHub account**. An optional leading
`@` is accepted; matching is case-insensitive. The invite is a permission for
that login, not a secret invitation URL. Tell the person to open the site and
sign in with that GitHub account.

Open invites expire after 14 days. Inviting the same open login extends its
expiry. **Revoke** prevents an unused invitation from being redeemed. An
existing account does not need another invitation. First redemption pins the
immutable GitHub numeric id; a subsequent owner of the old login does not
inherit the admitted account.

With `gateway.accessRequests.enabled: true`, an uninvited successful GitHub
identity check records a request instead of issuing a session. There are at
most 50 pending requests; unanswered requests expire after 30 days.
**Approve** creates the active user, whose next sign-in gets in. **Deny** is
remembered for 30 days, preventing immediate repeat requests. A pending request
does not reserve a tenant slot. Turning requests off refuses uninvited
sign-ins; it still records a refusal audit entry, but no access request.

A new request triggers a best-effort push to each admin's own firstmate.
Repeat sign-ins while pending do not trigger another notice. Notices are
limited to 10 per minute overall. An admin needs a static firstmate or a
running managed firstmate with subscribed devices, and its sidecar must
support `POST /api/push/notify`. Atus's pinned static sidecar predates this
route, so access requests remain visible in Admin but push notices to that
static tenant return `404`. The gateway logs the delivery status without
failing the request. Opening Admin is the reliable way to check the queue.

## Suspend, resume and remove

**Suspend** keeps an account but deletes its sessions and link codes, refusing
future sign-ins. If the user has a managed firstmate, credential delivery is
refused and reconciliation scales it to zero. This does not change its saved
desired state, credentials, model choice, or home.

**Resume** makes the account active again. The user must sign in again because
old sessions were deleted. A firstmate previously desired running is restored;
one explicitly stopped stays stopped. Suspension and stop still take effect
even if the saved model has since left the catalog.

**Remove** deletes the account and cascades its sessions, link codes, saved
credentials, model choice, and tenant row. Reconciliation prunes managed
workload objects. The user needs a new invitation or approval to return and
does not automatically regain the old home. A started tenant's home is tracked
as retained for recovery; a user who never started has no retained tenant.
Removal does not erase old audit records.

The UI asks for a second tap before removal; Suspend takes effect on one tap.
The API refuses suspending or removing yourself and accounts declared in
configuration (admins or static
tenant owners). Change those declarations through the deployment process.
Removing an id from configuration does not itself delete a previously created
database account; review its account and access separately.

## Retained homes and purge

**Removed users' homes** is available only when provisioning is enabled.
It shows the previous login (or tenant id), removal time, and scheduled purge
time. The retained API also returns the tenant id used for confirmation.
The default grace is `tenants.purgeAfterDays: 30`. A value of `0` makes the
home eligible at the next sweep. The retained volume continues to occupy a
slot until the reconciler confirms the claim is gone.

**Purge now** requires two taps. It sends the exact tenant id again as
confirmation, marks the home for deletion, and kicks reconciliation. This is
irreversible through the app. Take any necessary recovery snapshot before
requesting purge. There is no home-restore or reassignment UI.

The reconciler deletes `home-fm-<tid>-0` only after the StatefulSet is absent.
It keeps the retained row while deletion is pending and removes it only once
the claim is gone. Kubernetes/CSI finalizers may delay completion. Actual
underlying storage disposal depends on the volume's reclaim policy and any
snapshots/backups; a successful app purge records claim removal, not deletion
of every external copy. Avoid manually deleting tracking rows to free slots.

## Capacity

With provisioning enabled, `tenants.maxTenants` defaults to 5. There are two
application checks in addition to the namespace ResourceQuota:

| Action | Count checked |
| --- | --- |
| Invite or approve | All admitted users without a static tenant, plus open invites, plus retained tenants |
| First Start | Started tenant rows plus retained tenants; an already started tenant may start again |

An action attempted while its relevant count is at the cap returns
`409 capacity_reached`. Stopped and
suspended tenants keep their resources/slot. Static-tenant owners are excluded
from managed admission count; an admin without a static tenant is counted like
any other managed user. Expired/revoked invites release their reservation.
Existing user records count even if that user has never started a firstmate.
When provisioning is off, these managed admission checks are not applied.

Increasing `maxTenants` changes both admission and namespace quotas. Verify
cluster CPU, memory, storage and node availability before deploying it.
Quota arithmetic uses `maxTenants × max(firstmate + sidecar, init)` for CPU
requests and memory requests/limits. Defaults produce 5 pods, 1500m requested
CPU, 2880Mi requested memory, 11520Mi limited memory, 50Gi requested storage
and 5 claims. Per-container and per-claim ceilings also come from the chart's
LimitRange. A user accepted by admission can still fail to schedule because
resources, storage, image pulls, or quota are unavailable.

## Audit records

`GET /api/admin/audit` returns the most recent 100 records, with `at`, `actor`,
`action`, `subject`, and `detail`. The current Admin UI does not render an
audit viewer; use an authenticated request or the browser's developer console.
For example, in a signed-in admin tab:

```js
const response = await fetch('/api/admin/audit');
console.table((await response.json()).entries);
```

Actions include sign-in/refusal/sign-out, invitation creation/redeem/revoke,
request approval/denial, user suspend/resume/remove, device linking/revocation,
credential save/refusal/delete, model choice, start/stop, credential delivery,
vault re-seal and purge. Details identify ids, credential slot names, models,
counts, key ids, or outcomes; they do not contain key values or conversation
text. `tenant.purge_requested` means deletion was requested;
`tenant.purged` means the claim is confirmed absent and carries reason
`grace_elapsed` or `purge_now`. Startup re-encryption records `vault.resealed`.

This is an application database log, not an immutable external audit service.
Protect the gateway database and its backups; operator access can change it.

## Admin API

Every route needs a real GitHub session and a configured admin. Writes must
be same-origin. JSON bodies need `Content-Type: application/json`.
User ids are internal `u_…` account ids; tenant ids are separate opaque
`u` plus seven symbols. Use values returned by the list routes.

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/api/admin/users` | Account state, declared/admin flags, firstmate state, timestamps, session count |
| `POST` | `/api/admin/users/<user-id>/suspend` | Suspend and revoke sessions/link codes |
| `POST` | `/api/admin/users/<user-id>/resume` | Resume account |
| `DELETE` | `/api/admin/users/<user-id>` | Remove account |
| `GET` | `/api/admin/invites` | Open invites |
| `POST` | `/api/admin/invites` | `{"login":"example-user"}` |
| `DELETE` | `/api/admin/invites/<invite-id>` | Revoke open invite |
| `GET` | `/api/admin/requests` | Pending requests by numeric GitHub id |
| `POST` | `/api/admin/requests/<github-id>/approve` | Admit account |
| `POST` | `/api/admin/requests/<github-id>/deny` | Deny request |
| `GET` | `/api/admin/retained` | Retained homes; `404` when provisioning is off |
| `POST` | `/api/admin/retained/<tid>/purge` | `{"confirm":"<tid>"}`; mismatch returns `400 confirm_mismatch` |
| `GET` | `/api/admin/audit` | Most recent 100 audit records |

See [gateway-admin.ts](../src/gateway-admin.ts) for the account API and
[gateway.ts](../src/gateway.ts) for admission and role checks.
