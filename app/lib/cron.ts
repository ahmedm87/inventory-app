import cron from "node-cron";
import { getConfig } from "~/config/app-config.js";
import { runSync } from "~/sync/orchestrator.js";

export function initCron(): void {
  const config = getConfig();

  if (!config.cronEnabled) {
    console.log(
      JSON.stringify({
        level: "info",
        timestamp: new Date().toISOString(),
        message: "Cron disabled via CRON_ENABLED=false",
      }),
    );
    return;
  }

  cron.schedule(config.cronSchedule, () => {
    runSync("cron").catch((err) => {
      console.log(
        JSON.stringify({
          level: "error",
          timestamp: new Date().toISOString(),
          message: "Cron-triggered sync failed",
          error: String(err),
        }),
      );
    });
  });

  console.log(
    JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      message: `Cron scheduled: ${config.cronSchedule}`,
    }),
  );
}
