import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { ConfigError, configFilePath, readConfigFile } from "./config.js";
import { GatewayConfigError, resolveCatalog, resolveGatewayDbPath, resolveTenantParams } from "./gateway-config.js";
import { openGatewayStore, type TenantOwner } from "./gateway-store.js";
import { tenantRuns, tenantSpec } from "./reconciler.js";
import { buildTenantObjects, type KubeObject } from "./tenant-objects.js";
import type { CliIo } from "./vault-cli.js";

/**
 * `walkie-talkie tenants render [--user <login>]`: print the cluster objects
 * the reconciler applies for each managed firstmate (or one user's), for
 * review and audit.
 *
 * It reads the same settings and store the gateway does and changes nothing.
 * The output is one JSON document per object, separated by `---`, which is
 * also valid YAML. The two internal tokens in each tenant's Secret are the one
 * thing not printed: their values are replaced by `<redacted>`, so the command
 * needs no secret and its output can be shared.
 */

export const TENANTS_USAGE = "usage: walkie-talkie tenants render [--user <login>]";
export const REDACTED = "<redacted>";

/** A tenant's objects in apply order, with the Secret's values redacted. */
function renderTenant(objects: ReturnType<typeof buildTenantObjects>): KubeObject[] {
  const secret = { ...objects.secret, data: Object.fromEntries(Object.keys(objects.secret.data as object).map((key) => [key, REDACTED])) };
  return [secret, objects.configMap, objects.service, objects.statefulSet];
}

function parseArgs(args: string[]): { user: string | null } | null {
  if (args[0] !== "render") return null;
  const rest = args.slice(1);
  if (rest.length === 0) return { user: null };
  if (rest.length === 2 && rest[0] === "--user" && rest[1] !== undefined && rest[1] !== "") {
    return { user: rest[1].replace(/^@/, "") };
  }
  return null;
}

/** Run a `tenants` subcommand; resolves to the process exit code. */
export async function runTenantsCommand(args: string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === null) {
    io.err(TENANTS_USAGE);
    return 2;
  }
  const resolvePath = (path: string): string => (isAbsolute(path) ? path : resolve(io.cwd, path));
  let dbPath: string;
  let params;
  let catalog;
  try {
    const file = readConfigFile(configFilePath(io.env, io.cwd));
    dbPath = resolveGatewayDbPath(io.env, file, resolvePath);
    params = resolveTenantParams(io.env, file, resolvePath);
    catalog = resolveCatalog(io.env, file, resolvePath);
  } catch (error) {
    io.err(error instanceof ConfigError || error instanceof GatewayConfigError ? error.message : String(error));
    return 1;
  }
  if (params === null || catalog === null) {
    io.err("tenants render needs FM_WT_TENANT_PARAMS and FM_WT_CATALOG, as the gateway has them");
    return 1;
  }
  if (!existsSync(dbPath)) {
    io.err(`no gateway store at ${dbPath}`);
    return 1;
  }

  const store = await openGatewayStore(dbPath);
  try {
    let owners: TenantOwner[] = store.listTenants();
    if (parsed.user !== null) {
      const wanted = parsed.user.toLowerCase();
      owners = owners.filter((owner) => owner.login.toLowerCase() === wanted);
      if (owners.length === 0) {
        io.err(`@${parsed.user} has no managed firstmate`);
        return 1;
      }
    }
    const documents: string[] = [];
    for (const owner of owners) {
      if (owner.desired === "none") {
        io.err(`tenant ${owner.tid} (@${owner.login}): not started, nothing is applied`);
        continue;
      }
      const spec = tenantSpec(owner, store.modelChoice(owner.userId), catalog, { api: REDACTED, credentials: REDACTED, epoch: REDACTED });
      if (spec === null) {
        const applied = tenantRuns(owner) ? "nothing is applied" : "its StatefulSet is scaled to zero, nothing else is applied";
        io.err(`tenant ${owner.tid} (@${owner.login}): its model choice is not in the catalog; ${applied}`);
        continue;
      }
      const header = `# tenant ${owner.tid} (@${owner.login}): desired ${owner.desired}, user ${owner.userState}`;
      for (const object of renderTenant(buildTenantObjects(params, spec))) {
        documents.push(`${header}\n${JSON.stringify(object, null, 2)}`);
      }
    }
    if (documents.length > 0) io.out(`---\n${documents.join("\n---\n")}`);
    return 0;
  } finally {
    store.close();
  }
}
