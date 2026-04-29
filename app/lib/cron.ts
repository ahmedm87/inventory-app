import cron from "node-cron";
import { getConfig, getNamespacedConfig } from "~/config/app-config.js";
import { runSync } from "~/sync/orchestrator.js";
import { runStockSync } from "~/sync/stock-sync.js";

function log(level: string, message: string, extra?: Record<string, unknown>) {
  console.log(
    JSON.stringify({ level, timestamp: new Date().toISOString(), message, ...extra }),
  );
}

export function initCron(): void {
  const config = getConfig();
  const nsConfig = getNamespacedConfig();

  // Legacy Fulfillmen-only sync (backwards compatible)
  if (config.cronEnabled) {
    cron.schedule(config.cronSchedule, () => {
      runSync("cron").catch((err) => {
        log("error", "Cron-triggered sync failed", { error: String(err) });
      });
    });
    log("info", `Legacy sync cron scheduled: ${config.cronSchedule}`);
  } else {
    log("info", "Legacy sync cron disabled via CRON_ENABLED=false");
  }

  // Multi-warehouse stock sync
  if (config.cronEnabled) {
    cron.schedule(config.cronSchedule, () => {
      runStockSync("cron").catch((err) => {
        log("error", "Cron-triggered stock sync failed", { error: String(err) });
      });
    });
    log("info", `Stock sync cron scheduled: ${config.cronSchedule}`);
  }

  // Order processing cron (only if order features enabled)
  if (nsConfig.order?.pollEnabled) {
    cron.schedule(nsConfig.order.pollSchedule, () => {
      import("~/sync/order-orchestrator.js")
        .then((m) => m.runOrderProcessing("cron"))
        .catch((err) => {
          log("error", "Cron-triggered order processing failed", {
            error: String(err),
          });
        });
    });
    log("info", `Order processing cron scheduled: ${nsConfig.order.pollSchedule}`);
  }

  // Tracking sync cron (only if order features enabled)
  if (nsConfig.order?.trackingSyncEnabled) {
    cron.schedule(nsConfig.order.trackingSyncSchedule, () => {
      import("~/sync/tracking-sync.js")
        .then((m) => m.runTrackingSync("cron"))
        .catch((err) => {
          log("error", "Cron-triggered tracking sync failed", {
            error: String(err),
          });
        });
    });
    log("info", `Tracking sync cron scheduled: ${nsConfig.order.trackingSyncSchedule}`);
  }
}
