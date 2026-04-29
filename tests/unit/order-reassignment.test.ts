import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockCancelOrder, mockCreateOrder } = vi.hoisted(() => {
  const mockPrisma = {
    order: { findUnique: vi.fn(), updateMany: vi.fn() },
    warehouse: { findUnique: vi.fn() },
    fulfillmentRequest: { update: vi.fn(), create: vi.fn() },
  };
  const mockCancelOrder = vi.fn();
  const mockCreateOrder = vi.fn();
  return { mockPrisma, mockCancelOrder, mockCreateOrder };
});

vi.mock("~/db.server.js", () => ({ prisma: mockPrisma }));
vi.mock("~/sync/sync-logger.js", () => ({ syncLog: vi.fn() }));
vi.mock("~/sync/warehouse-client.js", () => ({
  getWarehouseClient: vi.fn().mockReturnValue({
    cancelOrder: mockCancelOrder,
    createOrder: mockCreateOrder,
  }),
}));
vi.mock("~/sync/order-orchestrator.js", () => ({
  transitionOrderStatus: vi.fn().mockResolvedValue(true),
}));

import { reassignOrder } from "~/sync/order-reassignment.js";
import { transitionOrderStatus } from "~/sync/order-orchestrator.js";

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "o1",
    shopifyOrderId: "gid://shopify/Order/1",
    shopifyOrderNumber: "#1001",
    processingStatus: "FULFILLMENT_SENT",
    assignedWarehouseId: "wh-us",
    assignedWarehouse: { id: "wh-us", name: "ShipBob US", provider: "SHIPBOB", region: "US" },
    destinationCountryCode: "US",
    customerEmail: "test@test.com",
    lineItems: [{ sku: "SKU-A", quantity: 1, productTitle: "Product A" }],
    fulfillmentRequests: [
      { id: "fr-1", externalRequestId: "ext-1", status: "SENT" },
    ],
    ...overrides,
  };
}

describe("order-reassignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(transitionOrderStatus).mockResolvedValue(true);
  });

  it("happy path: cancels at original, creates at new, transitions to FULFILLMENT_SENT", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(makeOrder());
    mockPrisma.warehouse.findUnique.mockResolvedValue({
      id: "wh-cn", name: "Fulfillmen China", isActive: true, provider: "FULFILLMEN", region: "CN",
    });
    mockCancelOrder.mockResolvedValue(undefined);
    mockCreateOrder.mockResolvedValue({ externalId: "new-ext-1" });
    mockPrisma.fulfillmentRequest.update.mockResolvedValue({});
    mockPrisma.fulfillmentRequest.create.mockResolvedValue({});

    await reassignOrder("o1", "wh-cn");

    expect(mockCancelOrder).toHaveBeenCalledWith("ext-1");
    expect(mockPrisma.fulfillmentRequest.update).toHaveBeenCalledWith({
      where: { id: "fr-1" },
      data: { status: "CANCELLED", cancelledAt: expect.any(Date) },
    });
    expect(mockCreateOrder).toHaveBeenCalled();
    expect(mockPrisma.fulfillmentRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "o1",
        warehouseId: "wh-cn",
        externalRequestId: "new-ext-1",
        status: "SENT",
      }),
    });
    expect(transitionOrderStatus).toHaveBeenCalledWith("o1", "REASSIGNING", "FULFILLMENT_SENT", expect.objectContaining({ assignedWarehouseId: "wh-cn" }));
  });

  it("compensation failure: cancel succeeds, create fails -> REASSIGNMENT_FAILED with manual intervention", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(makeOrder());
    mockPrisma.warehouse.findUnique.mockResolvedValue({
      id: "wh-cn", name: "Fulfillmen China", isActive: true, provider: "FULFILLMEN", region: "CN",
    });
    mockCancelOrder.mockResolvedValue(undefined);
    mockPrisma.fulfillmentRequest.update.mockResolvedValue({});
    mockCreateOrder.mockRejectedValue(new Error("Fulfillmen API error"));

    await expect(reassignOrder("o1", "wh-cn")).rejects.toThrow("partially failed");

    expect(transitionOrderStatus).toHaveBeenCalledWith(
      "o1",
      "REASSIGNING",
      "REASSIGNMENT_FAILED",
      expect.objectContaining({
        requiresManualIntervention: true,
        manualInterventionReason: expect.stringContaining("Fulfillmen API error"),
      }),
    );
  });

  it("cancel failure: order stays in original state, error thrown", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(makeOrder());
    mockPrisma.warehouse.findUnique.mockResolvedValue({
      id: "wh-cn", name: "Fulfillmen China", isActive: true, provider: "FULFILLMEN", region: "CN",
    });
    mockCancelOrder.mockRejectedValue(new Error("already shipped"));

    await expect(reassignOrder("o1", "wh-cn")).rejects.toThrow("Failed to cancel at original warehouse");

    // Should revert REASSIGNING -> FULFILLMENT_SENT
    expect(transitionOrderStatus).toHaveBeenCalledWith("o1", "REASSIGNING", "FULFILLMENT_SENT");
    // Should NOT have attempted create
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("rejects reassignment from FULFILLED status", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(makeOrder({ processingStatus: "FULFILLED" }));

    await expect(reassignOrder("o1", "wh-cn")).rejects.toThrow("Cannot reassign order in FULFILLED status");
  });

  it("rejects reassignment from CANCELLED status", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(makeOrder({ processingStatus: "CANCELLED" }));

    await expect(reassignOrder("o1", "wh-cn")).rejects.toThrow("Cannot reassign order in CANCELLED status");
  });

  it("rejects reassignment from PENDING status", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(makeOrder({ processingStatus: "PENDING" }));

    await expect(reassignOrder("o1", "wh-cn")).rejects.toThrow("Cannot reassign order in PENDING status");
  });

  it("rejects reassignment from REASSIGNMENT_FAILED status", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(makeOrder({ processingStatus: "REASSIGNMENT_FAILED" }));

    await expect(reassignOrder("o1", "wh-cn")).rejects.toThrow("Cannot reassign order in REASSIGNMENT_FAILED status");
  });

  it("handles concurrent reassignment via state machine guard", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(makeOrder());
    mockPrisma.warehouse.findUnique.mockResolvedValue({
      id: "wh-cn", name: "Fulfillmen China", isActive: true, provider: "FULFILLMEN", region: "CN",
    });
    vi.mocked(transitionOrderStatus).mockResolvedValueOnce(false);

    await expect(reassignOrder("o1", "wh-cn")).rejects.toThrow("concurrent modification");
  });

  it("rejects when target warehouse is inactive", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(makeOrder());
    mockPrisma.warehouse.findUnique.mockResolvedValue({
      id: "wh-cn", name: "Fulfillmen China", isActive: false, provider: "FULFILLMEN", region: "CN",
    });

    await expect(reassignOrder("o1", "wh-cn")).rejects.toThrow("not found or inactive");
  });

  it("rejects when order not found", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);

    await expect(reassignOrder("o1", "wh-cn")).rejects.toThrow("Order not found");
  });
});
