import { isAbsolute, resolve } from "node:path";

import { ConfigError, configFilePath, readConfigFile } from "./config.js";
import { GatewayConfigError, resolveGatewayDbPath, resolveVault } from "./gateway-config.js";
import { openGatewayStore } from "./gateway-store.js";

/**
 * `walkie-talkie vault rotate`: re-seal every stored credential under the
 * active vault key, in one transaction.
 *
 * Run it in the gateway's own container after a new key has been added to
 * the keyring (FM_WT_VAULT_KEYS) and made active (FM_WT_VAULT_ACTIVE_KEY); it
 * reads the same settings and store the gateway does. Once it reports every
 * row current, the old key id can leave the keyring. It prints counts and key
 * ids only, never a credential.
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
