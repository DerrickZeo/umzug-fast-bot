require("dotenv").config();
const express = require("express");
const pino = require("pino");
const { UmzugAutomator, AUTH_STATE_PATH } = require("./automator");

const log = pino({
  transport: {
    target: "pino-pretty",
    options: { translateTime: "SYS:HH:MM:ss", colorize: true },
  },
});

const cfg = {
  username: process.env.LOGIN_USERNAME,
  password: process.env.LOGIN_PASSWORD,
  baseUrl: process.env.BASE_URL || "https://studenten-umzugshilfe.com",
  // headless: String(process.env.HEADLESS || "true").toLowerCase() === "true",
  pollMs: Number(process.env.POLL_MS || 1000),
  maxPerTick: Number(process.env.MAX_PER_TICK || 3),
  keepAliveMin: Number(process.env.KEEP_ALIVE_MIN || 4),
  port: Number(process.env.PORT || 3001),
};

(async () => {
  const bot = new UmzugAutomator(cfg, log);

  process.on("SIGINT", async () => {
    log.warn("SIGINT received, shutting down…");
    await bot.cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    log.warn("SIGTERM received, shutting down…");
    await bot.cleanup();
    process.exit(0);
  });

  try {
    log.info("Starting Umzug Fast bot…");
    await bot.initialize();
    await bot.startWatcher();

    const app = express();
    app.get("/health", (_req, res) => {
      res.json({
        ready: bot.ready,
        isLoggedIn: bot.isLoggedIn,
        lastTick: bot.stats.lastTick,
        acceptedTotal: bot.stats.accepted,
        triedTotal: bot.stats.tried,
        errorsTotal: bot.stats.errors,
        lastAcceptKey: bot.stats.lastAcceptKey,
        storageStateExists: require("fs").existsSync(AUTH_STATE_PATH),
      });
    });

    app.listen(cfg.port, () => {
      log.info(`Health server on :${cfg.port} (GET /health)`);
    });
  } catch (err) {
    log.error(err, "Fatal during startup");
    process.exit(1);
  }
})();
