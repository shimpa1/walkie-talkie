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
  view, an instruction composer (with hold-to-talk voice input), and a
  notification opt-in.
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
`FM_WT_ALLOW_PUBLIC_BIND=1`. Instead of publishing the service port directly,
put a reverse proxy in front of it ([Deploy on a VM](#deploy-on-a-vm)) or use
the Tailscale approach below.

## Deploy on a VM

This is the standard self-hosting path: run the service on a Linux host that
also carries the firstmate home (`FM_HOME`), and reach it from a phone at
`https://<domain>` behind a reverse proxy that manages TLS. A real domain and
HTTPS matter: the installable PWA and (later) push require a secure context, and
plain HTTP on an IP address will not do. The app is served same-origin from the
service, so the phone loads everything from the same domain.

The reverse proxy (Caddy) obtains and renews a trusted certificate for the
domain automatically and redirects HTTP to HTTPS. The app itself is never
published directly; only the proxy is reachable from outside.

### Prerequisites

- A Linux VM that already runs firstmate, with its home (for example
  `~/firstmate` or `/home/you/firstmate`) on the same host. This project does
  **not** install or run firstmate.
- A domain whose `A`/`AAAA` record points at the VM's public address.
- Ports **80** and **443** open in the firewall and reachable from the
  internet (Caddy uses port 80 for the HTTP challenge and the redirect).
- Either Docker with the Compose plugin, or Node.js 22+ and Caddy for the
  systemd path below.

### Option A — Docker Compose (recommended)

The image bundles Node 22 plus the runtime tools the firstmate scripts need
(`bash`, `jq`, `python3`, `git`, `curl`). `FM_HOME` is bind-mounted, so the
service reads the existing home and queues notes straight into it.

1. Install Docker and the Compose plugin, then get the repository onto the VM
   and enter it:

   ```sh
   git clone https://github.com/shimpa1/walkie-talkie.git
   cd walkie-talkie
   ```

2. Create your deployment env file from the example:

   ```sh
   cp .env.example .env
   ```

3. Generate the bearer token and edit `.env`:

   ```sh
   openssl rand -hex 32      # paste the output into FM_WT_TOKEN
   ${EDITOR:-vi} .env
   ```

   Set at least:

   | Setting | Meaning |
   | --- | --- |
   | `DOMAIN` | The domain that points at this VM, e.g. `reach.example.com` |
   | `ACME_EMAIL` | Email for certificate expiry notices (recommended) |
   | `FM_HOME` | Absolute path to the firstmate home on the host, e.g. `/home/you/firstmate` |
   | `FM_WT_TOKEN` | The bearer token the phone enters under **Settings** |
   | `PUID` / `PGID` | The uid/gid that owns `FM_HOME` (`id -u`, `id -g`) |

4. Build and start:

   ```sh
   docker compose up -d --build
   ```

5. Check it and follow the certificate issuance:

   ```sh
   docker compose ps
   docker compose logs -f caddy
   ```

   Open `https://<domain>/` on the phone, enter the token under **Settings**, and
   add the app to the home screen.

### Updating

```sh
git pull
docker compose up -d --build
```

`FM_HOME` and the issued certificates (`caddy_data`) persist across updates.

### Option B — systemd and Caddy (no Docker)

Use this when you would rather not run Docker on the host. Caddy terminates TLS
and proxies to the service on loopback; the service itself never binds a public
address.

1. Install Node.js 22+, Caddy, and the tools firstmate needs
   (`bash`, `jq`, `python3`, `git`, `curl`).

2. Install the app under `/opt/walkie-talkie` and build it:

   ```sh
   sudo git clone https://github.com/shimpa1/walkie-talkie.git /opt/walkie-talkie
   cd /opt/walkie-talkie
   sudo npm ci
   sudo npm run build
   sudo npm prune --omit=dev
   sudo chown -R firstmate:firstmate /opt/walkie-talkie
   ```

3. Create the environment file (mode 600, owned by the service user):

   ```sh
   sudo install -m 600 /dev/null /etc/walkie-talkie.env
   sudo tee /etc/walkie-talkie.env >/dev/null <<'EOF'
   FM_HOME=/home/you/firstmate
   FM_WT_TOKEN=replace-with-a-generated-token
   EOF
   ```

   The service keeps the default loopback bind (`127.0.0.1:8787`); Caddy reaches
   it there.

4. Install the unit and start it:

   ```sh
   sudo cp deploy/systemd/walkie-talkie.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now walkie-talkie
   sudo systemctl status walkie-talkie
   ```

   Edit `User=`/`Group=` in the unit if the firstmate home is not owned by a
   user named `firstmate`, and adjust `WorkingDirectory`/`ExecStart` if you
   installed somewhere other than `/opt/walkie-talkie`.

5. Install Caddy, then use the provided Caddyfile:

   ```sh
   sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
   sudo systemctl edit caddy     # add:
   #   [Service]
   #   Environment=DOMAIN=reach.example.com
   #   Environment=ACME_EMAIL=you@example.com
   sudo systemctl restart caddy
   ```

   Caddy obtains the certificate and proxies `https://<domain>/` to the service.

### Security posture

- **HTTPS only.** Caddy redirects HTTP to HTTPS and manages certificate renewal;
  the service never handles TLS itself.
- **Token-gated.** Every endpoint except `/api/health` requires the bearer token.
  Generate it with `openssl rand -hex 32`; it is compared in constant time and
  stored only in the phone's browser.
- **No public app port.** In Compose the app port is only `expose`d on the
  private network, never `ports`-published. Under systemd it binds loopback. Only
  ports 80 and 443 face the internet.
- **Least privilege.** The container runs as the uid/gid that owns `FM_HOME`, and
  the systemd unit applies modest sandboxing.

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

Do not use Tailscale Funnel. For public access over a normal domain, use
[Deploy on a VM](#deploy-on-a-vm) instead.

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

## Voice input

The instruction composer has a **Hold to talk** microphone button, and it works
the same way on desktop, Android, and iOS. While the button is held (with a
pointer or touch, or with Space/Enter from the keyboard), speech is transcribed
with the browser's Web Speech API (`SpeechRecognition`, or
`webkitSpeechRecognition` where that is the only name) and written into the
instruction textarea. Release to stop. The browser ends each recognition
session at a pause in speech; while the button is still held, the app starts a
new session right away and appends to the same dictation, so a pause never ends
capture and later sentences are not dropped. Silence while the button is held
is not an error; capture simply keeps waiting.

Releasing the button (or pressing **Queue instruction** while dictating) seals
the dictation: whatever is on screen at that moment, including words the
browser had not yet finalized, stays in the textarea, and any recognition
result that arrives afterwards is ignored. A late result can never rewrite the
composer after the instruction has been sent.

The composed text then goes out through the same `POST /api/note` path as typing:
voice is only an input method for the note, not a second write path. The app
records nothing, uploads no audio (there is no audio endpoint), and adds no
transcription service of its own; recognition is performed by the browser's
Web Speech API.

The control is hidden when the browser has no Web Speech API, so it never
breaks the composer. A listening state and short messages for the common
failures (`not-allowed`, `audio-capture`, `network`) appear next to the send
button.

Browser support is uneven. Chrome, Edge, and Safari (desktop and iOS) ship the
API; Firefox does not. On iOS, voice input needs **Safari** (the API is not
exposed to other iOS browsers' web views), and, as with push, the page must be a
secure context. If the API is unavailable, the mic control is hidden and you can
still dictate with the OS keyboard's microphone key directly in the instruction
field; that dictation remains a fallback and writes into the same textarea.

## Run on Kubernetes

To run firstmate and this companion on a Kubernetes cluster behind a Gateway API
Gateway, with a persistent firstmate home and the attachable herdr session, use
the Helm chart in [`deploy/helm/firstmate`](deploy/helm/firstmate). This is an
addition to the host-based usage above, not a replacement; see
[`docs/deploy-kubernetes.md`](docs/deploy-kubernetes.md) for prerequisites,
install/upgrade/uninstall, and the atus cluster example.

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
npm ci            # install the exact locked devDependencies
npm test          # builds, then runs node:test over dist/test
npm run typecheck # type-checks without emitting
```

CI (`.github/workflows/ci.yml`) runs these same three commands on every pull
request and on pushes to `main`, so a green local run here matches a green CI
check.

Tests use committed fixtures and a fake firstmate `bin/` directory; they never
depend on a live firstmate home. They exercise real code paths: real HTTP
handlers, real `execFile` child processes, real JSON pass-through, the durable
subscription store, and the Web Push encryption against the RFC 8291 test
vector. Push delivery is stubbed in tests, so no push service is ever contacted.
Voice input is tested by loading the real browser module with a fake
`SpeechRecognition`, so feature detection, restart-while-held, transcript
handling, and error handling are covered without a microphone.

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
