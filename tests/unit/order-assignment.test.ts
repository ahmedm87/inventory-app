import { describe, it, expect, beforeEach, vi } from "vitest";
import { assignWarehouse } from "~/sync/order-assignment.js";
import type { Warehouse } from "@prisma/client";

vi.mock("~/sync/country-mapping.js", () => {
  const mapping = new Map([
    ["US", "US"],
    ["AU", "AU"],
    ["DE", "EU"],
    ["GB", "EU"],
  ]);
  return {
    getWarehouseForCountry: (code: string) =>
      mapping.get(code.toUpperCase()) ?? null,
    parseCountryMapping: vi.fn(),
    clearCountryMappingCache: vi.fn(),
  };
});

function makeWarehouse(overrides: Partial<Warehouse> & { id: string; region: string }): Warehouse {
  return {
    name: `Warehouse ${overrides.region}`,
    provider: "SHIPBOB",
    shopifyLocationId: `gid://shopify/Location/${overrides.id}`,
    isActive: true,
    isFallback: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Warehouse;
}

const warehouses: Warehouse[] = [
  makeWarehouse({ id: "wh-us", region: "US", name: "ShipBob US" }),
  makeWarehouse({ id: "wh-eu", region: "EU", name: "ShipBob EU" }),
  makeWarehouse({ id: "wh-au", region: "AU", name: "ShipBob AU" }),
  makeWarehouse({
    id: "wh-cn",
    region: "CN",
    name: "Fulfillmen China",
    provider: "FULFILLMEN",
    isFallback: true,
  } as Partial<Warehouse> & { id: string; region: string }),
];

describe("order-assignment", () => {
  it("assigns to country-mapped warehouse when all items in stock", () => {
    const result = assignWarehouse(
      { destinationCountryCode: "US", lineItems: [{ sku: "SKU-A", quantity: 2 }] },
      [{ warehouseId: "wh-us", sku: "SKU-A", quantity: 10 }],
      warehouses,
    );
    expect(result.warehouseId).toBe("wh-us");
    expect(result.reason).toContain("all items in stock");
  });

  it("falls back to Fulfillmen when item out of stock at mapped warehouse", () => {
    const result = assignWarehouse(
      { destinationCountryCode: "US", lineItems: [{ sku: "SKU-A", quantity: 10 }] },
      [{ warehouseId: "wh-us", sku: "SKU-A", quantity: 5 }],
      warehouses,
    );
    expect(result.warehouseId).toBe("wh-cn");
    expect(result.reason).toContain("out of stock");
  });

  it("falls back to Fulfillmen for unmapped country", () => {
    const result = assignWarehouse(
      { destinationCountryCode: "BR", lineItems: [{ sku: "SKU-A", quantity: 1 }] },
      [{ warehouseId: "wh-us", sku: "SKU-A", quantity: 100 }],
      warehouses,
    );
    expect(result.warehouseId).toBe("wh-cn");
    expect(result.reason).toContain("not mapped");
  });

  it("falls back when any item is out of stock (no splitting)", () => {
    const result = assignWarehouse(
      {
        destinationCountryCode: "US",
        lineItems: [
          { sku: "SKU-A", quantity: 1 },
          { sku: "SKU-B", quantity: 1 },
        ],
      },
      [
        { warehouseId: "wh-us", sku: "SKU-A", quantity: 10 },
        { warehouseId: "wh-us", sku: "SKU-B", quantity: 0 },
      ],
      warehouses,
    );
    expect(result.warehouseId).toBe("wh-cn");
    expect(result.reason).toContain("SKU-B");
  });

  it("falls back when SKU not found in stock levels", () => {
    const result = assignWarehouse(
      { destinationCountryCode: "US", lineItems: [{ sku: "UNKNOWN", quantity: 1 }] },
      [],
      warehouses,
    );
    expect(result.warehouseId).toBe("wh-cn");
    expect(result.reason).toContain("out of stock");
  });

  it("treats zero quantity as out of stock", () => {
    const result = assignWarehouse(
      { destinationCountryCode: "US", lineItems: [{ sku: "SKU-A", quantity: 1 }] },
      [{ warehouseId: "wh-us", sku: "SKU-A", quantity: 0 }],
      warehouses,
    );
    expect(result.warehouseId).toBe("wh-cn");
  });

  it("assigns to fallback for empty line items", () => {
    const result = assignWarehouse(
      { destinationCountryCode: "US", lineItems: [] },
      [],
      warehouses,
    );
    expect(result.warehouseId).toBe("wh-cn");
    expect(result.reason).toContain("no line items");
  });

  it("assigns to exact boundary quantity", () => {
    const result = assignWarehouse(
      { destinationCountryCode: "US", lineItems: [{ sku: "SKU-A", quantity: 5 }] },
      [{ warehouseId: "wh-us", sku: "SKU-A", quantity: 5 }],
      warehouses,
    );
    expect(result.warehouseId).toBe("wh-us");
  });

  it("falls back when mapped warehouse is inactive", () => {
    const inactiveWarehouses = warehouses.map((w) =>
      w.id === "wh-us" ? { ...w, isActive: false } : w,
    );
    const result = assignWarehouse(
      { destinationCountryCode: "US", lineItems: [{ sku: "SKU-A", quantity: 1 }] },
      [{ warehouseId: "wh-us", sku: "SKU-A", quantity: 100 }],
      inactiveWarehouses as Warehouse[],
    );
    expect(result.warehouseId).toBe("wh-cn");
    expect(result.reason).toContain("inactive");
  });
});
