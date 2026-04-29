import { prisma } from "~/db.server.js";
import { getWarehouseClient } from "./warehouse-client.js";
import { transitionOrderStatus } from "./order-orchestrator.js";
import { syncLog } from "~/sync/sync-logger.js";

export async function reassignOrder(
  orderId: string,
  newWarehouseId: string,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      assignedWarehouse: true,
      lineItems: true,
      fulfillmentRequests: {
        where: { status: { in: ["SENT", "ACKNOWLEDGED", "PENDING"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  if (!order) {
    throw new Error("Order not found");
  }

  if (
    order.processingStatus !== "ASSIGNED" &&
    order.processingStatus !== "FULFILLMENT_SENT"
  ) {
    throw new Error(
      `Cannot reassign order in ${order.processingStatus} status. Only ASSIGNED or FULFILLMENT_SENT orders can be reassigned.`,
    );
  }

  const newWarehouse = await prisma.warehouse.findUnique({
    where: { id: newWarehouseId },
  });

  if (!newWarehouse || !newWarehouse.isActive) {
    throw new Error("Target warehouse not found or inactive");
  }

  // Transition to REASSIGNING
  const transitioned = await transitionOrderStatus(
    orderId,
    order.processingStatus,
    "REASSIGNING",
  );

  if (!transitioned) {
    throw new Error("Failed to transition order to REASSIGNING (concurrent modification)");
  }

  syncLog("info", "Starting order reassignment", {
    orderId,
    fromWarehouse: order.assignedWarehouse?.name,
    toWarehouse: newWarehouse.name,
  });

  // Step 1: Cancel at original warehouse
  const activeRequest = order.fulfillmentRequests[0];
  if (activeRequest && activeRequest.externalRequestId) {
    try {
      const oldClient = getWarehouseClient(order.assignedWarehouse!);
      await oldClient.cancelOrder(activeRequest.externalRequestId);
      await prisma.fulfillmentRequest.update({
        where: { id: activeRequest.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });
    } catch (err) {
      syncLog("error", "Failed to cancel at original warehouse", {
        orderId,
        error: String(err),
      });
      // Revert: REASSIGNING -> back to original state
      await transitionOrderStatus(orderId, "REASSIGNING", "FULFILLMENT_SENT");
      throw new Error(`Failed to cancel at original warehouse: ${err}`);
    }
  }

  // Step 2: Create at new warehouse
  try {
    const newClient = getWarehouseClient(newWarehouse);
    const result = await newClient.createOrder({
      referenceId: order.shopifyOrderId,
      orderNumber: order.shopifyOrderNumber || order.shopifyOrderId,
      recipientName: order.customerEmail || "Customer",
      recipientEmail: order.customerEmail || "",
      shippingAddress: {
        address1: "",
        city: "",
        state: "",
        country: order.destinationCountryCode || "",
        zipCode: "",
      },
      lineItems: order.lineItems.map((li) => ({
        sku: li.sku,
        quantity: li.quantity,
        name: li.productTitle,
      })),
    });

    // Create new fulfillment request
    await prisma.fulfillmentRequest.create({
      data: {
        orderId,
        warehouseId: newWarehouseId,
        externalRequestId: result.externalId,
        status: "SENT",
        sentAt: new Date(),
      },
    });

    // Transition REASSIGNING -> FULFILLMENT_SENT
    await transitionOrderStatus(orderId, "REASSIGNING", "FULFILLMENT_SENT", {
      assignedWarehouseId: newWarehouseId,
      assignmentReason: `Manually reassigned to ${newWarehouse.name}`,
    });

    syncLog("info", "Order reassignment completed", {
      orderId,
      newWarehouse: newWarehouse.name,
      externalId: result.externalId,
    });
  } catch (err) {
    // COMPENSATION FAILURE: cancel succeeded but re-create failed
    syncLog("alert", "REASSIGNMENT COMPENSATION FAILURE", {
      orderId,
      fromWarehouse: order.assignedWarehouse?.name,
      toWarehouse: newWarehouse.name,
      error: String(err),
    });

    await transitionOrderStatus(orderId, "REASSIGNING", "REASSIGNMENT_FAILED", {
      requiresManualIntervention: true,
      manualInterventionReason: `Cancel at ${order.assignedWarehouse?.name || "original warehouse"} succeeded but order creation at ${newWarehouse.name} failed: ${err}. Order needs manual re-submission.`,
    });

    throw new Error(
      `Reassignment partially failed: cancel succeeded but re-create at ${newWarehouse.name} failed. Order flagged for manual intervention.`,
    );
  }
}
