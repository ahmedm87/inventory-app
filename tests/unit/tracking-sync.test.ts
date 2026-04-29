import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockGetTracking, mockCreateFulfillment } = vi.hoisted(() => {
  const mockPrisma = {
    fulfillmentRequest: { findMany: vi.fn(), update: vi.fn() },
    trackingUpdate: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    order: { updateMany: vi.fn() },
  };
  const mockGetTracking = vi.fn();
  const mockCreateFulfillment = vi.fn();
  return { mockPrisma, mockGetTracking, mockCreateFulfillment };
});

vi.mock("~/db.server.js", () => ({ prisma: mockPrisma }));
vi.mock("~/config/app-config.js", () => ({
  getNamespacedConfig: () => ({
    core: { syncStaleTimeoutMinutes: 30 },
    order: { pollSchedule: "*/10 * * * *", pollEnabled: true, trackingSyncSchedule: "*/30 * * * *", trackingSyncEnabled: true, countryWarehouseMapping: "US:US" },
    fulfillmen: {},
    shipbob: null,
  }),
}));

vi.mock("~/sync/warehouse-client.js", () => ({
  getWarehouseClient: vi.fn().mockReturnValue({ getTracking: mockGetTracking }),
}));
vi.mock("~/sync/shopify-fulfillment.js", () => ({
  createShopifyFulfillment: (...args: unknown[]) => mockCreateFulfillment(...args),
}));
vi.mock("~/sync/order-orchestrator.js", () => ({
  transitionOrderStatus: vi.fn().mockResolvedValue(true),
}));
vi.mock("~/sync/sync-logger.js", () => ({ syncLog: vi.fn() }));

import { runTrackingSync } from "~/sync/tracking-sync.js";

