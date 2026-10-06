#!/usr/bin/env node
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, resolveConfig, type AppConfig } from "./config.js";
import { Conversations } from "./conversations.js";
import { OpencodeStore } from "./conversation-store.js";
import { createFleetStateProvider } from "./fleet-state.js";
import { Firstmate } from "./firstmate.js";
import { Herdr } from "./herdr.js";
import { PushStore } from "./push-store.js";
import { createGatewayHandler } from "./gateway.js";
import { openGatewayStore } from "./gateway-store.js";
import { GithubOAuth } from "./github-oauth.js";
import { inClusterKube } from "./kube.js";
import { TenantReconciler } from "./reconciler.js";
import { createDeliveryHandler } from "./tenant-delivery.js";
import { runTenantsCommand } from "./tenants-cli.js";
import { FirstmateEventSource, PushService } from "./push-service.js";
import { describeBind, listenOn, startServer } from "./server.js";
import { runVaultCommand } from "./vault-cli.js";
import {
  generateVapidKeys,
  HttpPushSender,
  isValidVapidKeyPair,
  type VapidKeys,
} from "./webpush.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(here, "..", "..");

/**
 * Use the configured VAPID pair, else a previously persisted one, else generate
 * and persist a fresh pair. The private key never leaves the gitignored store.
 */
function resolveVapidKeys(
  config: AppConfig,
  store: PushStore,
  log: (line: string) => void,
): VapidKeys {
  if (config.vapidPublicKey !== null && config.vapidPrivateKey !== null) {
    if (!isValidVapidKeyPair(config.vapidPublicKey, config.vapidPrivateKey)) {
      throw new ConfigError("the configured VAPID key pair is not a valid P-256 public/private pair");
    }
    const keys = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
    store.setVapid(keys);
    return keys;
  }
  const stored = store.getVapid();
  if (stored !== null && isValidVapidKeyPair(stored.publicKey, stored.privateKey)) {
    return stored;
  }
  const generated = generateVapidKeys();
  store.setVapid(generated);
  log(`generated a VAPID key pair in ${config.pushStorePath}`);
  return generated;
}

/** Expired sessions and abandoned sign-ins are swept this often. */
const GATEWAY_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Gateway mode: the multi-user front door. It runs no firstmate scripts and
 * reads no firstmate home; it signs users in and forwards each one's API calls
 * to that user's own firstmate.
 */
async function runGateway(config: AppConfig, log: (line: string) => void): Promise<void> {
  const gateway = config.gateway;
  if (gateway === null) throw new ConfigError("gateway mode is missing its configuration");
  const store = await openGatewayStore(gateway.dbPath);
  const oauth = new GithubOAuth({
    clientId: gateway.githubClientId,
    clientSecret: gateway.githubClientSecret,
    redirectUri: `${gateway.publicOrigin}/auth/github/callback`,
  });
  const purge = setInterval(() => store.purgeExpired(Date.now()), GATEWAY_PURGE_INTERVAL_MS);
  purge.unref();

  // Per-user firstmates: credential delivery on the internal port, and the
  // reconciler that keeps their cluster objects matching the store.
  let internal: Server | null = null;
  let reconciler: TenantReconciler | null = null;
  const provisioning = gateway.tenants;
  if (provisioning !== null && gateway.catalog !== null && gateway.vault !== null) {
    if (provisioning.internalPort === config.port) {
      throw new ConfigError("FM_WT_INTERNAL_PORT must differ from FM_WT_PORT: the internal port is never public");
    }
    const delivery = createDeliveryHandler({
      store,
      vault: gateway.vault,
      catalog: gateway.catalog,
      tokens: provisioning.tokens,
      now: Date.now,
      log,
    });
    internal = listenOn(createServer(delivery), { ...config, port: provisioning.internalPort }, (port) => {
      process.stdout.write(`walkie-talkie gateway credential delivery on ${describeBind(config, port)}\n`);
    });
    const kube = inClusterKube(provisioning.params.namespace);
    if (kube === null) {
      log("tenant provisioning: no in-cluster Kubernetes API; the reconciler is off");
    } else {
      reconciler = new TenantReconciler({
        store,
        kube,
        params: provisioning.params,
        catalog: gateway.catalog,
        tokens: provisioning.tokens,
        now: Date.now,
        log,
      });
      reconciler.start();
    }
  }

  const server = listenOn(createServer(createGatewayHandler({ config, store, oauth, log, reconciler })), config, (port) => {
    process.stdout.write(
      `walkie-talkie gateway listening on ${describeBind(config, port)}; ` +
        `${gateway.staticTenants.length} static tenant(s), ${gateway.admins.length} admin(s)\n`,
    );
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    process.stderr.write(`walkie-talkie: ${signal}, shutting down\n`);
    clearInterval(purge);
    internal?.close();
    void (reconciler?.stop() ?? Promise.resolve()).then(() =>
      server.close(() => {
        store.close();
        process.exit(0);
      }),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function main(): void {
  let config: AppConfig;
  try {
    config = resolveConfig({ publicDirFallback: resolve(projectRoot, "public") });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`walkie-talkie: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const log = (line: string): void => {
    process.stderr.write(`walkie-talkie: ${line}\n`);
  };

  if (config.mode === "gateway") {
    runGateway(config, log).catch((error: unknown) => {
      process.stderr.write(`walkie-talkie: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
    return;
  }

  const firstmate = new Firstmate({
    binDir: config.fmBin,
    env: { ...process.env, FM_HOME: config.fmHome },
  });

  // The read-only Conversations view reads this pod's own herdr session. It
  // never steers a session: the client only permits pane/tab/workspace reads.
  // The agent's SQLite session store supplies the full conversation history; a
  // missing store falls back to the terminal's visible screen, read-only.
  const conversations = new Conversations(
    new Herdr({
      binPath: config.herdrBin,
      session: config.herdrSession,
      env: { ...process.env, FM_HOME: config.fmHome },
    }),
    new OpencodeStore({ dbPath: config.opencodeDbPath, log }),
    createFleetStateProvider(firstmate),
  );

  let pushService: PushService | null = null;
  try {
    const store = new PushStore(config.pushStorePath);
    const vapid = resolveVapidKeys(config, store, log);
    pushService = new PushService({
      store,
      sender: new HttpPushSender(vapid, config.vapidSubject),
      source: new FirstmateEventSource(firstmate),
      pollSeconds: config.pushPollSeconds,
      log,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`walkie-talkie: ${error.message}\n`);
      process.exit(1);
    }
    log(`push notifications disabled: ${String(error)}`);
  }

  const server = startServer({
    config,
    firstmate,
    conversations,
    ...(pushService !== null ? { push: pushService } : {}),
    log,
    onListen: (port) => {
      process.stdout.write(
        `walkie-talkie listening on ${describeBind(config, port)}; ` +
          `firstmate home ${config.fmHome}\n`,
      );
    },
  });

  pushService?.start();

  const shutdown = (signal: NodeJS.Signals): void => {
    process.stderr.write(`walkie-talkie: ${signal}, shutting down\n`);
    pushService?.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const [command, ...commandArgs] = process.argv.slice(2);
const cli = command === "vault" ? runVaultCommand : command === "tenants" ? runTenantsCommand : null;
if (cli !== null) {
  cli(commandArgs, {
    env: process.env,
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`walkie-talkie: ${line}\n`),
  }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`walkie-talkie: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
} else {
  main();
}
