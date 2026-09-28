# walkie-talkie

A mobile companion for [firstmate](https://github.com/kunchenguid/firstmate):
reach your fleet and direct it from a phone.

The first slice, **Reach**, let you see what the fleet is doing and drop an
instruction into firstmate's existing intake, end to end. This slice adds
**push notifications**: firstmate can ping the phone when a pull request is
ready for review, a decision is waiting, or a worker is blocked.

## What it does

- A small always-on HTTP service (Node.js 22 + TypeScript) that reports on one
  firstmate home, queues instructions into it, and pushes notifications to the
  installed web app.
- A minimal installable web app served by the same service at `/` with a status
  view, an instruction composer, and a notification opt-in.
- Self-hosted Web Push with VAPID: the service generates and holds its own key
  pair and delivers to the browser's own push endpoint. There is no
  third-party account or hosted service to sign up for.

It is deliberately narrow. The service:

- invokes firstmate **only** through its documented scripts, using
  `child_process.execFile` with an argument array and `shell: false`;
- never changes a project and never performs crew, merge, or deploy actions;
- has exactly one write: it queues a note through `fm-inbox note`, exactly as
  firstmate already accepts one;
- reads the fleet on a configurable interval and pushes an event notification
  exactly once per new event.

It does **not** ship a native app, terminate TLS, support multiple users, steer
individual workers, carry notification actions, or perform any
decision/approval/merge action.

## Requirements

- Node.js 22 or newer (developed on Node 22+; uses the built-in `http`,
  `crypto`, and `child_process` modules).
- A firstmate home with its `bin/` scripts, including `fm-inbox.sh` and
  `fm-bearings-snapshot.sh`.

## Install

```sh
npm install       # installs devDependencies only (see Dependencies below)
npm run build     # compiles TypeScript to dist/
```

## Configuration

Configuration comes from environment variables and/or a gitignored JSON file.
The environment always wins, so a token never has to be written to disk.

Copy the example and edit it:

```sh
cp walkie-talkie.config.example.json walkie-talkie.config.json
```

| Setting | Environment variable | Config file key | Default |
| --- | --- | --- | --- |
| firstmate home | `FM_HOME` | `fmHome` | `~/firstmate` |
| firstmate `bin/` | `FM_BIN` | `fmBin` | `$FM_HOME/bin` |
| bind address | `FM_WT_HOST` | `host` | `127.0.0.1` |
| bind port | `FM_WT_PORT` | `port` | `8787` |
| bearer token | `FM_WT_TOKEN` | `token` | *(required)* |
| static web assets | `FM_WT_PUBLIC_DIR` | `publicDir` | `./public` |
| allow a public bind | `FM_WT_ALLOW_PUBLIC_BIND` | `allowPublicBind` | `false` |
| VAPID public key | `FM_WT_VAPID_PUBLIC_KEY` | `vapidPublicKey` | *(generated)* |
| VAPID private key | `FM_WT_VAPID_PRIVATE_KEY` | `vapidPrivateKey` | *(generated)* |
| VAPID contact | `FM_WT_VAPID_SUBJECT` | `vapidSubject` | `mailto:admin@localhost` |
| push poll interval | `FM_WT_PUSH_POLL_SECONDS` | `pushPollSeconds` | `20` |
| push state file | `FM_WT_PUSH_STORE` | `pushStore` | `./walkie-talkie.push.json` |
| config file path | `FM_WT_CONFIG` | — | `./walkie-talkie.config.json` |

`walkie-talkie.config.json` is gitignored. Do not commit a token.

The VAPID key pair and the phone subscriptions are written to
`walkie-talkie.push.json`, which is **also gitignored** and created `0600` (owner
only). The private key never leaves that file. Leave both VAPID keys unset and
the service generates and persists a pair on first run; set them (together) only
if you want to supply your own pair.

### Generate a token

```sh
openssl rand -hex 32
# or, with no extra tooling:
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Run

```sh
FM_HOME="$HOME/firstmate" \
FM_WT_TOKEN="$(openssl rand -hex 32)" \
npm start
```

Or with a config file:

```sh
npm start
```

The service prints the address it bound and the firstmate home it is reporting
on. The web app is at `/`.

### Binding safety

The service defaults to loopback and **refuses to bind a non-loopback address**
(such as `0.0.0.0`) unless you explicitly set
`FM_WT_ALLOW_PUBLIC_BIND=1`. Prefer the Tailscale approach below instead of
exposing a port.

## Reaching it from a phone over Tailscale

The phone reaches the service over your private tailnet; no public port is
opened.

Recommended: keep the service on loopback and let Tailscale Serve put it on the
tailnet with HTTPS (which also gives the PWA a secure context so it is
installable):

```sh
# On the Mac running firstmate:
npm start                                   # binds 127.0.0.1:8787
tailscale serve --bg 8787                   # serves it on this machine's tailnet name over HTTPS
tailscale serve status
```

Then open `https://<machine>.<tailnet>.ts.net/` on the phone, enter the bearer
token once under **Settings**, and share this web app to the home screen. The
token is stored only in that browser on that device.

Alternative: bind the service directly to the machine's tailnet address. This
needs the explicit override because the address is not loopback:

```sh
FM_WT_HOST="$(tailscale ip -4)" FM_WT_ALLOW_PUBLIC_BIND=1 npm start
```

Do not use Tailscale Funnel or any other public exposure.

## Push notifications

Notifications are delivered with Web Push. The service holds a VAPID key pair,
encrypts each message for the subscribing device, and posts it to the browser's
own push endpoint (for example, an Apple or Google push service). Nothing is
registered with a third-party account, and the service never sees a device
token that it did not receive from that device.

### Generating keys

On first run the service generates a P-256 VAPID key pair and writes it to
`walkie-talkie.push.json` (`0600`, gitignored). To supply your own pair instead,
set both `FM_WT_VAPID_PUBLIC_KEY` and `FM_WT_VAPID_PRIVATE_KEY` (or the
`vapidPublicKey` / `vapidPrivateKey` config keys); they must be base64url, the
public key an uncompressed P-256 point and the private key its 32-byte scalar,
and they must be a matching pair (the private key must derive the public key).
An off-curve point, an out-of-range scalar, or a mismatched pair is rejected at
startup, as is setting only one of them. The VAPID contact
(`FM_WT_VAPID_SUBJECT`) is sent to the push service as the `sub` claim.

### What triggers a notification

The service polls the firstmate home every `FM_WT_PUSH_POLL_SECONDS` (default
20) and notifies once per new event:

- a **new reply** to a queued note, from `fm-inbox.sh receipts --after <cursor>`
  (the reply cursor is persisted, so a restart does not re-notify);
- a **newly opened decision**, a **newly ready pull request**, or a **newly
  blocked worker**, from `fm-bearings-snapshot.sh --json`. Ready PRs are read
  from the `recorded_prs` surface (PRs recorded in task meta); "blocked" is a
  worker's `in_flight` state changing into `blocked`.

Each event is remembered in the state file, so an event notifies exactly once
and a restart does not replay it. Notification bodies are fixed strings: no note
body or record free text is ever put into a notification.

### Subscribing from the phone

Open the app over HTTPS (`https://<machine>.<tailnet>.ts.net/` via Tailscale
Serve, above), enter the bearer token under **Settings**, save it, then tap
**Enable on this device** and allow notifications. The browser performs the
subscription and posts it to `POST /api/push/subscribe`; the service stores it
in the push state file. **Disable** unsubscribes, and **Send test** delivers one
notification to every stored subscription.

The browser must consider the page a secure context and must support the Push
API. That is why the Tailscale Serve HTTPS front end matters: a plain
`http://` origin cannot register a service worker or subscribe.

### iPhone and iPad

On iOS and iPadOS, web push only works from a web app that has been **added to
the Home Screen**, and only on **iOS 16.4 or newer**. In Safari, tap Share ->
**Add to Home Screen**, open the app from the new icon, then use **Settings ->
Enable on this device**. A plain Safari tab cannot receive notifications.

## Endpoints

Every endpoint except `/api/health` and `/api/push/config` requires
`Authorization: Bearer <token>`.

| Method | Path | What it runs |
| --- | --- | --- |
| `GET` | `/api/health` | `bin/fm-inbox.sh ready` (`fm-primary-ready.v1`), open |
| `GET` | `/api/status` | `bin/fm-bearings-snapshot.sh --json` (`fm-bearings.v1`) |
| `GET` | `/api/receipts?after=<cursor>` | `bin/fm-inbox.sh receipts [--after <cursor>]` |
| `POST` | `/api/note` | `bin/fm-inbox.sh note --request-id <id> --json -` with text on stdin |
| `GET` | `/api/push/config` | returns `{"publicKey"}` (open; see below) |
| `POST` | `/api/push/subscribe` | stores a browser push subscription |
| `POST` | `/api/push/unsubscribe` | removes a subscription by endpoint |
| `POST` | `/api/push/test` | sends one test notification to all subscriptions |
| `GET` | `/` | the web app |

Firstmate's JSON is passed through unchanged.

`GET /api/push/config` is intentionally **open**. It returns only the VAPID
public key, which is not a secret: the browser must fetch it before it can
create a subscription, and anyone who has it still cannot send a notification
without the private key. The subscribe/unsubscribe/test endpoints require the
bearer token like the rest of the API.

`POST /api/note` accepts a JSON body `{"text": "...", "requestId": "..."}`.
The client supplies a stable request id; a retry with the same id is idempotent
and queues exactly once. If no id is supplied, the service generates one and
returns it. Request ids must match firstmate's own contract:
`[A-Za-z0-9._:-]{1,128}`, not starting with a dot.

Example:

```sh
curl -sS http://127.0.0.1:8787/api/note \
  -H "Authorization: Bearer $FM_WT_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"note for firstmate","requestId":"phone-2026-09-28-1"}'
```

## Tests

```sh
npm test          # builds, then runs node:test over dist/test
npm run typecheck # type-checks without emitting
```

Tests use committed fixtures and a fake firstmate `bin/` directory; they never
depend on a live firstmate home. They exercise real code paths: real HTTP
handlers, real `execFile` child processes, real JSON pass-through, the durable
subscription store, and the Web Push encryption against the RFC 8291 test
vector. Push delivery is stubbed in tests, so no push service is ever contacted.

## Dependencies

Runtime dependencies: **none**. The service uses only Node built-ins (`http`,
`crypto`, `fs`, `path`, `child_process`), and the web app is plain HTML/CSS/JS
with no framework or build step. Web Push encryption (RFC 8291) and VAPID
signing (RFC 8292) are implemented directly on `node:crypto` rather than pulling
in a push library.

Dev dependencies (build/test only): `typescript` (compiles the service) and
`@types/node` (Node type definitions). Nothing else is added, so there is no
transitive supply-chain surface in production.

## Security notes

- The bearer token is compared in constant time (`crypto.timingSafeEqual` over
  SHA-256 digests, so unequal lengths do not throw or leak).
- All firstmate invocations use `execFile` with an argument array and
  `shell: false`. Request input is passed as a literal argument or on stdin and
  is never interpolated into a shell string.
- Request ids are validated against firstmate's own contract before use.
- The service binds loopback by default and refuses a public bind unless
  explicitly overridden.
- Push subscriptions are validated before storage: the endpoint must be an
  `https:` URL and the keys must be a 65-byte uncompressed P-256 point and a
  16-byte authentication secret, both base64url.
- The VAPID private key is written only to the gitignored, owner-only
  (`0600`) push state file. Notifications contain a fixed title and body, a
  deep link, and a tag - never a note body or record free text.