describe("tracking-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pulls tracking, creates TrackingUpdate, updates fulfillment status, creates Shopify fulfillment, and marks order FULFILLED", async () => {
    mockPrisma.fulfillmentRequest.findMany.mockResolvedValue([
      {
        id: "fr-1",
        externalRequestId: "ext-1",
        status: "SENT",
        order: { id: "o1", shopifyOrderId: "gid://shopify/Order/1", processingStatus: "FULFILLMENT_SENT" },
        warehouse: { id: "wh-us", name: "ShipBob US", provider: "SHIPBOB", region: "US", shopifyLocationId: "gid://shopify/Location/1" },
      },
    ]);
    mockGetTracking.mockResolvedValue({
      trackingNumber: "1Z999",
      carrier: "UPS",
      trackingUrl: "https://ups.com/1Z999",
      shippedAt: "2026-04-28T10:00:00Z",
    });
    mockPrisma.trackingUpdate.findFirst.mockResolvedValue(null);
    mockPrisma.trackingUpdate.create.mockResolvedValue({});
    mockPrisma.fulfillmentRequest.update.mockResolvedValue({});
    mockCreateFulfillment.mockResolvedValue(undefined);

    await runTrackingSync("test");

    expect(mockGetTracking).toHaveBeenCalledWith("ext-1");
    expect(mockPrisma.trackingUpdate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fulfillmentRequestId: "fr-1",
        trackingNumber: "1Z999",
        carrier: "UPS",
      }),
    });
    expect(mockPrisma.fulfillmentRequest.update).toHaveBeenCalledWith({
      where: { id: "fr-1" },
      data: { status: "SHIPPED" },
    });
    expect(mockCreateFulfillment).toHaveBeenCalledWith({
      shopifyOrderId: "gid://shopify/Order/1",
      trackingNumber: "1Z999",
      carrier: "UPS",
      locationId: "gid://shopify/Location/1",
    });
  });

  it("skips when no tracking is available yet", async () => {
    mockPrisma.fulfillmentRequest.findMany.mockResolvedValue([
      {
        id: "fr-2",
        externalRequestId: "ext-2",
        status: "SENT",
        order: { id: "o2", shopifyOrderId: "gid://shopify/Order/2", processingStatus: "FULFILLMENT_SENT" },
        warehouse: { id: "wh-us", provider: "SHIPBOB", region: "US", shopifyLocationId: "gid://shopify/Location/1" },
      },
    ]);
    mockGetTracking.mockResolvedValue(null);

    await runTrackingSync("test");

    expect(mockPrisma.trackingUpdate.create).not.toHaveBeenCalled();
    expect(mockPrisma.fulfillmentRequest.update).not.toHaveBeenCalled();
  });

  it("skips already-fulfilled orders", async () => {
    mockPrisma.fulfillmentRequest.findMany.mockResolvedValue([
      {
        id: "fr-3",
        externalRequestId: "ext-3",
        status: "SENT",
        order: { id: "o3", shopifyOrderId: "gid://shopify/Order/3", processingStatus: "FULFILLED" },
        warehouse: { id: "wh-us", provider: "SHIPBOB", region: "US", shopifyLocationId: "gid://shopify/Location/1" },
      },
    ]);

    await runTrackingSync("test");

    expect(mockGetTracking).not.toHaveBeenCalled();
  });

  it("continues processing other requests when one warehouse API call fails", async () => {
    mockPrisma.fulfillmentRequest.findMany.mockResolvedValue([
      {
        id: "fr-fail",
        externalRequestId: "ext-fail",
        status: "SENT",
        order: { id: "o-fail", shopifyOrderId: "gid://shopify/Order/fail", processingStatus: "FULFILLMENT_SENT" },
        warehouse: { id: "wh-eu", provider: "SHIPBOB", region: "EU", shopifyLocationId: "gid://shopify/Location/2" },
      },
      {
        id: "fr-ok",
        externalRequestId: "ext-ok",
        status: "SENT",
        order: { id: "o-ok", shopifyOrderId: "gid://shopify/Order/ok", processingStatus: "FULFILLMENT_SENT" },
        warehouse: { id: "wh-us", provider: "SHIPBOB", region: "US", shopifyLocationId: "gid://shopify/Location/1" },
      },
    ]);

    let callCount = 0;
    mockGetTracking.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error("API timeout");
      return Promise.resolve({ trackingNumber: "1Z000", carrier: "FedEx", trackingUrl: null, shippedAt: null });
    });
    mockPrisma.trackingUpdate.findFirst.mockResolvedValue(null);
    mockPrisma.trackingUpdate.create.mockResolvedValue({});
    mockPrisma.fulfillmentRequest.update.mockResolvedValue({});
    mockCreateFulfillment.mockResolvedValue(undefined);

    await runTrackingSync("test");

    expect(mockPrisma.trackingUpdate.create).toHaveBeenCalledTimes(1);
  });

  it("updates existing tracking record instead of creating duplicate", async () => {
    mockPrisma.fulfillmentRequest.findMany.mockResolvedValue([
      {
        id: "fr-4",
        externalRequestId: "ext-4",
        status: "SENT",
        order: { id: "o4", shopifyOrderId: "gid://shopify/Order/4", processingStatus: "FULFILLMENT_SENT" },
        warehouse: { id: "wh-us", provider: "SHIPBOB", region: "US", shopifyLocationId: "gid://shopify/Location/1" },
      },
    ]);
    mockGetTracking.mockResolvedValue({
      trackingNumber: "1Z999-UPDATED",
      carrier: "UPS",
      trackingUrl: null,
      shippedAt: null,
    });
    mockPrisma.trackingUpdate.findFirst.mockResolvedValue({ id: "tu-existing" });
    mockPrisma.trackingUpdate.update.mockResolvedValue({});
    mockPrisma.fulfillmentRequest.update.mockResolvedValue({});
    mockCreateFulfillment.mockResolvedValue(undefined);

    await runTrackingSync("test");

    expect(mockPrisma.trackingUpdate.update).toHaveBeenCalledWith({
      where: { id: "tu-existing" },
      data: expect.objectContaining({ trackingNumber: "1Z999-UPDATED" }),
    });
    expect(mockPrisma.trackingUpdate.create).not.toHaveBeenCalled();
  });

  it("skips when order config is null (inventory-only mode)", async () => {
    vi.resetModules();
    vi.doMock("~/config/app-config.js", () => ({
      getNamespacedConfig: () => ({ core: {}, order: null, fulfillmen: {}, shipbob: null }),
    }));
    vi.doMock("~/db.server.js", () => ({ prisma: mockPrisma }));
    vi.doMock("~/sync/warehouse-client.js", () => ({ getWarehouseClient: vi.fn() }));
    vi.doMock("~/sync/shopify-fulfillment.js", () => ({ createShopifyFulfillment: vi.fn() }));
    vi.doMock("~/sync/order-orchestrator.js", () => ({ transitionOrderStatus: vi.fn() }));
    vi.doMock("~/sync/sync-logger.js", () => ({ syncLog: vi.fn() }));

    const mod = await import("~/sync/tracking-sync.js");
    await mod.runTrackingSync("test");

    expect(mockPrisma.fulfillmentRequest.findMany).not.toHaveBeenCalled();
  });
});
