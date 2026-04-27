import { prisma } from "~/db.server.js";
import { getConfig } from "~/config/app-config.js";

export async function initStaleRecovery(): Promise<void> {
  const config = getConfig();
  const cutoff = new Date(
    Date.now() - config.syncStaleTimeoutMinutes * 60 * 1000,
  );

  const result = await prisma.syncRun.updateMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      errorMessage: "Marked as stale on server restart",
      completedAt: new Date(),
    },
  });

  if (result.count > 0) {
    console.log(
      JSON.stringify({
        level: "warn",
        timestamp: new Date().toISOString(),
        message: `Stale recovery: marked ${result.count} stuck sync run(s) as FAILED`,
      }),
    );
  }
}
