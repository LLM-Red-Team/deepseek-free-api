"use strict";

import environment from "@/lib/environment.ts";
import config from "@/lib/config.ts";
import { initializeService } from "@/lib/initialize.ts";
import server from "@/lib/server.ts";
import routes from "@/api/routes/index.ts";
import logger from "@/lib/logger.ts";

const startupTime = performance.now();

(async () => {
  logger.header();

  logger.info("<<<< deepseek free server >>>>");
  logger.info("Version:", environment.package.version);
  logger.info("Process id:", process.pid);
  logger.info("Environment:", environment.env);
  logger.info("Service name:", config.service.name);

  // Wait for service initialization
  await initializeService();

  server.attachRoutes(routes);
  await server.listen();

  config.service.bindAddress &&
    logger.success("Service bind address:", config.service.bindAddress);
})()
  .then(() =>
    logger.success(
      `Service startup completed (${Math.floor(performance.now() - startupTime)}ms)`
    )
  )
  .catch((err) => {
    logger.error('Fatal error during startup:', err);
    process.exit(1);
  });
