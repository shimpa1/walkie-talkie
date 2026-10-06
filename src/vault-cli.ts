import { isAbsolute, resolve } from "node:path";

import { ConfigError, configFilePath, readConfigFile } from "./config.js";
import { GatewayConfigError, resolveGatewayDbPath, resolveVault } from "./gateway-config.js";
import { openGatewayStore, type GatewayStore, type RotationResult } from "./gateway-store.js";
import type { Vault } from "./vault.js";

/**
 * `walkie-talkie vault rotate`: re-seal every stored credential under the
 * active vault key, in one transaction.
 *
 * The gateway does the same by itself at start-up (resealOnStart below), so a
 * rotation needs no command; this stays for audit and recovery. It reads the
 * same settings and store the gateway does. Once it reports every row
 * current, the old key id can leave the keyring. It prints counts and key ids
 * only, never a credential.
 */

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export const VAULT_USAGE = "usage: walkie-talkie vault rotate";

/** Run a `vault` subcommand; resolves to the process exit code. */
export async function runVaultCommand(args: string[], io: CliIo): Promise<number> {
  if (args.length !== 1 || args[0] !== "rotate") {
    io.err(VAULT_USAGE);
    return 2;
  }
  let dbPath: string;
  let vault;
  try {
    const file = readConfigFile(configFilePath(io.env, io.cwd));
    dbPath = resolveGatewayDbPath(io.env, file, (path) => (isAbsolute(path) ? path : resolve(io.cwd, path)));
    vault = resolveVault(io.env, file);
  } catch (error) {
    io.err(error instanceof ConfigError || error instanceof GatewayConfigError ? error.message : String(error));
    return 1;
  }
  if (vault === null) {
    io.err("vault rotate needs FM_WT_VAULT_KEYS (and FM_WT_VAULT_ACTIVE_KEY) in the environment");
    return 1;
  }

  const store = await openGatewayStore(dbPath);
  try {
    const result = store.rotateCredentials(vault);
    io.out(
      `vault rotate: ${result.rotated} credential(s) re-sealed under ${vault.activeKid}, ` +
        `${result.current} already current; every credential is now under ${vault.activeKid}`,
    );
    return 0;
  } catch (error) {
    io.err(`vault rotate failed, nothing changed: ${error instanceof Error ? error.message : "error"}`);
    return 1;
  } finally {
    store.close();
  }
}

/**
 * At gateway start-up, re-seal every credential still under a key id other
 * than the active one. Rotating the vault key is then a values change (the new
 * active id) plus a Doppler change (the keyring) and nothing else: the
 * restarted gateway moves every row itself. The rotation is all-or-nothing; a
 * row that will not open (its key left the keyring) is logged by owner and
 * slot only, nothing changes, and the gateway keeps starting. Returns what it
 * did, or null when it could not.
 */
export function resealOnStart(store: GatewayStore, vault: Vault, log: (line: string) => void, now: number): RotationResult | null {
  if (store.countCredentialsNotUnder(vault.activeKid) === 0) return { rotated: 0, current: 0 };
  try {
    const result = store.rotateCredentials(vault);
    store.audit({ at: now, actor: null, action: "vault.resealed", subject: null, detail: { kid: vault.activeKid, rotated: result.rotated } });
    log(`vault: re-sealed ${result.rotated} credential(s) under ${vault.activeKid} at start-up`);
    return result;
  } catch (error) {
    log(`vault: re-seal at start-up failed, nothing changed: ${error instanceof Error ? error.message : "error"}`);
    return null;
  }
}
