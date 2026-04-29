import type { Warehouse } from "@prisma/client";
import { getWarehouseForCountry } from "./country-mapping.js";

export interface OrderForAssignment {
  destinationCountryCode: string;
  lineItems: Array<{ sku: string; quantity: number }>;
}

export interface StockLevelEntry {
  warehouseId: string;
  sku: string;
  quantity: number;
}

export interface AssignmentResult {
  warehouseId: string;
  reason: string;
}

export function assignWarehouse(
  order: OrderForAssignment,
  stockLevels: StockLevelEntry[],
  warehouses: Warehouse[],
): AssignmentResult {
  const fallback = warehouses.find((w) => w.isFallback);
  if (!fallback) {
    throw new Error("No fallback warehouse configured");
  }

  if (!order.lineItems || order.lineItems.length === 0) {
    return {
      warehouseId: fallback.id,
      reason: "Order has no line items, defaulting to fallback",
    };
  }

  const countryCode = order.destinationCountryCode?.toUpperCase();
  if (!countryCode) {
    return {
      warehouseId: fallback.id,
      reason: "No destination country code, defaulting to fallback",
    };
  }

  const mappedRegion = getWarehouseForCountry(countryCode);
  if (!mappedRegion) {
    return {
      warehouseId: fallback.id,
      reason: `Country ${countryCode} not mapped to any warehouse, defaulting to Fulfillmen China`,
    };
  }

  const targetWarehouse = warehouses.find(
    (w) => w.region === mappedRegion && w.isActive && !w.isFallback,
  );

  if (!targetWarehouse) {
    return {
      warehouseId: fallback.id,
      reason: `Country ${countryCode} mapped to ${mappedRegion} but warehouse is inactive or not found, defaulting to Fulfillmen China`,
    };
  }

  // Build stock lookup for the target warehouse
  const warehouseStock = new Map<string, number>();
  for (const sl of stockLevels) {
    if (sl.warehouseId === targetWarehouse.id) {
      warehouseStock.set(sl.sku, sl.quantity);
    }
  }

  // Check ALL items are in stock (no splitting)
  const outOfStockSkus: string[] = [];
  for (const item of order.lineItems) {
    const available = warehouseStock.get(item.sku) ?? 0;
    if (available < item.quantity) {
      outOfStockSkus.push(item.sku);
    }
  }

  if (outOfStockSkus.length > 0) {
    return {
      warehouseId: fallback.id,
      reason: `Country ${countryCode} mapped to ${targetWarehouse.name} but SKU(s) ${outOfStockSkus.join(", ")} out of stock, falling back to Fulfillmen China`,
    };
  }

  return {
    warehouseId: targetWarehouse.id,
    reason: `Country ${countryCode} mapped to ${targetWarehouse.name}, all items in stock`,
  };
}
