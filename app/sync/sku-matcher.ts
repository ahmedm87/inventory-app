import type { ShopifyVariantInventory } from "~/sync/shopify-inventory.js";

export interface MatchResult {
  sku: string;
  warehouseQty: number;
  status: "matched" | "duplicate" | "unmatched";
  variants: ShopifyVariantInventory[];
}

export function matchSkus(
  fulfillmenInventory: Map<string, number>,
  shopifyVariants: Map<string, ShopifyVariantInventory[]>,
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const [sku, warehouseQty] of fulfillmenInventory) {
    const variants = shopifyVariants.get(sku);

    if (!variants || variants.length === 0) {
      results.push({ sku, warehouseQty, status: "unmatched", variants: [] });
      continue;
    }

    if (variants.length > 1) {
      results.push({ sku, warehouseQty, status: "duplicate", variants });
    } else {
      results.push({ sku, warehouseQty, status: "matched", variants });
    }
  }

  return results;
}
