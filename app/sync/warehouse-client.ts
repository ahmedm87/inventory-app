import type { Warehouse } from "@prisma/client";
import {
  fetchShipBobInventory,
  createShipBobOrder,
  cancelShipBobOrder,
  getShipBobOrderTracking,
  getShipBobWarehouseId,
  type ShipBobOrderInput,
} from "./shipbob-client.js";
import {
  fetchInventoryByWarehouse,
  createFulfillmenOrder,
  cancelFulfillmenOrder,
  getFulfillmenTracking,
  type FulfillmenOrderInput,
} from "./fulfillmen-client.js";
import { getConfig } from "~/config/app-config.js";

// ─── Unified interfaces ───

export interface UnifiedOrderInput {
  referenceId: string;
  orderNumber: string;
  recipientName: string;
  recipientEmail: string;
  recipientPhone?: string;
  shippingAddress: {
    address1: string;
    address2?: string;
    city: string;
    state: string;
    country: string;
    zipCode: string;
  };
  lineItems: Array<{
    sku: string;
    quantity: number;
    name: string;
  }>;
}

export interface TrackingInfo {
  trackingNumber: string;
  carrier: string;
  trackingUrl: string | null;
  shippedAt: string | null;
}

export interface WarehouseClient {
  fetchInventory(): Promise<Map<string, number>>;
  createOrder(order: UnifiedOrderInput): Promise<{ externalId: string }>;
  cancelOrder(externalId: string): Promise<void>;
  getTracking(externalId: string): Promise<TrackingInfo | null>;
}

// ─── ShipBob adapter ───

class ShipBobWarehouseAdapter implements WarehouseClient {
  constructor(private region: "US" | "EU" | "AU") {}

  async fetchInventory(): Promise<Map<string, number>> {
    const channelId = getShipBobWarehouseId(this.region);
    return fetchShipBobInventory(channelId);
  }

  async createOrder(order: UnifiedOrderInput): Promise<{ externalId: string }> {
    const input: ShipBobOrderInput = {
      referenceId: order.referenceId,
      orderNumber: order.orderNumber,
      recipientName: order.recipientName,
      recipientEmail: order.recipientEmail,
      shippingAddress: order.shippingAddress,
      lineItems: order.lineItems,
    };
    const result = await createShipBobOrder(input);
    return { externalId: String(result.orderId) };
  }

  async cancelOrder(externalId: string): Promise<void> {
    await cancelShipBobOrder(externalId);
  }

  async getTracking(externalId: string): Promise<TrackingInfo | null> {
    return getShipBobOrderTracking(externalId);
  }
}

// ─── Fulfillmen adapter ───

class FulfillmenWarehouseAdapter implements WarehouseClient {
  async fetchInventory(): Promise<Map<string, number>> {
    const config = getConfig();
    const storageCodes = config.fulfillmenStorage
      ? config.fulfillmenStorage.split(",").map((c) => c.trim()).filter(Boolean)
      : [];

    if (storageCodes.length === 0) {
      return new Map();
    }

    const inventory = new Map<string, number>();
    for (const code of storageCodes) {
      const warehouseInventory = await fetchInventoryByWarehouse(code);
      for (const [sku, qty] of warehouseInventory) {
        const current = inventory.get(sku) || 0;
        inventory.set(sku, current + qty);
      }
    }
    return inventory;
  }

  async createOrder(order: UnifiedOrderInput): Promise<{ externalId: string }> {
    const input: FulfillmenOrderInput = {
      referenceId: order.referenceId,
      recipientName: order.recipientName,
      recipientPhone: order.recipientPhone,
      shippingAddress: order.shippingAddress,
      lineItems: order.lineItems,
    };
    const result = await createFulfillmenOrder(input);
    return { externalId: result.orderId };
  }

  async cancelOrder(externalId: string): Promise<void> {
    await cancelFulfillmenOrder(externalId);
  }

  async getTracking(externalId: string): Promise<TrackingInfo | null> {
    return getFulfillmenTracking(externalId);
  }
}

// ─── Factory ───

export function getWarehouseClient(warehouse: Warehouse): WarehouseClient {
  switch (warehouse.provider) {
    case "SHIPBOB": {
      const region = warehouse.region as "US" | "EU" | "AU";
      if (!["US", "EU", "AU"].includes(region)) {
        throw new Error(`Invalid ShipBob region: ${warehouse.region}`);
      }
      return new ShipBobWarehouseAdapter(region);
    }
    case "FULFILLMEN":
      return new FulfillmenWarehouseAdapter();
    default:
      throw new Error(`Unknown warehouse provider: ${warehouse.provider}`);
  }
}
