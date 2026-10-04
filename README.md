# walkie-talkie

A mobile companion for [firstmate](https://github.com/kunchenguid/firstmate):
reach your fleet and direct it from a phone.

The first slice, **Walkie-Talkie**, let you see what the fleet is doing and drop an
instruction into firstmate's existing intake, end to end. This slice adds
**push notifications**: firstmate can ping the phone when a pull request is
ready for review, a decision is waiting, or a worker is blocked, plus a
**Conversations** view of the fleet's live sessions and instruction threads.

## What it does

- A small always-on HTTP service (Node.js 22 + TypeScript) that reports on one
  firstmate home, queues instructions into it, and pushes notifications to the
  installed web app.
- A minimal installable web app served by the same service at `/` with a status
  view, one unified **Conversations** surface, and a notification opt-in. The
  status view opens with a **firstmate** card - whether the primary is working,
  idle, blocked, or not running, whether it is receiving notes, and how many
  notes are queued and for how long - above the fleet's work. It refreshes
  itself every 10 seconds while on screen and at once when the app returns to
  the foreground, and stops polling while the app is in the background.
- A **Conversations** surface that is the single place to read and start a
  conversation. It lists **instruction threads** - a queued note, any follow-ups
  sent from it, firstmate's replies, and delivery state (a queued note says how
  long it has waited and whether firstmate is working, idle, blocked, or not
  running, from the same
  live state as the status view, so a slow pickup reads differently from a
  stuck one) - alongside the fleet's
  **live sessions** (the primary firstmate session and each worker/scout).
  Tapping either opens the whole thing: a thread shows the captain's messages and
  the fleet's replies with a timestamp on each, and a live session shows its
  **full conversation history**, refreshed live
  and scrollable back through the whole session. Every open conversation has a
  composer at the bottom (with hold-to-talk voice input), and "New conversation"
  opens the same composer for a fresh thread; every send queues a note to
  firstmate through the one existing write. The history is read from the coding
  agent's own session store (opencode's SQLite database), not the terminal, so it is not
  limited to the visible screen; when a session has no agent store the view falls
  back to the terminal's visible output. A live session's badge shows
  firstmate's **real fleet state** (needs-you only when a decision or gate is
  waiting on the captain, working when work is in flight, idle otherwise), never
  the raw herdr pane status.
- Self-hosted Web Push with VAPID: the service generates and holds its own key
  pair and delivers to the browser's own push endpoint. There is no
  third-party account or hosted service to sign up for.

It is deliberately narrow. The service:

- invokes firstmate **only** through its documented scripts, using
  `child_process.execFile` with an argument array and `shell: false`;
- reads the live session list and the terminal fallback through herdr's
  read-only `pane list` / `pane read` / `workspace list` / `tab list` commands,
  also via `execFile` with an argument array and `shell: false`, and refuses
  every other herdr subcommand before a process is spawned;
- opens the agent's SQLite session store **read-only** (and pins the connection
  with `PRAGMA query_only`) to render a full conversation, never writing to it,
  and degrades to the terminal read when the store is absent;
- never changes a project and never performs crew, merge, or deploy actions;
- has exactly one write: it queues a note through `fm-inbox note`, exactly as
  firstmate already accepts one;
- reads the fleet on a configurable interval and pushes an event notification
  exactly once per new event.

