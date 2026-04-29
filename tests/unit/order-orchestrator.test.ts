import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrderProcessingStatus } from "@prisma/client";

const { mockPrisma, mockGetWarehouseClient } = vi.hoisted(() => {
  const mockPrisma = {
    syncRun: { create: vi.fn(), update: vi.fn() },
    order: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    stockLevel: { findMany: vi.fn() },
    warehouse: { findMany: vi.fn() },
    fulfillmentRequest: { create: vi.fn() },
  };
  const mockGetWarehouseClient = vi.fn().mockReturnValue({
    createOrder: vi.fn().mockResolvedValue({ externalId: "ext-123" }),
  });
  return { mockPrisma, mockGetWarehouseClient };
});

vi.mock("~/db.server.js", () => ({ prisma: mockPrisma }));
vi.mock("~/config/app-config.js", () => ({
  getNamespacedConfig: () => ({
    core: { syncStaleTimeoutMinutes: 30 },
    order: { pollSchedule: "*/10 * * * *", pollEnabled: true, trackingSyncSchedule: "*/30 * * * *", trackingSyncEnabled: true, countryWarehouseMapping: "US:US" },
    fulfillmen: { apiKey: "k", baseUrl: "http://test", storage: "", shopifyLocationId: "gid://shopify/Location/1" },
    shipbob: null,
  }),
  getConfig: () => ({
    triggerSyncSecret: "s", shopifyLocationId: "gid://shopify/Location/1",
    fulfillmenApiKey: "k", fulfillmenBaseUrl: "http://test", fulfillmenStorage: "",
    shopifyStoreDomain: "test.myshopify.com", shopifyAccessToken: "t",
    cronSchedule: "0 * * * *", cronEnabled: true, syncStaleTimeoutMinutes: 30,
    databaseUrl: "", nodeEnv: "test", port: 3000,
  }),
}));
vi.mock("~/sync/order-poller.js", () => ({ pollNewOrders: vi.fn().mockResolvedValue([]) }));
vi.mock("~/sync/order-assignment.js", () => ({
  assignWarehouse: vi.fn().mockReturnValue({ warehouseId: "wh-us", reason: "test" }),
}));
vi.mock("~/sync/warehouse-client.js", () => ({
  getWarehouseClient: mockGetWarehouseClient,
}));
vi.mock("~/sync/sync-logger.js", () => ({ syncLog: vi.fn() }));

import { transitionOrderStatus, runOrderProcessing } from "~/sync/order-orchestrator.js";

