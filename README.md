# walkie-talkie

A mobile companion for [firstmate](https://github.com/kunchenguid/firstmate):
reach your fleet and direct it from a phone.

This is the first slice, **Reach**: see what the fleet is doing and drop an
instruction into firstmate's existing intake, end to end.

## What it does

- A small always-on HTTP service (Node.js 22 + TypeScript) that reports on one
  firstmate home and queues instructions into it.
- A minimal installable web app served by the same service at `/` with a status
  view and an instruction composer.

It is deliberately narrow. The service:

- invokes firstmate **only** through its documented scripts, using
  `child_process.execFile` with an argument array and `shell: false`;
- never changes a project and never performs crew, merge, or deploy actions;
- has exactly one write: it queues a note through `fm-inbox note`, exactly as
  firstmate already accepts one.

It does **not** push notifications, ship a native app, terminate TLS, support
multiple users, steer individual workers, or perform any decision/approval/merge
action.

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
| config file path | `FM_WT_CONFIG` | — | `./walkie-talkie.config.json` |

`walkie-talkie.config.json` is gitignored. Do not commit a token.

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

## Endpoints

Every endpoint except `/api/health` requires `Authorization: Bearer <token>`.

| Method | Path | What it runs |
| --- | --- | --- |
| `GET` | `/api/health` | `bin/fm-inbox.sh ready` (`fm-primary-ready.v1`), open |
| `GET` | `/api/status` | `bin/fm-bearings-snapshot.sh --json` (`fm-bearings.v1`) |
| `GET` | `/api/receipts?after=<cursor>` | `bin/fm-inbox.sh receipts [--after <cursor>]` |
| `POST` | `/api/note` | `bin/fm-inbox.sh note --request-id <id> --json -` with text on stdin |
| `GET` | `/` | the web app |

Firstmate's JSON is passed through unchanged.

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
handlers, real `execFile` child processes, and real JSON pass-through.

## Dependencies

Runtime dependencies: **none**. The service uses only Node built-ins (`http`,
`crypto`, `fs`, `path`, `child_process`), and the web app is plain HTML/CSS/JS
with no framework or build step.

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
