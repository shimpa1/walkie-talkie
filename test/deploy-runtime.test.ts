import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "./helpers.js";

const RUNTIME_DIR = join(REPO_ROOT, "deploy", "kubernetes", "firstmate");
const DOCKERFILE = join(RUNTIME_DIR, "Dockerfile");
const ENTRYPOINT = join(RUNTIME_DIR, "entrypoint.sh");
const PATCH = join(
  RUNTIME_DIR,
  "patches",
  "0001-opencode-arm-without-task.patch",
);
const PATCH2 = join(
  RUNTIME_DIR,
  "patches",
  "0002-handling-successor-resurface-downtime.patch",
);

/**
 * The deployed firstmate runs upstream's OpenCode watch-arm plugin, which only
 * armed supervision for a state/*.meta task or x-mode. A freshly booted home
 * whose only pending work is a queued inbox note therefore had no watcher and
 * the note sat undrained. The runtime image must pin the distro to an immutable
 * commit and ship the plugin patch that arms on lock ownership, and the
 * entrypoint must refresh that patched plugin into an existing home.
 */
test("the runtime Dockerfile pins firstmate to an immutable commit", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const match = dockerfile.match(/^ARG FIRSTMATE_REF=(\S+)$/m);
  assert.ok(match, "FIRSTMATE_REF is declared");
  const ref = match[1]!;
  assert.match(
    ref,
    /^[0-9a-f]{40}$/,
    `FIRSTMATE_REF must be a full commit, not a mutable ref (got ${ref})`,
  );
});

test("the runtime Dockerfile installs the tools a firstmate expects, pinned", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  for (const arg of [
    "NO_MISTAKES_VERSION",
    "GH_AXI_VERSION",
    "CHROME_DEVTOOLS_AXI_VERSION",
    "TASKS_AXI_VERSION",
    "QUOTA_AXI_VERSION",
    "LAVISH_AXI_VERSION",
  ]) {
    const match = dockerfile.match(new RegExp(`^ARG ${arg}=(\\S+)$`, "m"));
    assert.ok(match, `${arg} is declared`);
    assert.match(match[1]!, /^\d+\.\d+\.\d+$/, `${arg} is a pinned version`);
  }
  // no-mistakes is fetched from its pinned release and checksum-verified, not
  // through its install script (which resolves "latest" and restarts the daemon).
  assert.match(
    dockerfile,
    /github\.com\/kunchenguid\/no-mistakes\/releases\/download\/\$\{tag\}/,
  );
  assert.match(dockerfile, /checksums\.txt/);
  assert.match(dockerfile, /\/usr\/local\/bin\/no-mistakes/);
  // The AXI-family tools are installed from npm at their pinned versions.
  for (const pkg of [
    "gh-axi",
    "chrome-devtools-axi",
    "tasks-axi",
    "quota-axi",
    "lavish-axi",
  ]) {
    const env = `${pkg.toUpperCase().replace(/-/g, "_")}_VERSION`;
    assert.match(
      dockerfile,
      new RegExp(`"${pkg}@\\$\\{${env}\\}"`),
      `${pkg} is installed at its pinned version`,
    );
  }
});

test("the runtime Dockerfile applies the committed patch set", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  assert.match(dockerfile, /^COPY patches\/ /m);
  // Every committed patch is applied in order, so a new delta cannot be shipped
  // unapplied by forgetting to name it here.
  assert.match(
    dockerfile,
    /for p in \/tmp\/firstmate-patches\/\*\.patch; do git -C \/opt\/firstmate apply "\$p"; done/,
  );
});

test("the watch-arm patch arms supervision without a task in flight", () => {
  const patch = readFileSync(PATCH, "utf8");
  assert.match(patch, /\.opencode\/plugins\/fm-primary-watch-arm\.js/);
  assert.match(patch, /function shouldArm\(paths\)/);
  // The upstream gate is removed: no state/*.meta or x-mode requirement, and
  // the replacement arms unconditionally on lock ownership.
  assert.match(patch, /^-.*endsWith\("\.meta"\)/m);
  assert.doesNotMatch(patch, /^\+.*endsWith\("\.meta"\)/m);
  assert.doesNotMatch(patch, /^\+.*x-mode\.env/m);
  assert.match(patch, /^\+  return true;$/m);
  // The away-posture opt-out is preserved.
  assert.match(patch, /if \(existsSync\(`\$\{paths\.state\}\/\.afk`\)\) return false;/);
});

