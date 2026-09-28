#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, resolveConfig } from "./config.js";
import { Firstmate } from "./firstmate.js";
import { describeBind, startServer } from "./server.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(here, "..", "..");

function main(): void {
  let config;
  try {
    config = resolveConfig({ publicDirFallback: resolve(projectRoot, "public") });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`walkie-talkie: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const firstmate = new Firstmate({
    binDir: config.fmBin,
    env: { ...process.env, FM_HOME: config.fmHome },
  });

  const server = startServer({
    config,
    firstmate,
    log: (line) => process.stderr.write(`walkie-talkie: ${line}\n`),
    onListen: (port) => {
      process.stdout.write(
        `walkie-talkie listening on ${describeBind(config, port)}; ` +
          `firstmate home ${config.fmHome}\n`,
      );
    },
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    process.stderr.write(`walkie-talkie: ${signal}, shutting down\n`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
