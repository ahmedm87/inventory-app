import { prisma } from "~/db.server.js";
import { getNamespacedConfig } from "~/config/app-config.js";
import { getWarehouseClient } from "~/sync/warehouse-client.js";
import { pushStockLevelsToShopify } from "~/sync/shopify-inventory.js";
import { syncLog } from "~/sync/sync-logger.js";

let isSyncing = false;

export async function runStockSync(
  triggeredBy: string = "cron",
): Promise<string | null> {
  if (isSyncing) {
    syncLog("info", "Stock sync already in progress (in-memory guard)");
    return null;
  }

  const config = getNamespacedConfig();
  const staleTimeout = config.core.syncStaleTimeoutMinutes * 60 * 1000;

  const existingRun = await prisma.syncRun.findFirst({
    where: { status: "RUNNING", source: "stock-all" },
    orderBy: { startedAt: "desc" },
  });

  if (existingRun) {
    const age = Date.now() - existingRun.startedAt.getTime();
    if (age < staleTimeout) {
      syncLog("info", "Stock sync already in progress (DB guard)", {
        syncRunId: existingRun.id,
        startedAt: existingRun.startedAt.toISOString(),
      });
      return null;
    }

    await prisma.syncRun.update({
      where: { id: existingRun.id },
      data: {
        status: "FAILED",
        errorMessage: "Marked as stale by new stock sync attempt",
        completedAt: new Date(),
      },
    });
    syncLog("warn", "Marked stale stock sync as FAILED", {
      syncRunId: existingRun.id,
    });
  }

  const syncRun = await prisma.syncRun.create({
    data: { status: "RUNNING", triggeredBy, source: "stock-all" },
  });

  isSyncing = true;
  syncLog("info", "Stock sync started", {
    syncRunId: syncRun.id,
    triggeredBy,
  });

  try {
    const warehouses = await prisma.warehouse.findMany({
      where: { isActive: true },
    });

    let totalUpdated = 0;
    let totalErrors = 0;
    let totalProcessed = 0;

    for (const warehouse of warehouses) {
      try {
        const client = getWarehouseClient(warehouse);
        const inventory = await client.fetchInventory();

        let warehouseUpdated = 0;
        for (const [sku, quantity] of inventory) {
          await prisma.stockLevel.upsert({
            where: {
              warehouseId_sku: {
                warehouseId: warehouse.id,
                sku,
              },
            },
            update: {
              quantity,
              lastSyncedAt: new Date(),
            },
            create: {
              warehouseId: warehouse.id,
              sku,
              quantity,
              lastSyncedAt: new Date(),
            },
          });
          warehouseUpdated++;
        }

        totalUpdated += warehouseUpdated;
        totalProcessed += inventory.size;

        syncLog("info", `Stock synced for ${warehouse.name}`, {
          warehouseId: warehouse.id,
          warehouseName: warehouse.name,
          skuCount: inventory.size,
        });
      } catch (err) {
        totalErrors++;
        syncLog("error", `Stock sync failed for ${warehouse.name}`, {
          warehouseId: warehouse.id,
          warehouseName: warehouse.name,
          error: String(err),
        });
      }
    }

    // Push to Shopify
    try {
      const pushResult = await pushStockLevelsToShopify();
      syncLog("info", "Pushed stock levels to Shopify", {
        totalPushed: pushResult.totalPushed,
        totalFailed: pushResult.totalFailed,
      });
    } catch (err) {
      syncLog("error", "Failed to push stock levels to Shopify", {
        error: String(err),
      });
      totalErrors++;
    }

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        totalProcessed,
        totalUpdated,
        totalErrors,
      },
    });

    syncLog("info", "Stock sync completed", {
      syncRunId: syncRun.id,
      totalProcessed,
      totalUpdated,
      totalErrors,
    });

    return syncRun.id;
  } catch (err) {
    syncLog("error", "Stock sync failed with uncaught exception", {
      syncRunId: syncRun.id,
      error: String(err),
    });

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorMessage: String(err),
      },
    });

    return syncRun.id;
  } finally {
    isSyncing = false;
  }
}
