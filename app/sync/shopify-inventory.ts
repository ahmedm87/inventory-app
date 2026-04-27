import { getShopifyClient } from "~/shopify.server.js";
import { getConfig } from "~/config/app-config.js";

export interface ShopifyVariantInventory {
  variantId: string;
  inventoryItemId: string;
  sku: string;
  currentQuantity: number;
}

function log(level: string, message: string, extra?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      level,
      timestamp: new Date().toISOString(),
      message,
      ...extra,
    }),
  );
}

const GET_VARIANTS_QUERY = `
  query GetProductVariants($locationId: ID!, $cursor: String) {
    productVariants(first: 50, after: $cursor) {
      edges {
        node {
          id
          sku
          inventoryItem {
            id
            tracked
            inventoryLevel(locationId: $locationId) {
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const INVENTORY_SET_QUANTITIES_MUTATION = `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        createdAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function fetchAllShopifyVariants(): Promise<
  Map<string, ShopifyVariantInventory[]>
> {
  const client = getShopifyClient();
  const config = getConfig();
  const variantMap = new Map<string, ShopifyVariantInventory[]>();
  let cursor: string | null = null;
  let totalVariants = 0;

  while (true) {
    const response = await client.request(GET_VARIANTS_QUERY, {
      variables: {
        locationId: config.shopifyLocationId,
        cursor,
      },
    });

    const data = response.data as {
      productVariants: {
        edges: Array<{
          node: {
            id: string;
            sku: string;
            inventoryItem: {
              id: string;
              tracked: boolean;
              inventoryLevel: {
                quantities: Array<{ name: string; quantity: number }>;
              } | null;
            };
          };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    };

    for (const edge of data.productVariants.edges) {
      const node = edge.node;
      if (!node.sku || !node.inventoryItem.tracked) continue;

      const level = node.inventoryItem.inventoryLevel;
      if (!level) continue;
      const currentQuantity =
        level.quantities.find((q) => q.name === "available")?.quantity ?? 0;

      const variant: ShopifyVariantInventory = {
        variantId: node.id,
        inventoryItemId: node.inventoryItem.id,
        sku: node.sku,
        currentQuantity,
      };

      const existing = variantMap.get(node.sku) || [];
      existing.push(variant);
      variantMap.set(node.sku, existing);
      totalVariants++;
    }

    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
  }

  const duplicates = [...variantMap.entries()].filter(
    ([, v]) => v.length > 1,
  );
  if (duplicates.length > 0) {
    log("warn", `Found ${duplicates.length} SKU(s) with multiple variants`, {
      skus: duplicates.map(([sku, v]) => ({ sku, count: v.length })),
    });
  }

  log("info", `Fetched ${totalVariants} tracked Shopify variants across ${variantMap.size} SKUs`);
  return variantMap;
}

interface InventoryUpdate {
  inventoryItemId: string;
  quantity: number;
}

const BATCH_SIZE = 100;
const MIN_AVAILABLE_COST = 100;
const BACKOFF_BASE_MS = 1000;

export async function batchUpdateInventory(
  updates: InventoryUpdate[],
): Promise<{ succeeded: number; failed: Array<{ inventoryItemId: string; error: string }> }> {
  const client = getShopifyClient();
  const config = getConfig();
  let succeeded = 0;
  const failed: Array<{ inventoryItemId: string; error: string }> = [];

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    const quantities = batch.map((u) => ({
      inventoryItemId: u.inventoryItemId,
      locationId: config.shopifyLocationId,
      quantity: u.quantity,
    }));

    let retries = 0;
    while (retries < 3) {
      try {
        const response = await client.request(
          INVENTORY_SET_QUANTITIES_MUTATION,
          {
            variables: {
              input: {
                reason: "correction",
                name: "available",
                ignoreCompareQuantity: true,
                quantities,
              },
            },
          },
        );

        const data = response.data as {
          inventorySetQuantities: {
            userErrors: Array<{ field: string[]; message: string }>;
          };
        };

        const userErrors = data.inventorySetQuantities.userErrors;
        if (userErrors.length > 0) {
          for (const err of userErrors) {
            log("error", "Shopify inventory update user error", {
              field: err.field,
              message: err.message,
            });
          }
          for (const item of batch) {
            failed.push({
              inventoryItemId: item.inventoryItemId,
              error: userErrors.map((e) => e.message).join("; "),
            });
          }
        } else {
          succeeded += batch.length;
        }

        const extensions = (response as { extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number } } } }).extensions;
        const available =
          extensions?.cost?.throttleStatus?.currentlyAvailable;
        if (available != null && available < MIN_AVAILABLE_COST) {
          const waitMs = BACKOFF_BASE_MS * Math.pow(2, retries);
          log("info", `Rate limit approaching, backing off ${waitMs}ms`, {
            available,
          });
          await new Promise((r) => setTimeout(r, waitMs));
        }

        break;
      } catch (err: unknown) {
        const isRateLimit =
          err instanceof Error && err.message.includes("429");
        if (isRateLimit && retries < 2) {
          const waitMs = BACKOFF_BASE_MS * Math.pow(2, retries);
          log("warn", `Rate limited, retrying in ${waitMs}ms`, {
            retries,
          });
          await new Promise((r) => setTimeout(r, waitMs));
          retries++;
          continue;
        }
        for (const item of batch) {
          failed.push({
            inventoryItemId: item.inventoryItemId,
            error: String(err),
          });
        }
        break;
      }
    }
  }

  return { succeeded, failed };
}