test("the watcher patch makes a handling successor surface queued work", () => {
  const patch = readFileSync(PATCH2, "utf8");
  assert.match(patch, /bin\/fm-watch\.sh/);
  assert.match(patch, /resurface_after_downtime\(\)/);
  // The unconditional handling-successor skip is removed; the once-per-generation
  // arm check below remains the loop guard.
  assert.match(patch, /^-\s*if \[ "\$\{FM_WATCH_HANDLING_SUCCESSOR:-0\}" = 1 \]; then$/m);
  assert.match(patch, /^-\s*return 0$/m);
  assert.doesNotMatch(patch, /^\+\s*if \[ "\$\{FM_WATCH_HANDLING_SUCCESSOR:-0\}" = 1 \]/m);
  assert.match(patch, /fm_recovery_marker_arm_check "\$WATCHER_DOWNTIME_MARKER"/);
});

test("the entrypoint refreshes the patched watch-arm plugin into the home", () => {
  const entrypoint = readFileSync(ENTRYPOINT, "utf8");
  assert.match(entrypoint, /fm-primary-watch-arm\.js/);
  assert.match(
    entrypoint,
    /cp -f "\$SEED_DIR\/\$WATCH_ARM_PLUGIN" "\$HOME_DIR\/\$WATCH_ARM_PLUGIN"/,
  );
});

test("the entrypoint refreshes the patched watcher into the home", () => {
  const entrypoint = readFileSync(ENTRYPOINT, "utf8");
  assert.match(entrypoint, /WATCH_WATCHER="bin\/fm-watch\.sh"/);
  // The watcher is replaced atomically: a concurrently armed watcher may exec
  // it while the entrypoint refreshes a retained volume on start.
  assert.match(entrypoint, /mv -f "\$tmp" "\$HOME_DIR\/\$WATCH_WATCHER"/);
  assert.match(entrypoint, /chmod 0755 "\$tmp"/);
});

/**
 * A herdr server restart rehydrates the persisted session layout as a pane with
 * no live terminal: `pane list` and `agent get` still report the pane and its
 * last agent, but pane run/send-text/process-info return pane_not_found. The
 * entrypoint must prove the terminal before trusting the agent record, replace
 * the restored husk with a fresh live pane, and reconcile a dead watcher lock,
 * or every restart leaves the deployed firstmate idle and notes undrained.
 */
test("the entrypoint replaces a retained herdr husk instead of trusting its agent", () => {
  const entrypoint = readFileSync(ENTRYPOINT, "utf8");
  // The live-terminal probe is the discriminator agent get cannot give.
  assert.match(entrypoint, /herdr_pane_terminal_live\(\)/);
  assert.match(entrypoint, /pane process-info --pane/);
  assert.match(entrypoint, /pane_not_found/);
  // A husk pane is replaced, not accepted as a live harness.
  assert.match(entrypoint, /ensure_primary_pane\(\)/);
  assert.match(entrypoint, /herdr_cli workspace close "\$wsid"/);
  assert.match(entrypoint, /retained husk with no live terminal/);
  // A dead watcher lock left by a previous container is reconciled, while the
  // durable recovery marker is left for the watcher to resurface.
  assert.match(entrypoint, /reconcile_dead_watcher_lock\(\)/);
  assert.match(entrypoint, /\.watch\.lock/);
  assert.match(entrypoint, /state\/\.watcher-down and state\/\.wake-queue/);
});

/**
 * A per-user firstmate run by the multi-user gateway gets its provider key only
 * by pulling it from the gateway at start (no key in any Secret). The fetch has
 * to happen before the herdr server starts, because the server hands its
 * environment to every pane; the token must leave the environment first and
 * must never be on a command line. entrypoint.test.sh drives all of it against
 * a fake gateway.
 */
test("the entrypoint fetches a managed firstmate's credentials before the herdr server, token kept off argv", () => {
  const entrypoint = readFileSync(ENTRYPOINT, "utf8");
  const fetchAt = entrypoint.indexOf("fetch_tenant_credentials || exit 1");
  const serverAt = entrypoint.indexOf('herdr server --session "$SESSION" &');
  assert.ok(fetchAt > 0, "the fetch runs when FM_TENANT_CREDENTIALS_URL is set");
  assert.ok(serverAt > fetchAt, "the herdr server starts after the fetch");
  assert.match(entrypoint, /unset FM_TENANT_CREDENTIALS_TOKEN/);
  // The bearer reaches curl on stdin, never as an argument another process can read.
  assert.match(entrypoint, /printf 'Authorization: Bearer %s\\n' "\$1" \\\n\s+\| curl [^\n]*\\\n\s+-H @- /);
  assert.doesNotMatch(entrypoint, /curl[^\n]*(\$token|\$1|TOKEN)/);
  assert.match(entrypoint, /--max-redirs 0/);
  // Only the names the gateway declared are exported, and a delivery without
  // the provider key is refused rather than starting a keyless harness.
  assert.match(entrypoint, /FM_TENANT_CREDENTIAL_ENVS/);
  assert.match(entrypoint, /refusing to start a keyless harness/);
});
