# walkie-talkie documentation

walkie-talkie is firstmate's installable phone companion. It displays fleet
status and conversations, queues instructions, and delivers Web Push notices.
It can run beside one firstmate or as a GitHub-authenticated gateway in front
of several independent firstmates.

| Guide | Read it for |
| --- | --- |
| [Architecture](architecture.md) | Components, request flow, modes, tenant types, stores, and API boundaries |
| [User guide](user-guide.md) | Sign-in, iPhone installation, device linking, phone and desktop layouts, conversations, voice, status, setup, and start/stop |
| [Admin guide](admin-guide.md) | Invites, access requests, users, retained homes, capacity, and audit records |
| [Operations](operations.md) | Deployment, upgrades, values, secret sources, rotations, provisioning prerequisites, rollback, and troubleshooting |
| [Security](security.md) | Trust boundaries, isolation, credentials, and residual risks |
| [Kubernetes installation](deploy-kubernetes.md) | Full chart installation, image builds, static firstmate configuration, Gateway API, TLS, and storage |
| [Repository README](../README.md) | Local/VM installation, environment configuration, and standalone API reference |
| [Chart README](../deploy/helm/firstmate/README.md) | Chart entry point and links to its values |
| [Contributing](../CONTRIBUTING.md) | Development prerequisites and checks |

## Current atus configuration

The merged [atus values](../deploy/helm/firstmate/examples/values-atus.yaml)
enable the gateway at `https://walkie-talkie.atus.hr`. The existing firstmate
is a **static tenant** owned by the configured GitHub account. Its runtime,
sidecar, home volume, and `agents` configuration are independent of the gateway.
The legacy bearer bridge is enabled while devices migrate to GitHub sessions.

Managed per-user firstmates are implemented but **disabled on atus**:
`tenants.enabled: false`. Users without a static tenant can save setup when
admitted, but cannot start a firstmate there. The cluster check found ingress
isolation working and egress isolation failing because a Calico global policy
overrides namespace restrictions. Enabling provisioning requires a remedy and
a passing [network-policy check](operations.md#enabling-managed-firstmates).

The gateway's secrets come from Doppler `walkie-talkie/gateway`, synced to
`firstmate-gateway-secrets`. They must never be placed in `walkie-talkie/prd`
or `firstmate-doppler-secrets`: the static firstmate loads that entire config.

These guides describe the implementation and committed deployment settings.
They are operational references, not a deployment history or an assertion that
every running cluster resource matches the values. Historical deployment
records remain in the [Kubernetes guide](deploy-kubernetes.md#atus-deploy-record).

## Source of truth

Read the [chart values](../deploy/helm/firstmate/values.yaml) and
[schema](../deploy/helm/firstmate/values.schema.json) for supported settings.
The architecture guide links the implementation for each boundary. Changes to
those interfaces should update the relevant guide as part of the same change.

Examples use secret names, variable names, and placeholders, never credentials.
Keep generated keys, database copies, and real secret-manager exports out of
the repository and documentation.
