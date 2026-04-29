import { prisma } from "~/db.server.js";
import { getNamespacedConfig } from "~/config/app-config.js";
import { getWarehouseClient } from "./warehouse-client.js";
import { createShopifyFulfillment } from "./shopify-fulfillment.js";
import { transitionOrderStatus } from "./order-orchestrator.js";
import { syncLog } from "~/sync/sync-logger.js";

let isSyncing = false;

export async function runTrackingSync(
  triggeredBy: string = "cron",
): Promise<void> {
  const config = getNamespacedConfig();
  if (!config.order) {
    return;
  }

  if (isSyncing) {
    syncLog("info", "Tracking sync already in progress");
    return;
  }

  isSyncing = true;
  syncLog("info", "Tracking sync started", { triggeredBy });

  try {
    const pendingRequests = await prisma.fulfillmentRequest.findMany({
      where: { status: { in: ["SENT", "ACKNOWLEDGED"] } },
      include: {
        order: true,
        warehouse: true,
      },
    });

    let tracked = 0;
    let fulfilled = 0;
    let errors = 0;

    for (const req of pendingRequests) {
      if (!req.externalRequestId) continue;
      if (req.order.processingStatus === "FULFILLED") continue;

      try {
        const client = getWarehouseClient(req.warehouse);
        const tracking = await client.getTracking(req.externalRequestId);

        if (!tracking) continue;

        // Create tracking record (one per fulfillment request)
        const existingTracking = await prisma.trackingUpdate.findFirst({
          where: { fulfillmentRequestId: req.id },
        });

        if (existingTracking) {
          await prisma.trackingUpdate.update({
            where: { id: existingTracking.id },
            data: {
              trackingNumber: tracking.trackingNumber,
              carrier: tracking.carrier,
              trackingUrl: tracking.trackingUrl,
              shippedAt: tracking.shippedAt ? new Date(tracking.shippedAt) : null,
            },
          });
        } else {
          await prisma.trackingUpdate.create({
            data: {
              fulfillmentRequestId: req.id,
              trackingNumber: tracking.trackingNumber,
              carrier: tracking.carrier,
              trackingUrl: tracking.trackingUrl,
              shippedAt: tracking.shippedAt ? new Date(tracking.shippedAt) : null,
            },
          });
        }

        // Update fulfillment request status
        await prisma.fulfillmentRequest.update({
          where: { id: req.id },
          data: { status: "SHIPPED" },
        });

        tracked++;

        // Create Shopify fulfillment
        try {
          await createShopifyFulfillment({
            shopifyOrderId: req.order.shopifyOrderId,
            trackingNumber: tracking.trackingNumber,
            carrier: tracking.carrier,
            locationId: req.warehouse.shopifyLocationId,
          });

          await transitionOrderStatus(
            req.order.id,
            "FULFILLMENT_SENT",
            "FULFILLED",
            { fulfilledAt: new Date() },
          );

          fulfilled++;
        } catch (err) {
          syncLog("error", "Failed to create Shopify fulfillment", {
            orderId: req.order.id,
            error: String(err),
          });
          errors++;
        }
      } catch (err) {
        errors++;
        syncLog("error", "Failed to fetch tracking", {
          fulfillmentRequestId: req.id,
          error: String(err),
        });
      }
    }

    syncLog("info", "Tracking sync completed", {
      totalPending: pendingRequests.length,
      tracked,
      fulfilled,
      errors,
    });
  } catch (err) {
    syncLog("error", "Tracking sync failed", { error: String(err) });
  } finally {
    isSyncing = false;
  }
}