It does **not** ship a native app, terminate TLS, steer or type into individual
workers, carry notification actions, or perform any decision/approval/merge
action. By default it serves one firstmate to whoever holds its token; the
opt-in [multi-user gateway](#multi-user-gateway) mode signs people in with
GitHub instead and routes each of them to their own firstmate.

## Requirements

- Node.js 22 or newer (developed on Node 22+; uses the built-in `http`,
  `crypto`, and `child_process` modules). The Conversations history uses the
  built-in `node:sqlite`, which is unflagged from Node 22.13; on an older
  runtime the view falls back to the terminal read. The
  [multi-user gateway](#multi-user-gateway) mode stores its users and sessions
  with `node:sqlite` too, so it needs Node 22.13 or newer.
- A firstmate home with its `bin/` scripts, including `fm-inbox.sh` and
  `fm-bearings-snapshot.sh`.
- For the live-session side of Conversations only: a reachable `herdr` CLI and a
  running herdr session (see [Conversations](#conversations)). The status,
  instruction-thread, and notification features do not need it.

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
| service mode | `FM_WT_MODE` | `mode` | `standalone` (or `gateway`, see [Multi-user gateway](#multi-user-gateway)) |
| bearer token | `FM_WT_TOKEN` | `token` | *(required in standalone mode)* |
| static web assets | `FM_WT_PUBLIC_DIR` | `publicDir` | `./public` |
| allow a public bind | `FM_WT_ALLOW_PUBLIC_BIND` | `allowPublicBind` | `false` |
| VAPID public key | `FM_WT_VAPID_PUBLIC_KEY` | `vapidPublicKey` | *(generated)* |
| VAPID private key | `FM_WT_VAPID_PRIVATE_KEY` | `vapidPrivateKey` | *(generated)* |
| VAPID contact | `FM_WT_VAPID_SUBJECT` | `vapidSubject` | `mailto:admin@localhost` |
| push poll interval | `FM_WT_PUSH_POLL_SECONDS` | `pushPollSeconds` | `20` |
| push state file | `FM_WT_PUSH_STORE` | `pushStore` | `./walkie-talkie.push.json` |
| herdr session | `FM_WT_HERDR_SESSION` | `herdrSession` | `$HERDR_SESSION`, else `default` |
| herdr executable | `FM_WT_HERDR_BIN` | `herdrBin` | `herdr` |
| opencode session store | `FM_WT_OPENCODE_DB` | `opencodeDbPath` | `$FM_HOME/.local/share/opencode/opencode.db` |
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
   | `DOMAIN` | The domain that points at this VM, e.g. `walkie-talkie.example.com` |
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
   #   Environment=DOMAIN=walkie-talkie.example.com
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

The token is saved as you type (debounced) and again when the field loses focus,
so switching tabs or leaving **Settings** cannot drop it; **Save token** also
checks it against `GET /api/status` and reports **Token accepted** or
**Token rejected** inline, shown with the stored token's last four characters so
you can confirm which one is in use. If any API call returns `401`, the app says
the token is missing or wrong and opens **Settings** so the fix is obvious; it
clears the saved token and the field only when the failed request still matches
both of them, so a newer value you are already typing is not erased.
**Forget token** removes it.

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

A Home Screen app is usually resumed rather than relaunched. The service worker
loads the app's files from the network on every launch (the cached copy only
answers offline), and an open app checks for a new deploy each time it returns
to the foreground and reloads into it, unless a note is typed, dictating, or
still sending.

## Conversations

**Conversations** is the single place to read and start a conversation from the
phone. Its list holds two kinds of entry:

- **Instruction threads** - a note firstmate has received (`fm-inbox receipts`)
  together with any follow-ups sent from it, each note's delivery state, and
  firstmate's replies, newest first. Tapping one opens the captain's messages and
  the fleet's replies, each with a timestamp, and the delivery/state line sits
  inside the thread rather than in a separate Receipts view.
- **Live sessions** - the primary firstmate session plus each worker/scout
  session. Tapping one opens its **full conversation history**, refreshed live
  and scrollable back through the whole session, with a timestamp on every
  message.

**Composer** (changed 2026-10-03). Every open conversation - a thread or a live
session - has a message box pinned to the bottom of the pane, and a full-width
**+ New conversation** button at the top of the list opens the same pane for a
fresh thread. Every send queues a note to firstmate through the one existing
write (`POST /api/note`); nothing is ever typed into a session pane. A send from
an open conversation carries that conversation as context:

- from a **thread**, the note is a follow-up. It shows inside that thread in
  order, under the thread's latest delivery state, instead of as a new entry in
  the list;
- from a **live session**, the note goes to firstmate, not to that session. It
  names the session so firstmate knows which work the captain means, and it
  appears in the list as its own thread marked "About live session ...".

The service writes the context as the note's first line, for example
`[walkie-talkie] Follow-up in conversation note-0 "status please"` or
`[walkie-talkie] Sent while viewing live session w1:p1 "firstmate: ..."`,
followed by a blank line and the captain's text. Firstmate reads it as part of
the note. The app parses it back out of `/api/receipts` to group follow-ups, but
only a header the service itself wrote: a message the captain types that begins
with the same text is escaped with a leading backslash on the wire, so it stays
its own thread instead of being grouped under the conversation it names, and the
escape is stripped again before the app summarizes or renders it, so the captain
sees exactly what they typed.
A failed send keeps its request id: pressing send again from the same
conversation with the same text retries idempotently. Changing the text or the
conversation mints a new id.

A live session's badge is derived from firstmate's own bearings snapshot
(`fm-bearings-snapshot.sh --json`), never from herdr's pane status. The default
is idle; the primary session reads needs-you only when a decision or gate is
waiting on the captain, and working when work or a secondmate is in flight. A
worker or secondmate session is matched to its own fleet row and is never
labeled needs-you unless that row is genuinely a captain decision. A raw herdr
`agent_status` of `blocked` therefore cannot make a conversation look like it
needs the captain while nothing is in flight. The snapshot is cached for a short
interval because the list polls far more often than fleet state changes; the raw
pane status is still reported as `status` for diagnostics.

A coding agent's terminal keeps no scrollback: herdr's `pane read` returns only
the visible viewport (roughly one screen, even with a large `--lines`). The
conversation itself is recorded by the agent, so the history comes from the
agent's own session store - opencode's SQLite database - rather than the
terminal:

- The service maps the selected pane to the agent session id the pane reported
  (`herdr pane list` exposes the agent's session as `agent_session.value`, for
  example opencode's `ses_...`), then reads that session's user and assistant
  text messages, oldest to newest, from the store.
- Reads are bounded and cursor-paginated: the view opens on the most recent
  page, polls for newer messages, and a **Load older messages** control walks
  back through the session a page at a time. The read is cheap on a phone and a
  single huge message is truncated rather than bloating the page.
- The store is opened **read-only** and additionally pinned with
  `PRAGMA query_only`, so the service can never write to it. The agent's tool
  calls, reasoning steps, and step markers are not shown; the rendered
  conversation is the user/assistant text.
- When the store, the database, or a session is absent - or the pane reports no
  agent session, such as a plain shell - the view degrades to the terminal's
  visible output for that pane instead of erroring.

The store is read directly (bounded, indexed queries) rather than by shelling
out to the agent. The walkie-talkie image deliberately does not bundle the
coding agent's CLI, and an `opencode export` per poll would return the whole
session each time; a read-only SQLite read is both available and cheap.

The service enumerates sessions with herdr's read-only `pane list`,
`workspace list`, and `tab list`, and reads a pane's terminal with `pane read`,
always scoped to one named session with `--session <name>`. It never calls a
mutating herdr subcommand: the client refuses anything outside that read-only
set before spawning a process, so the view can only read a session, never steer
or type into one. This is deliberately the first version; steering is a later
slice.

Configuration:

- The session is `FM_WT_HERDR_SESSION` (config key `herdrSession`), falling back
  to the ambient `HERDR_SESSION`, then to `default`. In the co-deployed pod
  `HERDR_SESSION` is already exported, so it is picked up automatically.
- The executable is `FM_WT_HERDR_BIN` (config key `herdrBin`), defaulting to
  `herdr` on `PATH`. Set it to an absolute path when the binary is not on the
  service's `PATH`; the service and herdr's session socket must share the same
  home.
- The agent store is `FM_WT_OPENCODE_DB` (config key `opencodeDbPath`),
  defaulting to `$FM_HOME/.local/share/opencode/opencode.db`. It is read through
  Node's built-in `node:sqlite` (Node 22.13 or newer), with no extra dependency;
  if the module or the database is unavailable the view simply uses the terminal
  fallback.

Every pane herdr reports is listed, so a pane with no registered agent still
appears with an unknown state rather than the list going blank. If herdr is not
reachable the live-session list shows the error inline while the instruction
threads, status, and notification features are unaffected.

## Voice input

The conversation composer - at the bottom of every open conversation and of
**+ New conversation** - has a **Hold to talk** microphone button, and it works
the same way on desktop, Android, and iOS. While the button is held (with a
pointer or touch, or with Space/Enter from the keyboard), speech is transcribed
with the browser's Web Speech API (`SpeechRecognition`, or
`webkitSpeechRecognition` where that is the only name) and written into the
instruction textarea. Release to stop. The browser ends each recognition
session at a pause in speech; while the button is still held, the app starts a
new session right away and appends to the same dictation, so a pause never ends
capture and later sentences are not dropped. Silence while the button is held
is not an error; capture simply keeps waiting.

Releasing the button (or pressing **Send to firstmate** while dictating) seals
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

## Multi-user gateway

`FM_WT_MODE=gateway` turns the service into a front door for several people,
each with their own firstmate. In this mode it:

- signs people in with **GitHub** (an OAuth App, authorization code with
  `state` and PKCE S256, no scopes requested). Identity is the GitHub numeric
  id, so a renamed or re-registered login cannot take over an account; the
  GitHub access token is used once to read the profile and then dropped;
- lets in only accounts the operator **declared**: the admins
  (`FM_WT_ADMINS`) and the owners of declared firstmates
  (`FM_WT_STATIC_TENANTS`). Anyone else is refused at the door, and nothing is
  created for them;
- keeps a **session** in an HttpOnly, `Secure`, `SameSite=Lax` cookie named
  `__Host-wt_session`. The server stores only its SHA-256 hash. A session ends
  after 30 idle days and after 90 days in any case, and on sign-out;
- forwards each signed-in user's firstmate API calls (`/api/health`,
  `/api/status`, `/api/firstmate`, `/api/receipts`, `/api/sessions[/<id>]`,
  `/api/note`, `/api/push/*`) **only to that user's own firstmate**, adding that
  firstmate's bearer token. The upstream comes from the session alone; no
  header, path or query parameter can choose it;
- never runs firstmate scripts, never reads a firstmate home, and never stores
  or logs what it forwards.

Each declared firstmate is an ordinary standalone walkie-talkie service, which
keeps its own bearer token. The gateway is the only caller that holds that
token.

| Setting | Environment variable | Config file key | Default |
| --- | --- | --- | --- |
| public origin users open (https; http only on localhost) | `FM_WT_PUBLIC_ORIGIN` | `publicOrigin` | *(required)* |
| GitHub OAuth App client id | `FM_WT_GITHUB_CLIENT_ID` | `githubClientId` | *(required)* |
| GitHub OAuth App client secret | `FM_WT_GITHUB_CLIENT_SECRET` | — (environment only) | *(required)* |
| admin GitHub numeric ids, comma-separated | `FM_WT_ADMINS` | `admins` (array) | *(at least one)* |
| declared firstmates, JSON array of `{githubId, upstream, tokenEnv}` | `FM_WT_STATIC_TENANTS` | `staticTenants` | `[]` |
| users and sessions database (SQLite) | `FM_WT_GATEWAY_DB` | `gatewayDb` | `./walkie-talkie.gateway.db` |
| accept the retiring shared token (`FM_WT_TOKEN`) as the first admin | `FM_WT_LEGACY_BEARER` | `legacyBearer` | `false` |
| reverse-proxy hops whose `X-Forwarded-For` is trusted | `FM_WT_TRUSTED_PROXY_HOPS` | `trustedProxyHops` | `0` |

Registering the GitHub OAuth App:

- Set the **Authorization callback URL** to
  `<FM_WT_PUBLIC_ORIGIN>/auth/github/callback`.
- The client id is not secret.
- Keep the client secret in your secret manager and pass it only through the
  environment.

A static tenant names its upstream as a bare origin, for example
`http://firstmate.firstmate.svc.cluster.local:8787`. `tokenEnv` names the
environment variable that holds that upstream's bearer token, so the token
itself never sits in a config file. Find a GitHub numeric id with
`gh api users/<login> --jq .id`.

`FM_WT_LEGACY_BEARER=1` is a migration bridge for a phone that still holds the
old shared token:

- The gateway accepts `Authorization: Bearer <FM_WT_TOKEN>` as the first
  declared admin, and each response carries `x-wt-legacy-auth: deprecated`.
- Once that phone signs in with GitHub, the app forgets the token.
- Turn the bridge off once every device has signed in.

Gateway routes, besides the forwarded API and the web app:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | the gateway's own liveness, open; no firstmate data |
| `GET` | `/auth/session` | open probe: `{"schema": "walkie-talkie-session.v1", "mode": "gateway", "signed_in", "user": {"login", "admin", "firstmate"} \| null, "legacy_bearer"}` |
| `GET` | `/auth/github/start` | begins GitHub sign-in (rate-limited) |
| `GET` | `/auth/github/callback` | finishes it; redirects to `/`, or to `/?signin=<failed\|expired\|denied\|not_invited\|suspended\|busy>` |
| `POST` | `/auth/logout` | ends this session |

Without a session, a forwarded API call answers `401 {"error": "signed_out"}`.
A signed-in user with no declared firstmate gets
`409 {"error": "firstmate_not_provisioned"}`. If that firstmate refuses the
gateway's token, is down, or does not answer, the response is 502 or 504,
never a 401. Any cookie-authenticated write must come from the app's own
origin: the gateway checks `Origin`, or `Sec-Fetch-Site: same-origin`. The web
app detects gateway mode from `/auth/session` and shows a **Sign in with GitHub**
screen instead of the token form.

## Endpoints

These are the standalone service's endpoints. In gateway mode the gateway
forwards the `/api/*` ones listed in [Multi-user gateway](#multi-user-gateway),
with the session cookie in place of the bearer token.

Every endpoint except `/api/health` and `/api/push/config` requires
`Authorization: Bearer <token>`.

| Method | Path | What it runs |
| --- | --- | --- |
| `GET` | `/api/health` | `bin/fm-inbox.sh ready` (`fm-primary-ready.v1`), open |
| `GET` | `/api/status` | `bin/fm-bearings-snapshot.sh --json` (`fm-bearings.v1`) |
| `GET` | `/api/firstmate` | `herdr pane list` (the primary pane), `bin/fm-inbox.sh ready`, and `bin/fm-inbox.sh receipts` |
| `GET` | `/api/receipts?after=<cursor>` | `bin/fm-inbox.sh receipts [--after <cursor>]` |
| `GET` | `/api/sessions` | `herdr pane list` joined with `workspace list` and `tab list`; each `state` derived from `bin/fm-bearings-snapshot.sh --json` |
| `GET` | `/api/sessions/<pane-id>?limit=<n>&before=<cursor>` | the agent's session store (read-only), else `herdr pane read <pane-id> --lines <n> --source recent --format text` |
| `POST` | `/api/note` | `bin/fm-inbox.sh note --request-id <id> --json -` with text on stdin |
| `GET` | `/api/push/config` | returns `{"publicKey"}` (open; see below) |
| `POST` | `/api/push/subscribe` | stores a browser push subscription |
| `POST` | `/api/push/unsubscribe` | removes a subscription by endpoint |
| `POST` | `/api/push/test` | sends one test notification to all subscriptions |
| `GET` | `/` | the web app |

Firstmate's JSON is passed through unchanged by `/api/status` and
`/api/receipts`, and by `/api/health` with one correction. `fm-inbox.sh ready`
judges the session lock by its pid, which a service in its own container (the
Kubernetes deployment) cannot see, so it reports `can_receive: false` while
firstmate is draining notes. When that is the only reason - the lock reads
`stale`/`unknown` without a live harness and the wake consumer is `unknown`,
not `down` - and herdr shows an agent running in the primary pane and the
watcher beacon is within firstmate's 300 s guard grace, `/api/health` reports
`can_receive: true` with `can_receive_basis:
"herdr-primary-agent-and-watcher-beacon"`, keeping firstmate's own `lock` and
`wake_consumer` as reported. The service never looks at firstmate's processes
or environment.

`GET /api/firstmate` is the one live-state view the status card and the queued
conversations share: `{"schema": "walkie-talkie-firstmate.v1", "observed_at",
"activity", "primary", "can_receive", "watcher_beacon_age_seconds", "queue"}`.
`activity` is `busy` (herdr reports the primary pane `working`), `idle` (the
agent is running and ready for input, herdr's `idle` or `done`), `blocked`
(herdr recognized an approval or question prompt), `not_running` (no primary
pane, or no agent in it), or `unknown` (herdr unreadable, or an agent present
with a status herdr did not classify); `primary` is
`{"id", "agent", "status"}` or null; `can_receive` is
the corrected readiness above; `queue` is `{"queued", "oldest_queued_at"}` over
the unacknowledged notes, or null when receipts cannot be read.

The live-session endpoint is the service's own shape:
`GET /api/sessions` returns `{"sessions": [...]}` with `id`, `name`, `kind`
(`primary`/`secondmate`/`worker`), `status` (the raw herdr pane status, kept for
diagnostics), `state` (the firstmate-derived badge: `needs_you`, `working`,
`idle`, or `unknown`), `agent`, `agent_session`, `title`, `cwd`, `workspace_id`,
and `tab_id`. The browser builds the instruction threads from `/api/receipts`:
each note's `at` and `body`, its `reply`, and its `acknowledged`/`announced`
delivery state.

`GET /api/sessions/<pane-id>` returns one of two shapes, distinguished by
`source`:

- `{"source": "history", "id", "agent_session", "messages", "has_older",
  "oldest_cursor"}` - the session's conversation from the agent store.
  `messages` is ordered oldest-to-newest, each `{"id", "role", "time", "text"}`.
  `limit` bounds the message rows per page (default 200, clamped); pass
  `oldest_cursor` as `before` to load older messages.
- `{"source": "terminal", "id", "agent_session", "lines", "output"}` - the
  fallback when no agent store or session is available; `lines` is clamped to a
  bounded range.

`<pane-id>` is herdr's pane id (for example `w1:p1`). A `before` cursor that is
not a well-formed cursor is a 400.

`GET /api/push/config` is intentionally **open**. It returns only the VAPID
public key, which is not a secret: the browser must fetch it before it can
create a subscription, and anyone who has it still cannot send a notification
without the private key. The subscribe/unsubscribe/test endpoints require the
bearer token like the rest of the API.

`POST /api/note` accepts a JSON body `{"text": "...", "requestId": "..."}`, with an
optional `"context": {"kind": "thread" | "session", "id": "...", "label": "..."}`
naming the conversation the note was written from. A thread `id` must be a
firstmate note id and a session `id` a herdr pane id. The `label` is flattened
to one line of at most 120 characters. The service writes the context as the
note's first line (see [Conversations](#conversations)), and a malformed
context is a 400.
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
`crypto`, `fs`, `path`, `child_process`, and `node:sqlite` for the read-only
Conversations history), and the web app is plain HTML/CSS/JS with no framework
or build step. Web Push encryption (RFC 8291) and VAPID signing (RFC 8292) are
implemented directly on `node:crypto` rather than pulling in a push library.

Dev dependencies (build/test only): `typescript` (compiles the service) and
`@types/node` (Node type definitions). Nothing else is added, so there is no
transitive supply-chain surface in production.

## Security notes

- The bearer token is compared in constant time (`crypto.timingSafeEqual` over
  SHA-256 digests, so unequal lengths do not throw or leak).
- All firstmate and herdr invocations use `execFile` with an argument array and
  `shell: false`. Request input is passed as a literal argument or on stdin and
  is never interpolated into a shell string.
- The herdr reads behind Conversations are read-only: the herdr client permits
  only `pane list`, `pane read`, `workspace list`, and `tab list`, and refuses
  every other subcommand before a process is spawned. A session id that is not a
  well-formed pane id (option-like or containing a path separator) is refused
  before any herdr call.
- The agent session store is opened read-only and pinned with
  `PRAGMA query_only`, so the service can only read conversations, never write
  to or steer them. Session ids and pagination cursors are validated before any
  query, and every query is parameterized. A malformed cursor is rejected with a
  400.
- Request ids are validated against firstmate's own contract before use.
- The service binds loopback by default and refuses a public bind unless
  explicitly overridden.
- Push subscriptions are validated before storage: the endpoint must be an
  `https:` URL and the keys must be a 65-byte uncompressed P-256 point and a
  16-byte authentication secret, both base64url.
- In gateway mode, sessions and sign-in attempts are stored only as SHA-256
  hashes. The database is created owner-only (`0600`) with `secure_delete`, so
  a consumed sign-in's PKCE verifier does not linger in free pages. GitHub's
  error text, OAuth codes and tokens, cookies, and forwarded bodies are never
  logged. An upstream's `Set-Cookie` and any other response header but
  `content-type`/`content-length` are dropped, so a firstmate cannot set a
  cookie on the gateway's origin.
- The VAPID private key is written only to the gitignored, owner-only
  (`0600`) push state file. Notifications contain a fixed title and body, a
  deep link, and a tag - never a note body or record free text.
