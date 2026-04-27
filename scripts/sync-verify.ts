import { config as loadEnv } from "dotenv";
loadEnv();

import { createAdminApiClient } from "@shopify/admin-api-client";

const client = createAdminApiClient({
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN!,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN!,
  apiVersion: "2025-07",
});

const locationId = process.env.SHOPIFY_LOCATION_ID!;

const QUERY = `
  query GetInventory($locationId: ID!, $cursor: String) {
    productVariants(first: 50, after: $cursor) {
      edges {
        node {
          sku
          inventoryItem {
            tracked
            inventoryLevel(locationId: $locationId) {
              quantities(names: ["available"]) {
                quantity
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchInventorySnapshot(): Promise<Map<string, number>> {
  const inventory = new Map<string, number>();
  let cursor: string | null = null;

  while (true) {
    const res = await client.request(QUERY, {
      variables: { locationId, cursor },
    });

    const data = res.data as {
      productVariants: {
        edges: Array<{
          node: {
            sku: string;
            inventoryItem: {
              tracked: boolean;
              inventoryLevel: {
                quantities: Array<{ quantity: number }>;
              } | null;
            };
          };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    };

    for (const edge of data.productVariants.edges) {
      const { sku, inventoryItem } = edge.node;
      if (!sku || !inventoryItem.tracked) continue;
      const qty = inventoryItem.inventoryLevel?.quantities[0]?.quantity ?? 0;
      const existing = inventory.get(sku);
      if (existing === undefined) {
        inventory.set(sku, qty);
      }
    }

    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
  }

  return inventory;
}

const step = process.argv[2];

if (step === "before") {
  const snapshot = await fetchInventorySnapshot();
  const obj = Object.fromEntries(snapshot);
  const fs = await import("fs");
  fs.writeFileSync("/tmp/shopify-before.json", JSON.stringify(obj, null, 2));
  console.log(`Captured BEFORE snapshot: ${snapshot.size} SKUs`);
  const sample = [...snapshot.entries()].slice(0, 5);
  for (const [sku, qty] of sample) {
    console.log(`  ${sku}: ${qty}`);
  }
  console.log("  ...");
} else if (step === "after") {
  const snapshot = await fetchInventorySnapshot();
  const fs = await import("fs");
  const beforeRaw = fs.readFileSync("/tmp/shopify-before.json", "utf-8");
  const before = new Map<string, number>(Object.entries(JSON.parse(beforeRaw)));

  console.log(`Captured AFTER snapshot: ${snapshot.size} SKUs\n`);

  const changes: Array<{ sku: string; before: number; after: number }> = [];
  for (const [sku, afterQty] of snapshot) {
    const beforeQty = before.get(sku);
    if (beforeQty !== undefined && beforeQty !== afterQty) {
      changes.push({ sku, before: beforeQty, after: afterQty });
    }
  }

  if (changes.length === 0) {
    console.log("NO INVENTORY CHANGES DETECTED");
  } else {
    console.log(`${changes.length} SKU(s) changed:\n`);
    console.log("SKU".padEnd(30) + "BEFORE".padEnd(10) + "AFTER");
    console.log("-".repeat(50));
    for (const c of changes) {
      console.log(
        c.sku.padEnd(30) + String(c.before).padEnd(10) + String(c.after),
      );
    }
  }
} else {
  console.log("Usage: npx tsx scripts/sync-verify.ts [before|after]");
}
