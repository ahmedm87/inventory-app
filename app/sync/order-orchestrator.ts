import { prisma } from "~/db.server.js";
import { getNamespacedConfig } from "~/config/app-config.js";
import { pollNewOrders } from "./order-poller.js";
import { assignWarehouse } from "./order-assignment.js";
import { getWarehouseClient } from "./warehouse-client.js";
import { syncLog } from "~/sync/sync-logger.js";
import type { OrderProcessingStatus } from "@prisma/client";

let isProcessing = false;

// ─── State machine ───

const ALLOWED_TRANSITIONS: Record<string, OrderProcessingStatus[]> = {
  PENDING: ["ASSIGNING", "CANCELLED"],
  ASSIGNING: ["ASSIGNED", "PENDING"],
  ASSIGNED: ["FULFILLMENT_SENT", "REASSIGNING", "CANCELLED"],
  FULFILLMENT_SENT: ["FULFILLED", "REASSIGNING", "CANCELLED"],
  REASSIGNING: ["FULFILLMENT_SENT", "REASSIGNMENT_FAILED"],
  REASSIGNMENT_FAILED: [],
  FULFILLED: [],
  CANCELLED: [],
};

export async function transitionOrderStatus(
  orderId: string,
  fromStatus: OrderProcessingStatus,
  toStatus: OrderProcessingStatus,
  extraData?: Record<string, unknown>,
): Promise<boolean> {
  const allowed = ALLOWED_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    syncLog("warn", "Invalid state transition attempted", {
      orderId,
      fromStatus,
      toStatus,
    });
    return false;
  }

  const result = await prisma.order.updateMany({
    where: { id: orderId, processingStatus: fromStatus },
    data: { processingStatus: toStatus, ...extraData },
  });

  return result.count > 0;
}

// ─── Stale recovery ───

const STALE_ASSIGNING_TIMEOUT_MS = 10 * 60 * 1000;

async function recoverStaleAssigningOrders(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_ASSIGNING_TIMEOUT_MS);

  const result = await prisma.order.updateMany({
    where: {
      processingStatus: "ASSIGNING",
      updatedAt: { lt: cutoff },
    },
    data: { processingStatus: "PENDING" },
  });

  if (result.count > 0) {
    syncLog("warn", `Reset ${result.count} stale ASSIGNING orders to PENDING`);
  }
}

// ─── Main orchestrator ───

export async function runOrderProcessing(
  triggeredBy: string = "cron",
): Promise<void> {
  const config = getNamespacedConfig();
  if (!config.order) {
    return;
  }

  if (isProcessing) {
    syncLog("info", "Order processing already in progress (in-memory guard)");
    return;
  }

  isProcessing = true;

  const syncRun = await prisma.syncRun.create({
    data: { status: "RUNNING", triggeredBy, source: "order-processing" },
  });

  syncLog("info", "Order processing started", {
    syncRunId: syncRun.id,
    triggeredBy,
  });

  try {
    // Recover stale orders first
    await recoverStaleAssigningOrders();

    // Poll new orders
    const newOrders = await pollNewOrders();

    // Also pick up retryable orders (PENDING from stale recovery, ASSIGNED from failed fulfillment)
    const pendingOrders = await prisma.order.findMany({
      where: {
        processingStatus: { in: ["PENDING", "ASSIGNED"] },
      },
      include: { lineItems: true },
    });

    // Load all stock levels and warehouses
    const stockLevels = await prisma.stockLevel.findMany();
    const warehouses = await prisma.warehouse.findMany({
      where: { isActive: true },
    });

    let processed = 0;
    let assigned = 0;
    let fulfilled = 0;
    let errors = 0;

    for (const order of pendingOrders) {
      try {
        if (order.processingStatus === "PENDING") {
          // Claim the order: PENDING -> ASSIGNING
          const claimed = await transitionOrderStatus(
            order.id,
            "PENDING",
            "ASSIGNING",
          );
          if (!claimed) continue; // Another process claimed it

          // Assign warehouse
          const assignment = assignWarehouse(
            {
              destinationCountryCode: order.destinationCountryCode || "",
              lineItems: order.lineItems.map((li) => ({
                sku: li.sku,
                quantity: li.quantity,
              })),
            },
            stockLevels,
            warehouses,
          );

          // ASSIGNING -> ASSIGNED
          const assignedOk = await transitionOrderStatus(
            order.id,
            "ASSIGNING",
            "ASSIGNED",
            {
              assignedWarehouseId: assignment.warehouseId,
              assignmentReason: assignment.reason,
              assignedAt: new Date(),
            },
          );
          if (!assignedOk) {
            syncLog("warn", "Failed to transition to ASSIGNED", {
              orderId: order.id,
            });
            continue;
          }
          assigned++;
        }

        // Now send fulfillment request (for both newly assigned and retry)
        const currentOrder = await prisma.order.findUnique({
          where: { id: order.id },
          include: {
            lineItems: true,
            assignedWarehouse: true,
          },
        });

        if (
          !currentOrder ||
          currentOrder.processingStatus !== "ASSIGNED" ||
          !currentOrder.assignedWarehouse
        ) {
          continue;
        }

        const warehouse = currentOrder.assignedWarehouse;
        const client = getWarehouseClient(warehouse);

        const result = await client.createOrder({
          referenceId: currentOrder.shopifyOrderId,
          orderNumber: currentOrder.shopifyOrderNumber || currentOrder.shopifyOrderId,
          recipientName: currentOrder.customerEmail || "Customer",
          recipientEmail: currentOrder.customerEmail || "",
          shippingAddress: {
            address1: "",
            city: "",
            state: "",
            country: currentOrder.destinationCountryCode || "",
            zipCode: "",
          },
          lineItems: currentOrder.lineItems.map((li) => ({
            sku: li.sku,
            quantity: li.quantity,
            name: li.productTitle,
          })),
        });

        // Create fulfillment request record
        await prisma.fulfillmentRequest.create({
          data: {
            orderId: currentOrder.id,
            warehouseId: warehouse.id,
            externalRequestId: result.externalId,
            status: "SENT",
            sentAt: new Date(),
          },
        });

        // ASSIGNED -> FULFILLMENT_SENT
        await transitionOrderStatus(
          currentOrder.id,
          "ASSIGNED",
          "FULFILLMENT_SENT",
        );
        fulfilled++;

        syncLog("info", "Fulfillment request sent", {
          orderId: currentOrder.id,
          warehouseId: warehouse.id,
          warehouseName: warehouse.name,
          externalId: result.externalId,
        });
      } catch (err) {
        errors++;
        syncLog("error", "Failed to process order", {
          orderId: order.id,
          error: String(err),
        });
        // Order stays in current retryable state (ASSIGNING or ASSIGNED)
        // ASSIGNING will be recovered by stale recovery on next cycle
        if (order.processingStatus === "ASSIGNING" || (order as { processingStatus: string }).processingStatus === "ASSIGNING") {
          await transitionOrderStatus(order.id, "ASSIGNING", "PENDING");
        }
      } finally {
        processed++;
      }
    }

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        totalProcessed: processed,
        totalUpdated: fulfilled,
        totalErrors: errors,
      },
    });

    syncLog("info", "Order processing completed", {
      syncRunId: syncRun.id,
      newOrdersPolled: newOrders.length,
      totalProcessed: processed,
      assigned,
      fulfilled,
      errors,
    });
  } catch (err) {
    syncLog("error", "Order processing failed", {
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
  } finally {
    isProcessing = false;
  }
}
