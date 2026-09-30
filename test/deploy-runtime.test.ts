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
  assert.match(
    dockerfile,
    /git -C \/opt\/firstmate apply .*0001-opencode-arm-without-task\.patch/,
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

test("the entrypoint refreshes the patched watch-arm plugin into the home", () => {
  const entrypoint = readFileSync(ENTRYPOINT, "utf8");
  assert.match(entrypoint, /fm-primary-watch-arm\.js/);
  assert.match(
    entrypoint,
    /cp -f "\$SEED_DIR\/\$WATCH_ARM_PLUGIN" "\$HOME_DIR\/\$WATCH_ARM_PLUGIN"/,
  );
});
