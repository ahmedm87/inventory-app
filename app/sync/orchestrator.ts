import { prisma } from "~/db.server.js";
import { getConfig } from "~/config/app-config.js";
import { fetchAllInventory } from "~/sync/fulfillmen-client.js";
import {
  fetchAllShopifyVariants,
  batchUpdateInventory,
} from "~/sync/shopify-inventory.js";
import { matchSkus } from "~/sync/sku-matcher.js";
import { syncLog } from "~/sync/sync-logger.js";
import type { SyncEntryStatus } from "@prisma/client";

let isSyncing = false;

export async function runSync(
  triggeredBy: string = "cron",
): Promise<string | null> {
  if (isSyncing) {
    syncLog("info", "Sync already in progress (in-memory guard)");
    return null;
  }

  const config = getConfig();
  const staleTimeout = config.syncStaleTimeoutMinutes * 60 * 1000;

  const existingRun = await prisma.syncRun.findFirst({
    where: { status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });

  if (existingRun) {
    const age = Date.now() - existingRun.startedAt.getTime();
    if (age < staleTimeout) {
      syncLog("info", "Sync already in progress (DB guard)", {
        syncRunId: existingRun.id,
        startedAt: existingRun.startedAt.toISOString(),
      });
      return null;
    }

    await prisma.syncRun.update({
      where: { id: existingRun.id },
      data: {
        status: "FAILED",
        errorMessage: "Marked as stale by new sync attempt",
        completedAt: new Date(),
      },
    });
    syncLog("warn", "Marked stale sync run as FAILED", {
      syncRunId: existingRun.id,
    });
  }

  const syncRun = await prisma.syncRun.create({
    data: { status: "RUNNING", triggeredBy, source: "fulfillmen" },
  });

  isSyncing = true;
  syncLog("info", "Sync started", {
    syncRunId: syncRun.id,
    triggeredBy,
  });

  try {
    const fulfillmenInventory = await fetchAllInventory();
    syncLog("info", `Fetched ${fulfillmenInventory.size} SKUs from Fulfillmen`);

    const shopifyVariants = await fetchAllShopifyVariants();
    syncLog("info", `Fetched ${shopifyVariants.size} SKUs from Shopify`);

    const matches = matchSkus(fulfillmenInventory, shopifyVariants);

    const entries: Array<{
      syncRunId: string;
      sku: string;
      warehouseQty: number;
      shopifyPrevQty: number | null;
      shopifyNewQty: number | null;
      status: SyncEntryStatus;
      warehouseSource: string;
      message: string | null;
    }> = [];

    const updatesToSend: Array<{
      inventoryItemId: string;
      quantity: number;
      sku: string;
    }> = [];

    for (const match of matches) {
      if (match.status === "unmatched") {
        entries.push({
          syncRunId: syncRun.id,
          sku: match.sku,
          warehouseQty: match.warehouseQty,
          shopifyPrevQty: null,
          shopifyNewQty: null,
          status: "UNMATCHED",
          warehouseSource: "fulfillmen",
          message: null,
        });
        continue;
      }

      for (const variant of match.variants) {
        if (variant.currentQuantity === match.warehouseQty) {
          entries.push({
            syncRunId: syncRun.id,
            sku: match.sku,
            warehouseQty: match.warehouseQty,
            shopifyPrevQty: variant.currentQuantity,
            shopifyNewQty: null,
            status: "SKIPPED",
            warehouseSource: "fulfillmen",
            message: "Quantity unchanged",
          });
        } else {
          updatesToSend.push({
            inventoryItemId: variant.inventoryItemId,
            quantity: match.warehouseQty,
            sku: match.sku,
          });
          entries.push({
            syncRunId: syncRun.id,
            sku: match.sku,
            warehouseQty: match.warehouseQty,
            shopifyPrevQty: variant.currentQuantity,
            shopifyNewQty: match.warehouseQty,
            status: match.status === "duplicate" ? "DUPLICATE" : "UPDATED",
            warehouseSource: "fulfillmen",
            message:
              match.status === "duplicate"
                ? `Duplicate SKU: updating ${match.variants.length} variants`
                : null,
          });
        }
      }
    }

    let totalUpdated = 0;
    let totalErrors = 0;

    if (updatesToSend.length > 0) {
      const result = await batchUpdateInventory(
        updatesToSend.map((u) => ({
          inventoryItemId: u.inventoryItemId,
          quantity: u.quantity,
        })),
      );
      totalUpdated = result.succeeded;

      if (result.failed.length > 0) {
        totalErrors = result.failed.length;
        for (const fail of result.failed) {
          const entry = entries.find(
            (e) =>
              e.status !== "UNMATCHED" &&
              e.status !== "SKIPPED" &&
              updatesToSend.some(
                (u) =>
                  u.inventoryItemId === fail.inventoryItemId &&
                  u.sku === e.sku,
              ),
          );
          if (entry) {
            entry.status = "ERROR";
            entry.message = fail.error;
          }
        }
      }
    }

    await prisma.syncEntry.createMany({ data: entries });

    const totalSkipped = entries.filter((e) => e.status === "SKIPPED").length;
    const totalUnmatched = entries.filter(
      (e) => e.status === "UNMATCHED",
    ).length;

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        totalProcessed: entries.length,
        totalUpdated,
        totalSkipped,
        totalUnmatched,
        totalErrors,
      },
    });

    syncLog("info", "Sync completed", {
      syncRunId: syncRun.id,
      totalProcessed: entries.length,
      totalUpdated,
      totalSkipped,
      totalUnmatched,
      totalErrors,
    });

    return syncRun.id;
  } catch (err) {
    syncLog("error", "Sync failed with uncaught exception", {
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