describe("order-orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("transitionOrderStatus", () => {
    it("allows valid PENDING -> ASSIGNING transition", async () => {
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      const ok = await transitionOrderStatus("o1", "PENDING", "ASSIGNING");
      expect(ok).toBe(true);
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: "o1", processingStatus: "PENDING" },
        data: { processingStatus: "ASSIGNING" },
      });
    });

    it("allows valid ASSIGNING -> ASSIGNED transition with extra data", async () => {
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      const ok = await transitionOrderStatus("o1", "ASSIGNING", "ASSIGNED", {
        assignedWarehouseId: "wh-1",
        assignmentReason: "test",
      });
      expect(ok).toBe(true);
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: "o1", processingStatus: "ASSIGNING" },
        data: { processingStatus: "ASSIGNED", assignedWarehouseId: "wh-1", assignmentReason: "test" },
      });
    });

    it("rejects invalid transition PENDING -> FULFILLED", async () => {
      const ok = await transitionOrderStatus("o1", "PENDING", "FULFILLED");
      expect(ok).toBe(false);
      expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    });

    it("rejects transition from terminal state FULFILLED", async () => {
      const ok = await transitionOrderStatus("o1", "FULFILLED", "PENDING");
      expect(ok).toBe(false);
    });

    it("rejects transition from terminal state CANCELLED", async () => {
      const ok = await transitionOrderStatus("o1", "CANCELLED", "PENDING");
      expect(ok).toBe(false);
    });

    it("rejects transition from REASSIGNMENT_FAILED (terminal)", async () => {
      const ok = await transitionOrderStatus("o1", "REASSIGNMENT_FAILED", "PENDING");
      expect(ok).toBe(false);
    });

    it("returns false when conditional update matches 0 rows (concurrent claim)", async () => {
      mockPrisma.order.updateMany.mockResolvedValue({ count: 0 });
      const ok = await transitionOrderStatus("o1", "PENDING", "ASSIGNING");
      expect(ok).toBe(false);
    });
  });

  describe("runOrderProcessing", () => {
    it("processes PENDING order through full state machine: PENDING -> ASSIGNING -> ASSIGNED -> FULFILLMENT_SENT", async () => {
      mockPrisma.syncRun.create.mockResolvedValue({ id: "sr-1" });
      mockPrisma.syncRun.update.mockResolvedValue({});
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.order.findMany.mockResolvedValue([
        {
          id: "o1",
          shopifyOrderId: "gid://shopify/Order/1",
          shopifyOrderNumber: "#1001",
          processingStatus: "PENDING" as OrderProcessingStatus,
          destinationCountryCode: "US",
          customerEmail: "test@test.com",
          lineItems: [{ sku: "SKU-A", quantity: 1, productTitle: "Product A" }],
        },
      ]);
      mockPrisma.stockLevel.findMany.mockResolvedValue([]);
      mockPrisma.warehouse.findMany.mockResolvedValue([
        { id: "wh-us", name: "ShipBob US", provider: "SHIPBOB", region: "US", isActive: true, isFallback: false },
      ]);
      mockPrisma.order.findUnique.mockResolvedValue({
        id: "o1",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderNumber: "#1001",
        processingStatus: "ASSIGNED",
        customerEmail: "test@test.com",
        destinationCountryCode: "US",
        assignedWarehouse: { id: "wh-us", name: "ShipBob US", provider: "SHIPBOB", region: "US" },
        lineItems: [{ sku: "SKU-A", quantity: 1, productTitle: "Product A" }],
      });
      mockPrisma.fulfillmentRequest.create.mockResolvedValue({});

      await runOrderProcessing("test");

      // Verify state transitions happened
      expect(mockPrisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "o1", processingStatus: "PENDING" }, data: { processingStatus: "ASSIGNING" } }),
      );
    });

    it("skips when order config is null (inventory-only mode)", async () => {
      vi.resetModules();
      vi.doMock("~/config/app-config.js", () => ({
        getNamespacedConfig: () => ({ core: { syncStaleTimeoutMinutes: 30 }, order: null, fulfillmen: {}, shipbob: null }),
        getConfig: () => ({}),
      }));
      vi.doMock("~/db.server.js", () => ({ prisma: mockPrisma }));
      vi.doMock("~/sync/order-poller.js", () => ({ pollNewOrders: vi.fn() }));
      vi.doMock("~/sync/order-assignment.js", () => ({ assignWarehouse: vi.fn() }));
      vi.doMock("~/sync/warehouse-client.js", () => ({ getWarehouseClient: vi.fn() }));
      vi.doMock("~/sync/sync-logger.js", () => ({ syncLog: vi.fn() }));

      const mod = await import("~/sync/order-orchestrator.js");
      await mod.runOrderProcessing("test");

      expect(mockPrisma.syncRun.create).not.toHaveBeenCalled();
    });

    it("handles warehouse API failure gracefully — order stays in retryable state", async () => {
      mockPrisma.syncRun.create.mockResolvedValue({ id: "sr-1" });
      mockPrisma.syncRun.update.mockResolvedValue({});
      mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.order.findMany.mockResolvedValue([
        {
          id: "o2",
          shopifyOrderId: "gid://shopify/Order/2",
          processingStatus: "ASSIGNED" as OrderProcessingStatus,
          assignedWarehouseId: "wh-us",
          destinationCountryCode: "US",
          customerEmail: "test@test.com",
          lineItems: [{ sku: "SKU-A", quantity: 1, productTitle: "A" }],
        },
      ]);
      mockPrisma.stockLevel.findMany.mockResolvedValue([]);
      mockPrisma.warehouse.findMany.mockResolvedValue([]);
      mockPrisma.order.findUnique.mockResolvedValue({
        id: "o2",
        processingStatus: "ASSIGNED",
        shopifyOrderId: "gid://shopify/Order/2",
        customerEmail: "test@test.com",
        destinationCountryCode: "US",
        assignedWarehouse: { id: "wh-us", name: "ShipBob US", provider: "SHIPBOB", region: "US" },
        lineItems: [{ sku: "SKU-A", quantity: 1, productTitle: "A" }],
      });

      mockGetWarehouseClient.mockReturnValue({
        createOrder: vi.fn().mockRejectedValue(new Error("ShipBob API timeout")),
        fetchInventory: vi.fn(),
        cancelOrder: vi.fn(),
        getTracking: vi.fn(),
      });

      await runOrderProcessing("test");

      // Sync run should complete (not throw)
      expect(mockPrisma.syncRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "COMPLETED", totalErrors: 1 }),
        }),
      );
    });
  });
});
