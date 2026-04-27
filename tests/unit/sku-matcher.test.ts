import { describe, it, expect } from "vitest";
import { matchSkus } from "~/sync/sku-matcher.js";
import type { ShopifyVariantInventory } from "~/sync/shopify-inventory.js";

function makeVariant(
  sku: string,
  currentQuantity: number,
): ShopifyVariantInventory {
  return {
    variantId: `gid://shopify/ProductVariant/${sku}`,
    inventoryItemId: `gid://shopify/InventoryItem/${sku}`,
    sku,
    currentQuantity,
  };
}

describe("matchSkus", () => {
  it("matches SKUs exactly", () => {
    const fulfillmen = new Map([["SKU-A", 10]]);
    const shopify = new Map([["SKU-A", [makeVariant("SKU-A", 5)]]]);

    const results = matchSkus(fulfillmen, shopify);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("matched");
    expect(results[0].warehouseQty).toBe(10);
    expect(results[0].variants).toHaveLength(1);
  });

  it("reports unmatched SKUs", () => {
    const fulfillmen = new Map([["SKU-X", 5]]);
    const shopify = new Map<string, ShopifyVariantInventory[]>();

    const results = matchSkus(fulfillmen, shopify);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("unmatched");
    expect(results[0].variants).toHaveLength(0);
  });

  it("reports duplicate SKUs", () => {
    const fulfillmen = new Map([["SKU-D", 8]]);
    const shopify = new Map([
      ["SKU-D", [makeVariant("SKU-D", 3), makeVariant("SKU-D", 5)]],
    ]);

    const results = matchSkus(fulfillmen, shopify);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("duplicate");
    expect(results[0].variants).toHaveLength(2);
  });

  it("handles empty inputs", () => {
    const results = matchSkus(new Map(), new Map());
    expect(results).toHaveLength(0);
  });

  it("handles zero quantity", () => {
    const fulfillmen = new Map([["SKU-Z", 0]]);
    const shopify = new Map([["SKU-Z", [makeVariant("SKU-Z", 10)]]]);

    const results = matchSkus(fulfillmen, shopify);
    expect(results[0].warehouseQty).toBe(0);
    expect(results[0].status).toBe("matched");
  });

  it("handles multiple SKUs with mixed results", () => {
    const fulfillmen = new Map([
      ["A", 10],
      ["B", 20],
      ["C", 30],
    ]);
    const shopify = new Map([
      ["A", [makeVariant("A", 5)]],
      ["C", [makeVariant("C", 15), makeVariant("C", 20)]],
    ]);

    const results = matchSkus(fulfillmen, shopify);
    expect(results).toHaveLength(3);

    const a = results.find((r) => r.sku === "A")!;
    expect(a.status).toBe("matched");

    const b = results.find((r) => r.sku === "B")!;
    expect(b.status).toBe("unmatched");

    const c = results.find((r) => r.sku === "C")!;
    expect(c.status).toBe("duplicate");
  });
});
